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

    // Graceful shutdown
    const shutdown = () => this.stop();
    process.on('SIGINT', shutdown);
    process.on('SIGTERM', shutdown);

    await this.notifier.sendMessage(
      '🤖 <b>Bot started</b>\n' +
      `Pairs: ${PAIRS.join(', ')}\n` +
      `TF: ${TIMEFRAMES.join(', ')}\n` +
      `AI: ${AI_FILTER_ENABLED && this.aiFilter.enabled ? 'ON' : 'OFF'}\n` +
      `Risk: ${this.riskManager.riskPct}%`
    );

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

  stop() {
    logger.info('Bot stopping...');
    this.running = false;
    this.webhook.stop();
    this.tradeStore.close();
    this.notifier.sendMessage('🛑 <b>Bot stopped</b>').catch(() => {});
    this.webhook.pushToN8n('bot_stopped', {}).catch(() => {});
  }

  async _tick() {
    const balance = await this.exchange.fetchBalance();
    logger.info(`Balance: ${balance.free} USDT (total: ${balance.total})`);

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
            `📊 <b>Post-trade analysis</b> ${pair}\n` +
            `Grade: ${analysis.grade}\n` +
            `Lessons: ${(analysis.lessons || []).join(', ')}\n` +
            `Improvement: ${analysis.improvement || ''}`;
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
          `🤖 <b>AI REJECTED</b> ${entrySignal.signal.toUpperCase()} ${pair}\n` +
          `Confidence: ${aiResult.confidence}%\n` +
          `Reason: ${aiResult.reason}`
        );
        return;
      }

      logger.info(`${pair} ${timeframe}: AI approved (${aiResult.confidence}%) — ${aiResult.reason}`);
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
        entrySignal.takeProfit
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
