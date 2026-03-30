'use strict';

/**
 * Main Trading Bot
 *
 * Orchestrates strategy, exchange, risk management, AI filter,
 * webhook server (n8n integration), and Telegram notifications.
 * Runs via CLI — no web interface.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const GerchikLevels = require('../../var/strategies/gerchik-levels');
const BybitExchange = require('./bybit-exchange');
const RiskManager = require('./risk-manager');
const TelegramNotifier = require('./telegram-notifier');
const AIFilter = require('./ai-filter');
const WebhookServer = require('./webhook-server');
const TradeStore = require('./trade-store');
const logger = require('./logger');

const PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
// Герчик: 1D — уровни, 4H — подтверждение тренда, 5m — вход
const TF_LEVELS = '1d';     // таймфрейм для построения уровней
const TF_CONFIRM = '4h';    // таймфрейм для подтверждения тренда
const TF_ENTRY = '5m';      // таймфрейм для паттернов входа
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;
const VOLUME_THRESHOLD = parseFloat(process.env.VOLUME_THRESHOLD) || 1000000;
const AI_FILTER_ENABLED = process.env.AI_FILTER_ENABLED !== 'false';
const AI_MIN_CONFIDENCE = parseInt(process.env.AI_MIN_CONFIDENCE, 10) || 60;
const ORDER_SAFETY_TTL_MS = 30 * 60 * 1000; // страховочный таймаут 30 мин
const MAX_ORDER_ATTEMPTS = 2;                // макс попыток на один сетап
const BREAKEVEN_ENABLED = true;              // перенос SL в безубыток после 1R

class TradingBot {
  constructor() {
    this.strategy = new GerchikLevels();
    this.exchange = new BybitExchange();
    this.riskManager = new RiskManager({
      riskPct: parseFloat(process.env.RISK_PCT) || 1,
      minRR: parseFloat(process.env.MIN_RR) || 3,
      maxConcurrentPositions: parseInt(process.env.MAX_POSITIONS, 10) || 3,
    });
    this.notifier = new TelegramNotifier();
    this.aiFilter = new AIFilter();
    this.webhook = new WebhookServer(this);
    this.tradeStore = new TradeStore();
    this.running = false;
    this.paused = false;
    this.positions = new Map(); // pair -> position info (макс 1 на инструмент)
    this._pendingOrders = new Map(); // orderId -> { pair, position, signal, sizing, createdAt, attempts, level, direction }
    this._orderAttempts = new Map(); // pair -> количество попыток на текущий сетап
    this._dailyLevels = new Map();  // pair -> массив уровней с 1D
    this._lastLevelUpdate = 0;      // timestamp последнего обновления уровней
  }

  async start() {
    logger.info('=== Gerchik Levels Trading Bot starting ===');
    logger.info(`Пары: ${PAIRS.join(', ')}`);
    logger.info(`Таймфреймы: ${TF_LEVELS} (уровни), ${TF_CONFIRM} (тренд), ${TF_ENTRY} (вход)`);
    logger.info(`Интервал: ${POLL_INTERVAL_MS}мс`);
    logger.info(`Мин объём: ${VOLUME_THRESHOLD}`);
    logger.info(`AI фильтр: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ВКЛ' : 'ВЫКЛ'}`);
    logger.info(`n8n webhook: ${this.webhook.n8nWebhookUrl || 'не настроен'}`);

    this.running = true;

    // Start webhook server for n8n
    this.webhook.start();

    // Start Telegram command polling
    this.notifier.setBot(this);
    this.notifier.startPolling();

    // Sync open positions from Bybit
    await this._syncPositionsFromExchange();

    // Graceful shutdown
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    try {
      await this.notifier.sendMessage(
        '🤖 <b>Бот запущен (Герчик)</b>\n' +
        `Пары: ${PAIRS.join(', ')}\n` +
        `ТФ: ${TF_LEVELS} уровни | ${TF_CONFIRM} тренд | ${TF_ENTRY} вход\n` +
        `AI: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ВКЛ' : 'ВЫКЛ'}\n` +
        `Риск: ${this.riskManager.riskPct}% | Макс 1 позиция на инструмент`
      );
    } catch (e) {
      logger.warn(`Ошибка Telegram при старте: ${e.message}`);
    }

    // Notify n8n
    await this.webhook.pushToN8n('bot_started', {
      pairs: PAIRS,
      timeframes: [TF_LEVELS, TF_CONFIRM, TF_ENTRY],
      riskPct: this.riskManager.riskPct,
    });

    while (this.running) {
      if (!this.paused) {
        try {
          await this._tick();
        } catch (err) {
          logger.error(`Tick error: ${err.message}`);
          await this.notifier.notifyError(err);
          await this.webhook.pushToN8n('error', { message: err.message });
        }
      }

      if (this.running) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  }

  /**
   * Sync open positions from Bybit on startup so bot doesn't lose track after restart.
   */
  async _syncPositionsFromExchange() {
    try {
      const openPositions = await this.exchange.fetchOpenPositions();
      logger.info(`Sync: found ${openPositions.length} open positions on exchange`);

      if (openPositions.length === 0) {
        return;
      }

      for (const pos of openPositions) {
        // Log raw position data for debugging
        logger.info(`Sync raw: symbol=${pos.symbol} side=${pos.side} contracts=${pos.contracts} entryPrice=${pos.entryPrice}`);

        // pos.symbol is like 'BTC/USDT:USDT', extract base pair
        let pair = pos.symbol ? pos.symbol.replace(':USDT', '') : null;
        // Fallback: try info.symbol (e.g. 'BTCUSDT' -> 'BTC/USDT')
        if (!pair && pos.info?.symbol) {
          const raw = pos.info.symbol;
          const base = raw.replace('USDT', '');
          pair = `${base}/USDT`;
        }

        if (!pair || !PAIRS.includes(pair)) {
          logger.warn(`Sync: skipping unrecognized pair ${pair || pos.symbol}`);
          continue;
        }

        const side = pos.side === 'long' ? 'long' : 'short';
        // Use absolute value — shorts have negative contracts
        const size = Math.abs(pos.contracts || parseFloat(pos.info?.size || '0'));
        const posKey = pair; // макс 1 позиция на инструмент

        const entryPrice = pos.entryPrice || parseFloat(pos.info?.avgPrice || '0');
        const stopLossPrice = pos.stopLossPrice || parseFloat(pos.info?.stopLoss || '0');
        const takeProfitPrice = pos.takeProfitPrice || parseFloat(pos.info?.takeProfit || '0');

        // Определяем, был ли SL перенесён в безубыток
        const isBreakeven = stopLossPrice > 0 && Math.abs(stopLossPrice - entryPrice) / entryPrice < 0.001;

        const position = {
          id: posKey,
          side,
          entry: entryPrice,
          stopLoss: stopLossPrice,
          takeProfit: takeProfitPrice,
          _originalSL: stopLossPrice, // при синхронизации оригинальный SL неизвестен
          size,
          orderId: 'synced',
          entryReason: 'Синхронизирована с биржи после рестарта',
          openedAt: pos.timestamp ? new Date(pos.timestamp).toISOString() : new Date().toISOString(),
          _breakevenMoved: isBreakeven,
        };

        this.positions.set(posKey, position);
        this.riskManager.addPosition(position);
        logger.info(`Synced position: ${side} ${pair} size=${size} entry=${position.entry}`);
      }

      logger.info(`Synced ${this.positions.size} positions from exchange`);

      if (this.positions.size > 0) {
        try {
          await this.notifier.sendMessage(
            `🔄 <b>Синхронизация</b>\nНайдено позиций на бирже: ${this.positions.size}`
          );
        } catch (e) { /* ignore */ }
      }
    } catch (err) {
      logger.error(`Failed to sync positions: ${err.message}`);
    }
  }

  /**
   * Проверка лимитных ордеров по методологии Герчика.
   *
   * Ордер живёт пока жив уровень. Отмена по 4 условиям:
   * 1. Пробой уровня — закрытие 5m свечи телом за уровнем (главный триггер)
   * 2. Противоположный сигнал — на 5m появился паттерн в другую сторону
   * 3. Смена контекста на 4H — новая свеча изменила тренд
   * 4. Страховочный таймаут — 30 мин (6 свечей 5m)
   *
   * Частичное исполнение:
   * - < 50% — закрываем рыночным, сделка не ведётся
   * - >= 50% — торгуем исполненным объёмом, остаток отменяем
   */
  async _checkPendingOrders() {
    for (const [orderId, pending] of [...this._pendingOrders]) {
      try {
        const order = await this.exchange.fetchOrder(orderId, pending.pair);

        // === ИСПОЛНЕН ===
        if (order.status === 'closed') {
          this._pendingOrders.delete(orderId);
          this.positions.set(pending.pair, pending.position);
          this.riskManager.addPosition(pending.position);

          // Устанавливаем SL (Stop Market) и TP (Limit) через Bybit API
          await this._setPositionStopLossAndTakeProfit(pending.pair, pending.position);

          await this.notifier.notifyTrade({
            ...pending.signal,
            positionSize: pending.sizing.size,
            riskAmount: pending.sizing.riskAmount,
          });
          await this.webhook.pushToN8n('trade_opened', pending.position);
          logger.info(`Ордер исполнен: ${orderId} — ${pending.pair}`);
          continue;
        }

        // === ЧАСТИЧНОЕ ИСПОЛНЕНИЕ ===
        if (order.filled > 0 && order.remaining > 0) {
          const fillRatio = order.filled / (order.filled + order.remaining);
          if (fillRatio >= 0.5) {
            // >= 50% — торгуем исполненным объёмом, остаток отменяем
            this._pendingOrders.delete(orderId);
            await this.exchange.cancelOrder(orderId, pending.pair);

            pending.position.size = order.filled;
            this.positions.set(pending.pair, pending.position);
            this.riskManager.addPosition(pending.position);

            // SL/TP на исполненный объём
            await this._setPositionStopLossAndTakeProfit(pending.pair, pending.position);

            pending.sizing.size = order.filled;
            await this.notifier.notifyTrade({
              ...pending.signal,
              positionSize: order.filled,
              riskAmount: pending.sizing.riskAmount,
            });
            logger.info(`Частичное исполнение ${(fillRatio * 100).toFixed(0)}%: ${orderId} — торгуем ${order.filled}`);
            continue;
          }
          // < 50% — будет закрыт ниже при отмене
        }

        // === УЖЕ ОТМЕНЁН (PostOnly отклонён биржей или вручную) ===
        if (order.status === 'canceled') {
          this._pendingOrders.delete(orderId);

          // Увеличиваем счётчик попыток
          if (pending.attemptKey) {
            const attempts = (this._orderAttempts.get(pending.attemptKey) || 0) + 1;
            this._orderAttempts.set(pending.attemptKey, attempts);
            logger.info(`Ордер отменён биржей (PostOnly?): ${orderId}, попытка ${attempts}`);
          } else {
            logger.info(`Ордер отменён: ${orderId}`);
          }
          continue;
        }

        // === ПРОВЕРКА 4 УСЛОВИЙ ОТМЕНЫ ПО ГЕРЧИКУ ===
        let cancelReason = null;

        // Получаем последние 5m свечи (нужны для условий 1 и 2)
        let candles5m = null;
        try {
          candles5m = await this.exchange.fetchCandles(pending.pair, TF_ENTRY, 10);
        } catch (e) {
          logger.warn(`Ошибка получения 5m свечей для ${pending.pair}: ${e.message}`);
        }

        // 1. ПРОБОЙ УРОВНЯ — главный триггер
        //    Свеча 5m закрылась телом за уровнем → уровень сломан → немедленная отмена
        if (!cancelReason && pending.level && pending.direction && candles5m && candles5m.length > 0) {
          const lastCandle = candles5m[candles5m.length - 1];
          if (this.strategy.isLevelBroken(lastCandle, pending.level, pending.direction)) {
            cancelReason = `Пробой уровня ${pending.level.price.toFixed(2)} (5m свеча закрылась за уровнем) — уровень сломан`;
          }
        }

        // 2. ПРОТИВОПОЛОЖНЫЙ СИГНАЛ — на 5m появился паттерн входа в другую сторону
        //    Текущий ордер теряет смысл
        if (!cancelReason && pending.level && pending.direction && candles5m && candles5m.length >= 6) {
          const oppositeDir = pending.direction === 'long' ? 'short' : 'long';
          const dailyData = this._dailyLevels.get(pending.pair);
          const dailyLevels = dailyData ? dailyData.levels : [];

          const oppositeSignal = this.strategy.findEntryPattern(
            candles5m, pending.level, oppositeDir, dailyLevels
          );
          if (oppositeSignal) {
            cancelReason = `Противоположный сигнал: ${oppositeSignal.typeRu} ${oppositeDir.toUpperCase()} на 5m`;
          }
        }

        // 3. СМЕНА КОНТЕКСТА НА 4H — новая свеча изменила тренд
        //    Если при размещении ордера тренд совпадал, а теперь нет
        if (!cancelReason && pending.direction) {
          try {
            const candles4H = await this.exchange.fetchCandles(pending.pair, TF_CONFIRM, 25);
            if (candles4H && candles4H.length >= 20) {
              const currentTrend = this.strategy.detectTrend4H(candles4H);
              const trendConflict =
                (pending.direction === 'long' && currentTrend === 'down') ||
                (pending.direction === 'short' && currentTrend === 'up');

              if (trendConflict) {
                cancelReason = `Смена контекста 4H: тренд стал ${currentTrend}, конфликтует с ${pending.direction}`;
              }
            }
          } catch (e) {
            logger.warn(`Ошибка проверки 4H контекста для ${pending.pair}: ${e.message}`);
          }
        }

        // 4. СТРАХОВОЧНЫЙ ТАЙМАУТ — 30 минут (6 свечей 5m)
        //    Если ничего не сработало и ордер не исполнился — цена ушла в рейндж
        if (!cancelReason && Date.now() - pending.createdAt > ORDER_SAFETY_TTL_MS) {
          cancelReason = `Страховочный таймаут 30 мин — цена ушла в рейндж, сетап потерял актуальность`;
        }

        // === ОТМЕНА ===
        if (cancelReason) {
          this._pendingOrders.delete(orderId);

          // Частично исполнен < 50%? Закрываем рыночным, сделка не ведётся
          if (order.filled > 0) {
            const fillRatio = order.filled / (order.filled + order.remaining);
            if (fillRatio < 0.5) {
              try {
                await this.exchange.cancelOrder(orderId, pending.pair);
                await this.exchange.closePosition(pending.pair, pending.direction, order.filled);

                logger.info(
                  `ЧАСТИЧНОЕ ИСПОЛНЕНИЕ <50% ${pending.pair}: ` +
                  `исполнено ${order.filled} из ${order.filled + order.remaining} (${(fillRatio * 100).toFixed(0)}%) | ` +
                  `закрыто рыночным, сделка не ведётся | причина отмены: ${cancelReason}`
                );

                await this.notifier.sendMessage(
                  `⚠️ <b>Частичное исполнение <50%</b>\n` +
                  `${pending.pair} — исполнено ${(fillRatio * 100).toFixed(0)}% (${order.filled})\n` +
                  `Позиция закрыта рыночным ордером, сделка не ведётся\n` +
                  `Причина отмены: ${cancelReason}`
                );
              } catch (e) {
                logger.error(`Ошибка закрытия частичной позиции ${pending.pair}: ${e.message}`);
              }
            }
          } else {
            await this.exchange.cancelOrder(orderId, pending.pair);
          }

          // Счётчик попыток
          if (pending.attemptKey) {
            const attempts = (this._orderAttempts.get(pending.attemptKey) || 0) + 1;
            this._orderAttempts.set(pending.attemptKey, attempts);
          }

          const sideRu = pending.direction === 'long' ? 'ЛОНГ' : 'ШОРТ';
          await this.notifier.sendMessage(
            `⏰ <b>Ордер отменён</b>\n` +
            `${pending.direction === 'long' ? '🟢' : '🔴'} ${sideRu} ${pending.pair}\n` +
            `Уровень: <code>${pending.level ? pending.level.price.toFixed(2) : '?'}</code>\n\n` +
            `Причина: ${cancelReason}`
          );
          logger.info(`Ордер ${orderId} отменён: ${cancelReason}`);
        }
      } catch (err) {
        logger.error(`_checkPendingOrders ошибка ${orderId}: ${err.message}`);
        if (err.message.includes('not found') || err.message.includes('does not exist')) {
          this._pendingOrders.delete(orderId);
        }
      }
    }
  }

  /**
   * Детекция позиций, закрытых биржей (SL/TP на стороне Bybit).
   *
   * Определяет причину закрытия: стоп, тейк, или безубыток.
   * Сохраняет сделку в БД, отправляет уведомление, запускает AI анализ.
   */
  async _detectClosedPositions() {
    if (this.positions.size === 0) return;

    try {
      const exchangePositions = await this.exchange.fetchOpenPositions();
      const exchangePairs = new Set(
        exchangePositions.map((p) => p.symbol ? p.symbol.replace(':USDT', '') : '')
      );

      for (const [posKey, pos] of [...this.positions]) {
        const pair = posKey.split(':')[0];
        if (exchangePairs.has(pair)) continue;

        // Позиция исчезла с биржи — закрыта по SL/TP
        this.positions.delete(posKey);
        this.riskManager.removePosition(posKey);

        // Определяем причину закрытия и PnL
        let closeReason = 'Закрыта на бирже';
        let closeType = 'unknown'; // 'tp', 'sl', 'breakeven', 'unknown'
        let exitPrice = 0;
        let pnlEstimate = 0;

        try {
          const ticker = await this.exchange.fetchTicker(pair);
          exitPrice = ticker.last || ticker.close || 0;

          if (pos.side === 'long') {
            pnlEstimate = (exitPrice - pos.entry) * pos.size;
          } else {
            pnlEstimate = (pos.entry - exitPrice) * pos.size;
          }

          // Определяем тип закрытия
          if (pos.side === 'long') {
            if (pos.takeProfit && exitPrice >= pos.takeProfit * 0.998) {
              closeReason = `Закрыта по Take Profit (${pos.takeProfit})`;
              closeType = 'tp';
            } else if (pos._breakevenMoved && pos.stopLoss === pos.entry && exitPrice <= pos.entry * 1.002) {
              closeReason = `Закрыта по безубытку (SL = вход ${pos.entry})`;
              closeType = 'breakeven';
            } else if (pos.stopLoss && exitPrice <= pos.stopLoss * 1.002) {
              closeReason = `Закрыта по Stop Loss (${pos.stopLoss})`;
              closeType = 'sl';
            }
          } else {
            if (pos.takeProfit && exitPrice <= pos.takeProfit * 1.002) {
              closeReason = `Закрыта по Take Profit (${pos.takeProfit})`;
              closeType = 'tp';
            } else if (pos._breakevenMoved && pos.stopLoss === pos.entry && exitPrice >= pos.entry * 0.998) {
              closeReason = `Закрыта по безубытку (SL = вход ${pos.entry})`;
              closeType = 'breakeven';
            } else if (pos.stopLoss && exitPrice >= pos.stopLoss * 0.998) {
              closeReason = `Закрыта по Stop Loss (${pos.stopLoss})`;
              closeType = 'sl';
            }
          }
        } catch (e) {
          logger.warn(`_detectClosedPositions: ошибка получения цены ${pair}: ${e.message}`);
        }

        // Длительность позиции
        const durationMs = pos.openedAt ? Date.now() - new Date(pos.openedAt).getTime() : 0;
        const durationMin = Math.round(durationMs / 60000);
        const durationStr = durationMin < 60
          ? `${durationMin}м`
          : `${Math.floor(durationMin / 60)}ч ${durationMin % 60}м`;

        // R:R реализованный
        const risk = Math.abs(pos.entry - (pos._originalSL || pos.stopLoss));
        const realizedRR = risk > 0 ? (pnlEstimate / (risk * pos.size)).toFixed(1) : '?';

        // === ЛОГИРОВАНИЕ (Раздел 10 Герчика) ===
        const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const closeIcon = closeType === 'tp' ? '✅' : closeType === 'breakeven' ? '🔒' : closeType === 'sl' ? '🛑' : '⬜';

        logger.info(
          `СДЕЛКА ЗАКРЫТА ${pair} ${sideRu} | ` +
          `результат: ${closeType} | PnL: ${pnlEstimate.toFixed(2)} USDT (${realizedRR}R) | ` +
          `вход: ${pos.entry} | выход: ${exitPrice} | ` +
          `SL: ${pos.stopLoss} | TP: ${pos.takeProfit} | ` +
          `размер: ${pos.size} | длительность: ${durationStr} | ` +
          `безубыток: ${pos._breakevenMoved ? 'да' : 'нет'} | ` +
          `причина входа: ${pos.entryReason || '—'} | ` +
          `причина закрытия: ${closeReason}`
        );

        // === УВЕДОМЛЕНИЕ В TELEGRAM ===
        const sideIcon = pos.side === 'long' ? '🟢' : '🔴';
        const pnlIcon = pnlEstimate > 0 ? '💰' : pnlEstimate < 0 ? '💸' : '🔒';

        const msg =
          `${closeIcon} <b>Позиция закрыта</b>\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `${sideIcon} <b>${sideRu}</b> ${pair}\n\n` +
          `Вход: <code>${pos.entry}</code>\n` +
          `Выход: <code>${exitPrice || '?'}</code>\n` +
          `SL: <code>${pos.stopLoss}</code> | TP: <code>${pos.takeProfit}</code>\n` +
          `Размер: <code>${pos.size}</code>\n\n` +
          `${pnlIcon} PnL: <code>${pnlEstimate.toFixed(2)} USDT (${realizedRR}R)</code>\n` +
          `Длительность: ${durationStr}\n` +
          `Безубыток: ${pos._breakevenMoved ? 'Да (SL был перенесён)' : 'Нет'}\n\n` +
          `Причина: ${closeReason}`;

        await this.notifier.sendMessage(msg);

        // === СОХРАНЕНИЕ В БД ===
        const closedAt = new Date().toISOString();
        const trade = {
          pair,
          timeframe: TF_ENTRY,
          side: pos.side,
          entry: pos.entry,
          exitPrice: exitPrice || 0,
          stopLoss: pos.stopLoss,
          takeProfit: pos.takeProfit,
          originalSL: pos._originalSL || pos.stopLoss,
          size: pos.size,
          pnl: parseFloat(pnlEstimate.toFixed(2)),
          realizedRR: realizedRR,
          closeType: closeType,
          breakevenMoved: !!pos._breakevenMoved,
          levelPrice: pos._levelPrice || null,
          levelClassification: pos._levelClassification || null,
          levelStrength: pos._levelStrength || null,
          entryPattern: pos._entryPattern || null,
          entryReason: pos.entryReason || '',
          exitReason: closeReason,
          duration: durationStr,
          openedAt: pos.openedAt || null,
          closedAt,
        };
        this.tradeStore.saveTrade(trade);

        // === AI АНАЛИЗ ПОСЛЕ ЗАКРЫТИЯ ===
        if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
          try {
            const analysis = await this.aiFilter.analyzeTrade(trade);
            if (analysis) {
              this.tradeStore.saveAnalysis(closedAt, analysis);
              await this.notifier.sendMessage(
                `📊 <b>AI анализ сделки</b> ${pair}\n` +
                `Оценка: ${analysis.grade || '—'}\n` +
                `Уроки: ${(analysis.lessons || []).join('; ') || '—'}\n` +
                `Совет: ${analysis.improvement || '—'}`
              );
            }
          } catch (aiErr) {
            logger.warn(`AI анализ сделки ${pair}: ${aiErr.message}`);
          }
        }

        await this.webhook.pushToN8n('trade_closed', {
          pair, side: pos.side, closeType, reason: closeReason,
          pnl: pnlEstimate, realizedRR, exitPrice, duration: durationStr,
          breakevenMoved: !!pos._breakevenMoved,
        });
      }
    } catch (err) {
      logger.error(`_detectClosedPositions ошибка: ${err.message}`);
    }
  }

  stop() {
    logger.info('Bot stopping...');
    this.running = false;
    this.notifier.stopPolling();
    this.webhook.stop();
    this.tradeStore.close();
    this.notifier.sendMessage('🛑 <b>Бот остановлен</b>').catch(() => {});
    this.webhook.pushToN8n('bot_stopped', {}).catch(() => {});
  }

  async _tick() {
    const balance = await this.exchange.fetchBalance();
    logger.info(`Баланс: ${balance.free} USDT свободно (всего: ${balance.total})`);

    // Проверка лимитных ордеров (исполнение / отмена по условиям Герчика)
    await this._checkPendingOrders();

    // Детекция закрытых позиций на бирже (SL/TP)
    await this._detectClosedPositions();

    // Перенос SL в безубыток после 1R
    if (BREAKEVEN_ENABLED) {
      await this._checkBreakeven();
    }

    // Обновление дневных уровней (раз в 4 часа — не чаще)
    const now = Date.now();
    if (now - this._lastLevelUpdate > 4 * 60 * 60 * 1000) {
      await this._updateDailyLevels();
      this._lastLevelUpdate = now;
    }

    // Мультитаймфреймовый анализ по каждой паре
    for (const pair of PAIRS) {
      try {
        await this._processPairGerchik(pair, balance);
      } catch (err) {
        logger.error(`Ошибка ${pair}: ${err.message}`);
      }
    }

    await this.webhook.pushToN8n('tick_complete', {
      balance,
      openPositions: this.positions.size,
      timestamp: new Date().toISOString(),
    });
  }

  /**
   * Обновить дневные уровни для всех пар.
   */
  async _updateDailyLevels() {
    for (const pair of PAIRS) {
      try {
        const dailyCandles = await this.exchange.fetchCandles(pair, TF_LEVELS, 120);
        if (!dailyCandles || dailyCandles.length < 30) {
          logger.warn(`${pair}: недостаточно дневных свечей (${dailyCandles?.length || 0})`);
          continue;
        }

        const levels = this.strategy.findLevels(dailyCandles);
        this._dailyLevels.set(pair, { levels, candles: dailyCandles });

        // Логирование найденных уровней
        for (const l of levels) {
          logger.info(
            `${pair} уровень: ${l.price.toFixed(2)} | ${l.classification} | ` +
            `сила: ${l.strength} | касаний: ${l.touches} | ` +
            `тип: ${l.type}${l.isMirror ? ' (зеркальный)' : ''}${l.hasFalseBreakout ? ' (лож.пробой)' : ''}`
          );
        }

        logger.info(`${pair}: найдено ${levels.length} уровней на 1D (из ${dailyCandles.length} свечей)`);
      } catch (err) {
        logger.error(`${pair}: ошибка обновления уровней: ${err.message}`);
      }
    }

    // Итого по всем парам
    let totalLevels = 0;
    for (const [pair, data] of this._dailyLevels) {
      totalLevels += data.levels.length;
    }
    logger.info(`Обновление уровней завершено: ${totalLevels} уровней по ${this._dailyLevels.size} парам`);
  }

  /**
   * Мультитаймфреймовый анализ одной пары по методологии Герчика.
   * 1D → уровни, 4H → тренд и поведение, 5m → паттерн входа.
   */
  async _processPairGerchik(pair, balance) {
    // 1. Проверяем: есть ли уже позиция по этому инструменту (макс 1)
    if (this.positions.has(pair)) {
      logger.debug(`${pair}: уже есть открытая позиция — пропуск`);
      return;
    }

    // 2. Проверяем: есть ли активный лимитный ордер по этой паре
    for (const [, pending] of this._pendingOrders) {
      if (pending.pair === pair) {
        logger.debug(`${pair}: есть ожидающий ордер — пропуск`);
        return;
      }
    }

    // 3. Получаем дневные уровни (кэшированные)
    const dailyData = this._dailyLevels.get(pair);
    if (!dailyData || !dailyData.levels || dailyData.levels.length === 0) {
      logger.debug(`${pair}: нет уровней на 1D — пропуск`);
      return;
    }

    const { levels: dailyLevels, candles: dailyCandles } = dailyData;

    // 4. Фильтр объёма
    const ticker = await this.exchange.fetchTicker(pair);
    if (ticker.quoteVolume && ticker.quoteVolume < VOLUME_THRESHOLD) {
      logger.debug(`${pair}: объём ${ticker.quoteVolume} ниже порога ${VOLUME_THRESHOLD}`);
      return;
    }

    // 5. Получаем 4H свечи для подтверждения тренда
    const candles4H = await this.exchange.fetchCandles(pair, TF_CONFIRM, 50);
    if (!candles4H || candles4H.length < 20) {
      logger.debug(`${pair}: недостаточно 4H свечей`);
      return;
    }

    // 6. Получаем 5m свечи для поиска паттерна входа
    const candles5m = await this.exchange.fetchCandles(pair, TF_ENTRY, 50);
    if (!candles5m || candles5m.length < 10) {
      logger.debug(`${pair}: недостаточно 5m свечей`);
      return;
    }

    const currentPrice = candles5m[candles5m.length - 1].close;

    // Логируем ближайший уровень для наглядности
    if (dailyLevels.length > 0) {
      const nearest = dailyLevels.reduce((best, l) =>
        Math.abs(l.price - currentPrice) < Math.abs(best.price - currentPrice) ? l : best
      );
      const nearDist = ((currentPrice - nearest.price) / nearest.price * 100).toFixed(2);
      logger.info(`${pair}: цена ${currentPrice.toFixed(2)}, ближайший уровень ${nearest.price.toFixed(2)} (${nearDist}%), всего уровней: ${dailyLevels.length}`);
    }

    // 7. Ищем ближайший активный уровень к текущей цене
    for (const level of dailyLevels) {
      // Фильтр: изношенный уровень (4+ касаний за последние дни)
      if (this.strategy.isLevelWornOut(level, dailyCandles.slice(-10))) {
        logger.debug(`${pair}: уровень ${level.price.toFixed(2)} изношен (4+ касаний) — пропуск`);
        continue;
      }

      // Определяем направление: цена выше уровня — лонг (отскок от поддержки),
      // цена ниже — шорт (отскок от сопротивления)
      let direction = null;
      const distPct = (currentPrice - level.price) / level.price;

      if (level.type === 'support' || level.type === 'dual') {
        if (distPct >= -0.005 && distPct <= 0.01) direction = 'long';
      }
      if (level.type === 'resistance' || level.type === 'dual') {
        if (distPct <= 0.005 && distPct >= -0.01) direction = 'short';
      }

      if (!direction) continue;

      // 8. Проверка тренда на 4H
      const confirmation = this.strategy.check4HConfirmation(candles4H, direction);
      if (!confirmation.confirmed && level.strength < 6) {
        // Слабый уровень + противоречие на 4H — пропуск
        logger.info(`${pair}: 4H тренд противоречит ${direction} при слабом уровне ${level.price.toFixed(2)} — пропуск`);
        continue;
      }

      // 9. Анализ поведения на 4H при подходе к уровню
      const approach = this.strategy.analyze4HApproach(candles4H, level);
      logger.debug(`${pair}: подход к уровню на 4H: ${approach.approach}`);

      // 10. Поиск паттерна входа на 5m
      const signal = this.strategy.findEntryPattern(candles5m, level, direction, dailyLevels);

      if (!signal) {
        logger.debug(`${pair}: нет паттерна входа на 5m для уровня ${level.price.toFixed(2)} (${direction})`);
        continue;
      }

      // Проверка макс попыток на этот сетап
      const attemptKey = `${pair}:${level.price.toFixed(2)}:${direction}`;
      const attempts = this._orderAttempts.get(attemptKey) || 0;
      if (attempts >= MAX_ORDER_ATTEMPTS) {
        logger.info(`${pair}: исчерпаны попытки (${attempts}/${MAX_ORDER_ATTEMPTS}) для уровня ${level.price.toFixed(2)} — пропуск`);
        continue;
      }

      // Уменьшаем размер вдвое при противоречии на 4H
      signal._reduce = confirmation.reduce;
      signal._4hTrend = this.strategy.detectTrend4H(candles4H);
      signal._4hApproach = approach.approach;
      signal._levelData = level;
      signal.pair = pair;
      signal.timeframe = TF_ENTRY;

      logger.info(
        `${pair}: СИГНАЛ ${direction.toUpperCase()} | ${signal.typeRu} | ` +
        `уровень ${level.price.toFixed(2)} (${level.classification}, сила ${level.strength}) | ` +
        `4H тренд: ${signal._4hTrend} | подход: ${signal._4hApproach}`
      );

      // Переходим к открытию позиции
      await this._checkEntry(pair, signal, dailyLevels, balance, attemptKey);
      return; // один сигнал за тик на пару
    }
  }

  /**
   * Перенос SL в безубыток после прохождения 1R в прибыль.
   *
   * Герчик: после прохождения 1R — SL на уровень входа.
   * Дальнейший трейлинг НЕ применяется.
   * Позиция закрывается ТОЛЬКО по тейку или по стопу в безубытке.
   */
  async _checkBreakeven() {
    for (const [pair, pos] of this.positions) {
      if (pos._breakevenMoved) continue; // уже перенесён

      try {
        const ticker = await this.exchange.fetchTicker(pair);
        const currentPrice = ticker.last || ticker.close;
        if (!currentPrice) continue;

        const risk = Math.abs(pos.entry - pos.stopLoss);
        if (risk <= 0) continue;

        const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const sideIcon = pos.side === 'long' ? '🟢' : '🔴';
        const oldSL = pos.stopLoss;

        let profit = 0;
        if (pos.side === 'long') {
          profit = currentPrice - pos.entry;
        } else {
          profit = pos.entry - currentPrice;
        }

        const profitR = profit / risk; // сколько R пройдено

        if (profit >= risk) {
          // 1R достигнут — переносим SL в безубыток
          pos.stopLoss = pos.entry;
          pos._breakevenMoved = true;
          pos._breakevenMovedAt = new Date().toISOString();

          // Обновляем SL на бирже через setTradingStop
          await this._updateStopLossOnExchange(pair, pos);

          const logMsg =
            `БЕЗУБЫТОК ${pair} ${sideRu}: 1R достигнут | ` +
            `цена=${currentPrice} | вход=${pos.entry} | ` +
            `profit=${profit.toFixed(2)} (${profitR.toFixed(1)}R) | ` +
            `SL ${oldSL} → ${pos.entry} | TP=${pos.takeProfit}`;
          logger.info(logMsg);

          await this.notifier.sendMessage(
            `🔒 <b>Безубыток</b>\n` +
            `${sideIcon} <b>${sideRu}</b> ${pair}\n` +
            `━━━━━━━━━━━━━━━━━━\n` +
            `Цена сейчас: <code>${currentPrice}</code>\n` +
            `Вход: <code>${pos.entry}</code>\n` +
            `Прибыль: <code>${profit.toFixed(2)} (${profitR.toFixed(1)}R)</code>\n` +
            `SL: <code>${oldSL}</code> → <code>${pos.entry}</code>\n` +
            `TP: <code>${pos.takeProfit}</code>\n\n` +
            `Позиция защищена — стоп на уровне входа`
          );

          await this.webhook.pushToN8n('breakeven_moved', {
            pair, side: pos.side, entry: pos.entry,
            currentPrice, profit: profit.toFixed(2), profitR: profitR.toFixed(1),
            oldSL, newSL: pos.entry,
          });
        }
      } catch (err) {
        logger.error(`_checkBreakeven ${pair}: ${err.message}`);
      }
    }
  }

  /**
   * Установить SL (Stop Market) и TP (Limit) на позиции через Bybit Trading Stop API.
   * Вызывается после исполнения лимитного ордера.
   *
   * SL — Stop Market (гарантия исполнения, не проскользнёт).
   * TP — Limit (maker-комиссия 0.02%).
   */
  async _setPositionStopLossAndTakeProfit(pair, pos) {
    try {
      await this.exchange.setTradingStop(pair, {
        stopLoss: pos.stopLoss,
        takeProfit: pos.takeProfit,
      });
      logger.info(`${pair}: SL=${pos.stopLoss} (Stop Market) TP=${pos.takeProfit} (Limit) установлены`);
    } catch (err) {
      // SL/TP могут уже быть установлены через attached параметры ордера — не критично
      logger.warn(`${pair}: ошибка setTradingStop: ${err.message} (SL/TP могут быть уже установлены)`);
    }
  }

  /**
   * Перенос SL в безубыток через Bybit Trading Stop API.
   * Вызывается после прохождения 1R в прибыль.
   *
   * Используем setTradingStop — надёжнее editOrder, работает с Bybit v5.
   */
  async _updateStopLossOnExchange(pair, pos) {
    try {
      await this.exchange.setTradingStop(pair, {
        stopLoss: pos.stopLoss,
        // TP не меняем — оставляем существующий
      });
      logger.info(`${pair}: SL обновлён на ${pos.stopLoss} (безубыток) через setTradingStop`);
    } catch (err) {
      logger.warn(`${pair}: не удалось обновить SL на бирже: ${err.message}`);
    }
  }

  /**
   * Открытие позиции по сигналу Герчика.
   * Limit PostOnly ордер, 1-2 тика от зоны.
   */
  async _checkEntry(pair, entrySignal, dailyLevels, balance, attemptKey) {
    // ── AI фильтр ──
    if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
      try {
        const candles5m = await this.exchange.fetchCandles(pair, TF_ENTRY, 50);

        // Режим рынка
        const regime = await this.aiFilter.detectMarketRegime(pair, candles5m || []);
        logger.info(`${pair} режим рынка: ${regime.regime} (${regime.strength || '?'}%) — ${regime.suggestion}`);

        // Валидация сигнала AI
        const aiResult = await this.aiFilter.validateSignal(entrySignal, candles5m || [], dailyLevels);

        await this.webhook.pushToN8n('signal_pending', {
          pair,
          signal: entrySignal,
          aiResult,
          regime,
          levels: dailyLevels.slice(0, 5),
        });

        if (!aiResult.approved || aiResult.confidence < AI_MIN_CONFIDENCE) {
          logger.info(`${pair}: AI отклонил (${aiResult.confidence}%) — ${aiResult.reason}`);
          await this.notifier.sendMessage(
            `🤖 <b>AI ОТКЛОНИЛ</b> ${entrySignal.signal.toUpperCase()} ${pair}\n` +
            `Уверенность: ${aiResult.confidence}%\n` +
            `Причина: ${aiResult.reason}`
          );
          return;
        }

        logger.info(`${pair}: AI одобрил (${aiResult.confidence}%) — ${aiResult.reason}`);
        entrySignal._aiReason = aiResult.reason;
        entrySignal._aiConfidence = aiResult.confidence;
        entrySignal._regime = regime;
      } catch (aiErr) {
        logger.warn(`${pair}: AI фильтр ошибка: ${aiErr.message} — продолжаем без AI`);
      }
    }

    // ── Размер позиции ──
    const sizing = this.riskManager.calculatePositionSize(
      balance.free,
      entrySignal.entry,
      entrySignal.stopLoss
    );

    // Уменьшаем вдвое при противоречии 4H
    if (entrySignal._reduce) {
      sizing.size = parseFloat((sizing.size / 2).toFixed(6));
      sizing.riskAmount = parseFloat((sizing.riskAmount / 2).toFixed(2));
      logger.info(`${pair}: размер уменьшен вдвое (противоречие 4H) → ${sizing.size}`);
    }

    // ── Валидация ──
    const order = {
      side: entrySignal.signal,
      entry: entrySignal.entry,
      stopLoss: entrySignal.stopLoss,
      takeProfit: entrySignal.takeProfit,
      size: sizing.size,
    };

    const validation = this.riskManager.validateOrder(order, pair);
    if (!validation.valid) {
      const reason = validation.errors.join('; ');
      logger.info(`ПРОПУСК ${pair}: ордер отклонён риск-менеджером — ${reason}`);
      await this.webhook.pushToN8n('order_rejected', { signal: entrySignal, errors: validation.errors });
      return;
    }

    // ── Логирование параметров ордера (Раздел 10 Герчика) ──
    const levelData = entrySignal._levelData;
    logger.info(
      `ОРДЕР ${pair} ${entrySignal.signal.toUpperCase()} | ` +
      `паттерн: ${entrySignal.typeRu} | ` +
      `уровень: ${levelData ? `${levelData.price.toFixed(2)} (${levelData.classification}, сила ${levelData.strength})` : '?'} | ` +
      `entry: ${entrySignal.entry} | SL: ${entrySignal.stopLoss} (Stop Market) | TP: ${entrySignal.takeProfit} (Limit) | ` +
      `R:R: 1:${entrySignal.riskRewardRatio} | ` +
      `размер: ${sizing.size} | риск: ${sizing.riskAmount} USDT (${sizing.riskPct}%) | ` +
      `PostOnly: да | 4H тренд: ${entrySignal._4hTrend || '?'} | подход: ${entrySignal._4hApproach || '?'}` +
      (entrySignal._reduce ? ' | РАЗМЕР x0.5 (противоречие 4H)' : '') +
      (entrySignal._aiConfidence ? ` | AI: ${entrySignal._aiConfidence}%` : '')
    );

    // ── Исполнение: Limit PostOnly ──
    try {
      const result = await this.exchange.placeOrder(
        pair,
        entrySignal.signal === 'long' ? 'buy' : 'sell',
        sizing.size,
        entrySignal.stopLoss,
        entrySignal.takeProfit,
        entrySignal.entry, // limit price
        true // postOnly
      );

      const position = {
        id: pair,
        side: entrySignal.signal,
        entry: entrySignal.entry,
        stopLoss: entrySignal.stopLoss,
        takeProfit: entrySignal.takeProfit,
        _originalSL: entrySignal.stopLoss, // оригинальный SL (до безубытка)
        size: sizing.size,
        orderId: result.id,
        entryReason: entrySignal.reason,
        openedAt: new Date().toISOString(),
        _breakevenMoved: false,
        // Данные уровня для логирования при закрытии
        _levelPrice: levelData ? levelData.price : null,
        _levelClassification: levelData ? levelData.classification : null,
        _levelStrength: levelData ? levelData.strength : null,
        _entryPattern: entrySignal.type || null,
      };

      // Limit ордер — ждём исполнения
      if (result.status === 'open' || result.type === 'limit') {
        this._pendingOrders.set(result.id, {
          pair,
          position,
          signal: entrySignal,
          sizing,
          createdAt: Date.now(),
          attemptKey,
          level: entrySignal._levelData,
          direction: entrySignal.signal,
        });

        const sideRu = entrySignal.signal === 'long' ? 'ЛОНГ' : 'ШОРТ';
        const levelInfo = entrySignal._levelData;

        await this.notifier.sendMessage(
          `⏳ <b>Лимитный ордер (PostOnly)</b>\n` +
          `${entrySignal.signal === 'long' ? '🟢' : '🔴'} <b>${sideRu}</b> ${pair}\n` +
          `━━━━━━━━━━━━━━━━━━\n` +
          `Цена: <code>${entrySignal.entry}</code>\n` +
          `SL: <code>${entrySignal.stopLoss}</code> | TP: <code>${entrySignal.takeProfit}</code>\n` +
          `R:R: <code>1:${entrySignal.riskRewardRatio}</code>\n` +
          `Размер: <code>${sizing.size}</code> | Риск: <code>${sizing.riskAmount} USDT</code>\n\n` +
          `📐 Уровень: ${levelInfo ? `${levelInfo.price.toFixed(2)} (${this.strategy._classificationRu(levelInfo.classification)}, сила ${levelInfo.strength})` : entrySignal.level}\n` +
          `Паттерн: <b>${entrySignal.typeRu}</b>\n` +
          `4H тренд: ${entrySignal._4hTrend || '?'} | подход: ${entrySignal._4hApproach || '?'}\n` +
          `Отмена: пробой уровня или 30 мин` +
          (entrySignal._aiConfidence ? `\n\n🤖 AI (${entrySignal._aiConfidence}%): ${entrySignal._aiReason}` : '')
        );

        logger.info(`Лимитный ордер размещён: ${result.id} — ожидание исполнения`);
        return;
      }

      // Мгновенное исполнение — устанавливаем SL/TP через Trading Stop API
      this.positions.set(pair, position);
      this.riskManager.addPosition(position);

      // SL (Stop Market) + TP (Limit) через setTradingStop
      await this._setPositionStopLossAndTakeProfit(pair, position);

      await this.notifier.notifyTrade({
        ...entrySignal,
        positionSize: sizing.size,
        riskAmount: sizing.riskAmount,
      });
      await this.webhook.pushToN8n('trade_opened', position);
      logger.info(`${pair}: ${entrySignal.signal} вход — ${entrySignal.reason}`);
    } catch (err) {
      logger.error(`Ошибка размещения ордера ${pair}: ${err.message}`);
      await this.notifier.notifyError(err);
      await this.webhook.pushToN8n('order_error', { pair, error: err.message });
    }
  }
}

// --- CLI entry point ---
if (require.main === module) {
  const bot = new TradingBot();
  bot.start().catch((err) => {
    logger.error(`Fatal: ${err.message}`);
    process.exit(1);
  });
}

module.exports = TradingBot;
