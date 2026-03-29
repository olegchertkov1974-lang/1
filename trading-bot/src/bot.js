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

        const position = {
          id: posKey,
          side,
          entry: pos.entryPrice || parseFloat(pos.info?.avgPrice || '0'),
          stopLoss: pos.stopLossPrice || parseFloat(pos.info?.stopLoss || '0'),
          takeProfit: pos.takeProfitPrice || parseFloat(pos.info?.takeProfit || '0'),
          size,
          orderId: 'synced',
          entryReason: 'Synced from exchange after restart',
          openedAt: pos.timestamp ? new Date(pos.timestamp).toISOString() : new Date().toISOString(),
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
                logger.info(`Частичное <50% (${order.filled}) — закрыто рыночным, сделка не ведётся`);
              } catch (e) {
                logger.error(`Ошибка закрытия частичной позиции: ${e.message}`);
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
   * Detect positions closed by exchange (SL/TP hit on Bybit side).
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
        if (!exchangePairs.has(pair)) {
          // Position no longer exists on exchange — closed by SL/TP
          logger.info(`Position ${posKey} closed on exchange (SL/TP hit)`);
          this.positions.delete(posKey);
          this.riskManager.removePosition(posKey);

          // Determine if TP or SL was hit based on current price
          let closeReason = 'Закрыта на бирже (SL/TP)';
          let pnlEstimate = 0;
          try {
            const ticker = await this.exchange.fetchTicker(pair);
            const price = ticker.last || ticker.close || 0;
            if (pos.side === 'long') {
              pnlEstimate = (price - pos.entry) * pos.size;
              if (pos.takeProfit && price >= pos.takeProfit * 0.998) {
                closeReason = `✅ Закрыта по Take Profit (${pos.takeProfit})`;
              } else if (pos.stopLoss && price <= pos.stopLoss * 1.002) {
                closeReason = `🛑 Закрыта по Stop Loss (${pos.stopLoss})`;
              }
            } else {
              pnlEstimate = (pos.entry - price) * pos.size;
              if (pos.takeProfit && price <= pos.takeProfit * 1.002) {
                closeReason = `✅ Закрыта по Take Profit (${pos.takeProfit})`;
              } else if (pos.stopLoss && price >= pos.stopLoss * 0.998) {
                closeReason = `🛑 Закрыта по Stop Loss (${pos.stopLoss})`;
              }
            }
          } catch (e) { /* ignore ticker error */ }

          const pnlIcon = pnlEstimate >= 0 ? '✅' : '❌';
          const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
          const msg =
            `${pnlIcon} <b>Позиция закрыта</b>\n\n` +
            `${pos.side === 'long' ? '🟢' : '🔴'} <b>${sideRu}</b> ${pair}\n` +
            `Вход: <code>${pos.entry}</code>\n` +
            `SL: <code>${pos.stopLoss}</code> | TP: <code>${pos.takeProfit}</code>\n` +
            `Размер: <code>${pos.size}</code>\n` +
            `PnL: <code>~${pnlEstimate.toFixed(2)} USDT</code>\n\n` +
            `Причина: ${closeReason}`;

          await this.notifier.sendMessage(msg);

          // Save to trade store
          this.tradeStore.saveTrade({
            pair,
            timeframe: 'synced',
            side: pos.side,
            entry: pos.entry,
            exitPrice: 0,
            stopLoss: pos.stopLoss,
            takeProfit: pos.takeProfit,
            size: pos.size,
            pnl: parseFloat(pnlEstimate.toFixed(2)),
            entryReason: pos.entryReason || '',
            exitReason: closeReason,
            duration: pos.openedAt ? `${Math.round((Date.now() - new Date(pos.openedAt).getTime()) / 60000)}m` : '?',
            closedAt: new Date().toISOString(),
          });

          await this.webhook.pushToN8n('trade_closed', { pair, side: pos.side, reason: closeReason, pnl: pnlEstimate });
        }
      }
    } catch (err) {
      logger.error(`_detectClosedPositions error: ${err.message}`);
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

        if (levels.length === 0) {
          logger.info(`${pair}: уровни не найдены на 1D`);
        }
      } catch (err) {
        logger.error(`${pair}: ошибка обновления уровней: ${err.message}`);
      }
    }
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

      if (!signal) continue;

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
   */
  async _checkBreakeven() {
    for (const [pair, pos] of this.positions) {
      if (pos._breakevenMoved) continue; // уже перенесён

      try {
        const ticker = await this.exchange.fetchTicker(pair);
        const currentPrice = ticker.last || ticker.close;
        if (!currentPrice) continue;

        const risk = Math.abs(pos.entry - pos.stopLoss);

        if (pos.side === 'long') {
          const profit = currentPrice - pos.entry;
          if (profit >= risk) {
            // 1R достигнут — переносим SL в безубыток
            logger.info(`${pair}: 1R достигнут (${profit.toFixed(2)} >= ${risk.toFixed(2)}) — SL → безубыток ${pos.entry}`);
            pos.stopLoss = pos.entry;
            pos._breakevenMoved = true;

            // Обновляем SL на бирже
            await this._updateStopLossOnExchange(pair, pos);

            await this.notifier.sendMessage(
              `🔒 <b>Безубыток</b>\n${pair} ЛОНГ\nSL перенесён на вход: <code>${pos.entry}</code>`
            );
          }
        } else {
          const profit = pos.entry - currentPrice;
          if (profit >= risk) {
            logger.info(`${pair}: 1R достигнут (${profit.toFixed(2)} >= ${risk.toFixed(2)}) — SL → безубыток ${pos.entry}`);
            pos.stopLoss = pos.entry;
            pos._breakevenMoved = true;

            await this._updateStopLossOnExchange(pair, pos);

            await this.notifier.sendMessage(
              `🔒 <b>Безубыток</b>\n${pair} ШОРТ\nSL перенесён на вход: <code>${pos.entry}</code>`
            );
          }
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
      logger.warn(`${pair}: ордер отклонён — ${validation.errors.join('; ')}`);
      await this.webhook.pushToN8n('order_rejected', { signal: entrySignal, errors: validation.errors });
      return;
    }

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
        size: sizing.size,
        orderId: result.id,
        entryReason: entrySignal.reason,
        openedAt: new Date().toISOString(),
        _breakevenMoved: false,
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
