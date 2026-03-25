'use strict';

/**
 * Main Trading Bot
 *
 * Orchestrates strategy, exchange, risk management, and notifications.
 * Runs via CLI — no web interface.
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const GerchikLevels = require('../../var/strategies/gerchik-levels');
const BybitExchange = require('./bybit-exchange');
const RiskManager = require('./risk-manager');
const TelegramNotifier = require('./telegram-notifier');
const logger = require('./logger');

const PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
const TIMEFRAMES = (process.env.TIMEFRAMES || '15m,1h,4h').split(',').map((t) => t.trim());
const POLL_INTERVAL_MS = parseInt(process.env.POLL_INTERVAL_MS, 10) || 60000;
const VOLUME_THRESHOLD = parseFloat(process.env.VOLUME_THRESHOLD) || 1000000;

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
    this.running = false;
    this.positions = new Map(); // pair -> position info
  }

  async start() {
    logger.info('=== Gerchik Levels Trading Bot starting ===');
    logger.info(`Pairs: ${PAIRS.join(', ')}`);
    logger.info(`Timeframes: ${TIMEFRAMES.join(', ')}`);
    logger.info(`Poll interval: ${POLL_INTERVAL_MS}ms`);
    logger.info(`Volume threshold: ${VOLUME_THRESHOLD}`);

    this.running = true;

    // Graceful shutdown
    process.on('SIGINT', () => this.stop());
    process.on('SIGTERM', () => this.stop());

    await this.notifier.sendMessage('🤖 <b>Bot started</b>');

    while (this.running) {
      try {
        await this._tick();
      } catch (err) {
        logger.error(`Tick error: ${err.message}`);
        await this.notifier.notifyError(err);
      }

      if (this.running) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
      }
    }
  }

  stop() {
    logger.info('Bot stopping...');
    this.running = false;
    this.notifier.sendMessage('🛑 <b>Bot stopped</b>').catch(() => {});
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
      const exitSignal = this.strategy.exitSignal(candles, existingPos, levels, atr);
      if (exitSignal) {
        try {
          await this.exchange.closePosition(pair, existingPos.side, existingPos.size);
          this.riskManager.removePosition(posKey);
          this.positions.delete(posKey);
          await this.notifier.notifyClose({ ...exitSignal, pair });
          logger.info(`${pair} ${timeframe}: position closed — ${exitSignal.reason}`);
        } catch (err) {
          logger.error(`Failed to close position ${pair}: ${err.message}`);
          await this.notifier.notifyError(err);
        }
      }
      return; // already in a position for this pair/tf
    }

    // Check entry
    const entrySignal = this.strategy.entrySignal(candles, levels, atr, {
      volumeThreshold: VOLUME_THRESHOLD,
      balance: balance.free,
      riskPct: this.riskManager.riskPct,
    });

    if (!entrySignal) return;

    // Position sizing
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
      return;
    }

    // Execute
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
        openedAt: new Date().toISOString(),
      };

      this.positions.set(posKey, position);
      this.riskManager.addPosition(position);

      await this.notifier.notifyTrade({ ...entrySignal, pair, positionSize: sizing.size });
      logger.info(`${pair} ${timeframe}: ${entrySignal.signal} entry — ${entrySignal.reason}`);
    } catch (err) {
      logger.error(`Failed to place order ${pair}: ${err.message}`);
      await this.notifier.notifyError(err);
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
