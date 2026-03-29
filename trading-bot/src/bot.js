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
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h,4h').split(',').map((t) => t.trim());
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;
const VOLUME_THRESHOLD = parseFloat(process.env.VOLUME_THRESHOLD) || 1000000;
const AI_FILTER_ENABLED = process.env.AI_FILTER_ENABLED !== 'false';
const AI_MIN_CONFIDENCE = parseInt(process.env.AI_MIN_CONFIDENCE, 10) || 60;

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
    this.positions = new Map(); // pair:tf -> position info
    this._pendingSignals = new Map();
    this._pendingOrders = new Map(); // orderId -> { pair, posKey, position, createdAt }
  }

  async start() {
    logger.info('=== Gerchik Levels Trading Bot starting ===');
    logger.info(`Pairs: ${PAIRS.join(', ')}`);
    logger.info(`Timeframes: ${TIMEFRAMES.join(', ')}`);
    logger.info(`Poll interval: ${POLL_INTERVAL_MS}ms`);
    logger.info(`Volume threshold: ${VOLUME_THRESHOLD}`);
    logger.info(`AI filter: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ON' : 'OFF'}`);
    logger.info(`n8n webhook: ${this.webhook.n8nWebhookUrl || 'not configured'}`);

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
        '🤖 <b>Бот запущен</b>\n' +
        `Пары: ${PAIRS.join(', ')}\n` +
        `ТФ: ${TIMEFRAMES.join(', ')}\n` +
        `AI: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ВКЛ' : 'ВЫКЛ'}\n` +
        `Риск: ${this.riskManager.riskPct}%`
      );
    } catch (e) {
      logger.warn(`Startup Telegram notification failed: ${e.message}`);
    }

    // Notify n8n
    await this.webhook.pushToN8n('bot_started', {
      pairs: PAIRS,
      timeframes: TIMEFRAMES,
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
        const posKey = `${pair}:synced`;

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
   * Check pending limit orders: fill → register position, timeout → cancel.
   */
  async _checkPendingOrders() {
    const LIMIT_ORDER_TIMEOUT = 5 * 60 * 1000; // 5 minutes

    for (const [orderId, pending] of [...this._pendingOrders]) {
      try {
        const order = await this.exchange.fetchOrder(orderId, pending.pair);

        if (order.status === 'closed' || order.filled > 0) {
          // Order filled — register position
          this._pendingOrders.delete(orderId);
          this.positions.set(pending.posKey, pending.position);
          this.riskManager.addPosition(pending.position);

          await this.notifier.notifyTrade({
            ...pending.signal,
            positionSize: pending.sizing.size,
            riskAmount: pending.sizing.riskAmount,
          });
          await this.webhook.pushToN8n('trade_opened', pending.position);
          logger.info(`Limit order filled: ${orderId} — ${pending.pair}`);

        } else if (order.status === 'canceled') {
          // Already canceled
          this._pendingOrders.delete(orderId);
          logger.info(`Limit order was canceled: ${orderId}`);

        } else if (Date.now() - pending.createdAt > LIMIT_ORDER_TIMEOUT) {
          // Timeout — cancel order
          this._pendingOrders.delete(orderId);
          await this.exchange.cancelOrder(orderId, pending.pair);
          await this.notifier.sendMessage(
            `⏰ <b>Лимитный ордер отменён</b>\n` +
            `${pending.pair} — цена не дошла до уровня за 5 мин`
          );
          logger.info(`Limit order timed out and canceled: ${orderId}`);
        }
      } catch (err) {
        logger.error(`_checkPendingOrders error for ${orderId}: ${err.message}`);
        // If order not found, remove from tracking
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
    logger.info(`Balance: ${balance.free} USDT (total: ${balance.total})`);

    // Check pending limit orders (fill or cancel after timeout)
    await this._checkPendingOrders();

    // Check if any tracked positions were closed on exchange (by SL/TP)
    await this._detectClosedPositions();

    for (const pair of PAIRS) {
      for (const tf of TIMEFRAMES) {
        try {
          await this._processPair(pair, tf, balance);
        } catch (err) {
          logger.error(`Error processing ${pair} ${tf}: ${err.message}`);
        }
      }
    }

    // Send periodic status to n8n
    await this.webhook.pushToN8n('tick_complete', {
      balance,
      openPositions: this.positions.size,
      timestamp: new Date().toISOString(),
    });
  }

  async _processPair(pair, timeframe, balance) {
    // Fetch candles
    const candles = await this.exchange.fetchCandles(pair, timeframe, 200);
    if (!candles || candles.length < 50) {
      logger.debug(`${pair} ${timeframe}: not enough candles`);
      return;
    }

    // Volume filter
    const ticker = await this.exchange.fetchTicker(pair);
    if (ticker.quoteVolume && ticker.quoteVolume < VOLUME_THRESHOLD) {
      logger.debug(`${pair}: daily volume ${ticker.quoteVolume} below threshold ${VOLUME_THRESHOLD}`);
      return;
    }

    // Find levels
    const levels = this.strategy._findLevels(candles);
    const atr = this.strategy._calculateATR(candles, 14);

    // Check existing position for exit
    const posKey = `${pair}:${timeframe}`;
    const existingPos = this.positions.get(posKey);

    if (existingPos) {
      await this._checkExit(posKey, pair, timeframe, candles, existingPos, levels, atr);
      return;
    }

    // Check entry
    await this._checkEntry(posKey, pair, timeframe, candles, levels, atr, balance);
  }

  async _checkExit(posKey, pair, timeframe, candles, existingPos, levels, atr) {
    const exitSignal = this.strategy.exitSignal(candles, existingPos, levels, atr);
    if (!exitSignal) return;

    try {
      await this.exchange.closePosition(pair, existingPos.side, existingPos.size);
      this.riskManager.removePosition(posKey);
      this.positions.delete(posKey);

      const currentPrice = exitSignal.price || candles[candles.length - 1].close;
      const pnl = existingPos.side === 'long'
        ? (currentPrice - existingPos.entry) * existingPos.size
        : (existingPos.entry - currentPrice) * existingPos.size;
      const duration = Date.now() - new Date(existingPos.openedAt).getTime();
      const durationMin = Math.round(duration / 60000);

      // Store completed trade
      const trade = {
        pair,
        timeframe,
        side: existingPos.side,
        entry: existingPos.entry,
        exitPrice: currentPrice,
        stopLoss: existingPos.stopLoss,
        takeProfit: existingPos.takeProfit,
        size: existingPos.size,
        pnl: parseFloat(pnl.toFixed(2)),
        entryReason: existingPos.entryReason || '',
        exitReason: exitSignal.reason,
        duration: `${durationMin}m`,
        closedAt: new Date().toISOString(),
      };
      this.tradeStore.saveTrade(trade);

      // Notify
      await this.notifier.notifyClose({ ...exitSignal, pair, pnl: trade.pnl });
      await this.webhook.pushToN8n('trade_closed', trade);
      logger.info(`${pair} ${timeframe}: position closed — ${exitSignal.reason} (PnL: ${trade.pnl})`);

      // AI post-trade analysis
      if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
        const analysis = await this.aiFilter.analyzeTrade(trade);
        if (analysis) {
          this.tradeStore.saveAnalysis(trade.closedAt, analysis);
          const analysisMsg =
            `📊 <b>Анализ сделки</b> ${pair}\n` +
            `Оценка: ${analysis.grade}\n` +
            `Уроки: ${(analysis.lessons || []).join(', ')}\n` +
            `Совет: ${analysis.improvement || ''}`;
          await this.notifier.sendMessage(analysisMsg);
          await this.webhook.pushToN8n('trade_analysis', { trade, analysis });
        }
      }
    } catch (err) {
      logger.error(`Failed to close position ${pair}: ${err.message}`);
      await this.notifier.notifyError(err);
    }
  }

  async _checkEntry(posKey, pair, timeframe, candles, levels, atr, balance) {
    const entrySignal = this.strategy.entrySignal(candles, levels, atr, {
      volumeThreshold: VOLUME_THRESHOLD,
      balance: balance.free,
      riskPct: this.riskManager.riskPct,
    });

    if (!entrySignal) return;

    entrySignal.pair = pair;
    entrySignal.timeframe = timeframe;

    // ── AI Filter ──
    if (AI_FILTER_ENABLED && this.aiFilter.enabled) {
      // Detect market regime first
      const regime = await this.aiFilter.detectMarketRegime(pair, candles);
      logger.info(`${pair} market regime: ${regime.regime} (${regime.strength || '?'}%) — ${regime.suggestion}`);

      // Skip ranging market for breakout signals
      if (regime.regime === 'ranging' && entrySignal.type === 'breakout') {
        logger.info(`${pair}: skipping breakout in ranging market`);
        await this.webhook.pushToN8n('signal_skipped', {
          signal: entrySignal,
          reason: 'Breakout in ranging market',
          regime,
        });
        return;
      }

      // Validate signal with AI
      const aiResult = await this.aiFilter.validateSignal(entrySignal, candles, levels);

      // Push signal to n8n for external validation too
      await this.webhook.pushToN8n('signal_pending', {
        posKey,
        signal: entrySignal,
        aiResult,
        regime,
        levels: levels.slice(0, 5),
      });

      if (!aiResult.approved || aiResult.confidence < AI_MIN_CONFIDENCE) {
        logger.info(`${pair} ${timeframe}: AI rejected signal (${aiResult.confidence}%) — ${aiResult.reason}`);
        await this.notifier.sendMessage(
          `🤖 <b>AI ОТКЛОНИЛ</b> ${entrySignal.signal.toUpperCase()} ${pair}\n` +
          `Уверенность: ${aiResult.confidence}%\n` +
          `Причина: ${aiResult.reason}`
        );
        return;
      }

      logger.info(`${pair} ${timeframe}: AI approved (${aiResult.confidence}%) — ${aiResult.reason}`);

      // Save AI analysis for trade notification
      entrySignal._aiReason = aiResult.reason;
      entrySignal._aiConfidence = aiResult.confidence;
      entrySignal._regime = regime;
    } else {
      // No AI — still push to n8n
      await this.webhook.pushToN8n('signal_pending', {
        posKey,
        signal: entrySignal,
        aiResult: null,
        levels: levels.slice(0, 5),
      });
    }

    // ── Position sizing ──
    const sizing = this.riskManager.calculatePositionSize(
      balance.free,
      entrySignal.entry,
      entrySignal.stopLoss
    );

    const order = {
      side: entrySignal.signal,
      entry: entrySignal.entry,
      stopLoss: entrySignal.stopLoss,
      takeProfit: entrySignal.takeProfit,
      size: sizing.size,
    };

    // Validate
    const validation = this.riskManager.validateOrder(order);
    if (!validation.valid) {
      logger.warn(`${pair} ${timeframe}: order rejected — ${validation.errors.join('; ')}`);
      await this.webhook.pushToN8n('order_rejected', {
        signal: entrySignal,
        errors: validation.errors,
      });
      return;
    }

    // ── Execute ──
    try {
      const result = await this.exchange.placeOrder(
        pair,
        entrySignal.signal === 'long' ? 'buy' : 'sell',
        sizing.size,
        entrySignal.stopLoss,
        entrySignal.takeProfit,
        entrySignal.entry // limit price at level
      );

      const position = {
        id: posKey,
        side: entrySignal.signal,
        entry: entrySignal.entry,
        stopLoss: entrySignal.stopLoss,
        takeProfit: entrySignal.takeProfit,
        size: sizing.size,
        orderId: result.id,
        entryReason: entrySignal.reason,
        openedAt: new Date().toISOString(),
      };

      // For limit orders, track as pending until filled
      if (result.status === 'open' || result.type === 'limit') {
        this._pendingOrders.set(result.id, {
          pair,
          posKey,
          position,
          signal: entrySignal,
          sizing,
          createdAt: Date.now(),
        });
        logger.info(`Limit order pending: ${result.id} — waiting for fill`);
        await this.notifier.sendMessage(
          `⏳ <b>Лимитный ордер размещён</b>\n` +
          `${entrySignal.signal === 'long' ? '🟢 ЛОНГ' : '🔴 ШОРТ'} ${pair}\n` +
          `Цена: <code>${entrySignal.entry}</code>\n` +
          `Ожидание исполнения (макс 5 мин)`
        );
        return;
      }

      // Market order or instantly filled limit — register position
      this.positions.set(posKey, position);
      this.riskManager.addPosition(position);

      await this.notifier.notifyTrade({
        ...entrySignal,
        positionSize: sizing.size,
        riskAmount: sizing.riskAmount,
      });
      await this.webhook.pushToN8n('trade_opened', position);
      logger.info(`${pair} ${timeframe}: ${entrySignal.signal} entry — ${entrySignal.reason}`);
    } catch (err) {
      logger.error(`Failed to place order ${pair}: ${err.message}`);
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
