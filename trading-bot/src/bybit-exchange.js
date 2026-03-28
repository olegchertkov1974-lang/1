'use strict';

/**
 * Bybit Exchange Connector
 *
 * Handles API communication with Bybit using ccxt.
 * Loads credentials from environment variables.
 * Implements retry logic with exponential backoff.
 */

const ccxt = require('ccxt');
const logger = require('./logger');

const ALLOWED_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
const ALLOWED_TIMEFRAMES = ['15m', '1h', '4h'];
const MAX_RETRIES = 3;
const BASE_RETRY_DELAY = 2000; // ms

class BybitExchange {
  constructor() {
    const apiKey = process.env.BYBIT_API_KEY;
    const apiSecret = process.env.BYBIT_API_SECRET;

    if (!apiKey || !apiSecret) {
      throw new Error(
        'BYBIT_API_KEY and BYBIT_API_SECRET must be set in environment variables. ' +
        'Create a .env file or export them. Keys must have TRADE permission only (no withdrawal).'
      );
    }

    this.exchange = new ccxt.bybit({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'linear', // USDT perpetual
        adjustForTimeDifference: true,
      },
      timeout: 30000,
    });

    // Bybit Demo Trading has built-in URL set in ccxt: urls.demotrading
    if (process.env.BYBIT_DEMO === 'true') {
      this.exchange.urls['api'] = this.exchange.urls['demotrading'];
      logger.info('Bybit: running in DEMO TRADING mode (api-demo.bybit.com)');
    } else if (process.env.BYBIT_TESTNET === 'true') {
      this.exchange.setSandboxMode(true);
      logger.info('Bybit: running in TESTNET mode');
    }
  }

  /**
   * Validate that a trading pair is allowed.
   */
  validatePair(pair) {
    if (!ALLOWED_PAIRS.includes(pair)) {
      throw new Error(`Pair ${pair} is not allowed. Allowed: ${ALLOWED_PAIRS.join(', ')}`);
    }
  }

  /**
   * Validate timeframe.
   */
  validateTimeframe(tf) {
    if (!ALLOWED_TIMEFRAMES.includes(tf)) {
      throw new Error(`Timeframe ${tf} is not allowed. Allowed: ${ALLOWED_TIMEFRAMES.join(', ')}`);
    }
  }

  /**
   * Fetch OHLCV candles with retry.
   */
  async fetchCandles(pair, timeframe, limit = 200) {
    this.validatePair(pair);
    this.validateTimeframe(timeframe);

    return this._retry(async () => {
      const ohlcv = await this.exchange.fetchOHLCV(pair, timeframe, undefined, limit);
      return ohlcv.map((c) => ({
        time: c[0],
        open: c[1],
        high: c[2],
        low: c[3],
        close: c[4],
        volume: c[5],
      }));
    }, `fetchCandles(${pair}, ${timeframe})`);
  }

  /**
   * Fetch account balance.
   */
  async fetchBalance() {
    return this._retry(async () => {
      const balance = await this.exchange.fetchBalance();
      return {
        total: balance.total && balance.total.USDT ? balance.total.USDT : 0,
        free: balance.free && balance.free.USDT ? balance.free.USDT : 0,
        used: balance.used && balance.used.USDT ? balance.used.USDT : 0,
      };
    }, 'fetchBalance');
  }

  /**
   * Place a market order with SL and TP.
   */
  async placeOrder(pair, side, amount, stopLoss, takeProfit) {
    this.validatePair(pair);

    return this._retry(async () => {
      const params = {};

      if (stopLoss) params.stopLoss = { triggerPrice: stopLoss, type: 'market' };
      if (takeProfit) params.takeProfit = { triggerPrice: takeProfit, type: 'market' };

      logger.info(`Placing ${side} order: ${pair} size=${amount} SL=${stopLoss} TP=${takeProfit}`);
      const order = await this.exchange.createOrder(pair, 'market', side, amount, undefined, params);
      logger.info(`Order placed: ${order.id}`);
      return order;
    }, `placeOrder(${pair}, ${side})`);
  }

  /**
   * Close a position.
   */
  async closePosition(pair, side, amount) {
    this.validatePair(pair);
    const closeSide = side === 'long' ? 'sell' : 'buy';

    return this._retry(async () => {
      logger.info(`Closing ${side} position: ${pair} size=${amount}`);
      const order = await this.exchange.createOrder(pair, 'market', closeSide, amount, undefined, {
        reduceOnly: true,
      });
      logger.info(`Position closed: ${order.id}`);
      return order;
    }, `closePosition(${pair})`);
  }

  /**
   * Fetch 24h ticker for volume data.
   */
  async fetchTicker(pair) {
    this.validatePair(pair);
    return this._retry(async () => {
      return this.exchange.fetchTicker(pair);
    }, `fetchTicker(${pair})`);
  }

  /**
   * Get open positions.
   */
  async fetchOpenPositions(pair) {
    return this._retry(async () => {
      const positions = await this.exchange.fetchPositions(pair ? [pair] : ALLOWED_PAIRS);
      return positions.filter((p) => p.contracts > 0);
    }, 'fetchOpenPositions');
  }

  /**
   * Retry wrapper with exponential backoff.
   */
  async _retry(fn, label) {
    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        return await fn();
      } catch (error) {
        const isRetryable =
          error instanceof ccxt.NetworkError ||
          error instanceof ccxt.RequestTimeout ||
          error instanceof ccxt.ExchangeNotAvailable ||
          error instanceof ccxt.DDoSProtection;

        if (isRetryable && attempt < MAX_RETRIES) {
          const delay = BASE_RETRY_DELAY * Math.pow(2, attempt - 1);
          logger.warn(`${label}: attempt ${attempt} failed (${error.message}), retrying in ${delay}ms...`);
          await new Promise((r) => setTimeout(r, delay));
        } else {
          logger.error(`${label}: failed after ${attempt} attempts — ${error.message}`);
          throw error;
        }
      }
    }
  }

  getAllowedPairs() {
    return [...ALLOWED_PAIRS];
  }

  getAllowedTimeframes() {
    return [...ALLOWED_TIMEFRAMES];
  }
}

module.exports = BybitExchange;
