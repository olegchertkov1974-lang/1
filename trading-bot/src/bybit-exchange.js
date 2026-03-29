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

// User-facing pair names (without settlement suffix)
const ALLOWED_PAIRS = ['BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT'];
const ALLOWED_TIMEFRAMES = ['5m', '15m', '1h', '4h', '1d'];
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

    const isDemo = process.env.BYBIT_DEMO === 'true';

    this.exchange = new ccxt.bybit({
      apiKey,
      secret: apiSecret,
      enableRateLimit: true,
      options: {
        defaultType: 'linear', // USDT perpetual
        adjustForTimeDifference: true,
        enableDemoTrading: isDemo, // ccxt built-in demo trading support
      },
      timeout: 30000,
    });

    if (isDemo) {
      // ccxt has built-in demotrading URLs (api-demo.bybit.com)
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
   * Convert pair to linear perpetual symbol (e.g. BTC/USDT -> BTC/USDT:USDT).
   */
  _toLinear(pair) {
    return pair.includes(':') ? pair : `${pair}:USDT`;
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
      const ohlcv = await this.exchange.fetchOHLCV(this._toLinear(pair), timeframe, undefined, limit);
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
   * Place a limit order with SL and TP at the level price.
   * Falls back to market order if price moves past the level.
   */
  /**
   * Разместить ордер. PostOnly гарантирует maker-комиссию (0.02%).
   * @param {boolean} postOnly — если true, ордер будет PostOnly (отменится если станет taker)
   */
  async placeOrder(pair, side, amount, stopLoss, takeProfit, limitPrice, postOnly = false) {
    this.validatePair(pair);

    return this._retry(async () => {
      const params = {};

      if (stopLoss) params.stopLoss = { triggerPrice: stopLoss, type: 'market' };
      if (takeProfit) params.takeProfit = { triggerPrice: takeProfit, type: 'market' };

      // PostOnly — гарантия maker-комиссии
      if (postOnly && limitPrice) {
        params.timeInForce = 'PostOnly';
      }

      const orderType = limitPrice ? 'limit' : 'market';
      const price = limitPrice || undefined;

      logger.info(`Ордер ${orderType}${postOnly ? ' PostOnly' : ''} ${side}: ${pair} объём=${amount} цена=${limitPrice || 'market'} SL=${stopLoss} TP=${takeProfit}`);
      const order = await this.exchange.createOrder(this._toLinear(pair), orderType, side, amount, price, params);
      logger.info(`Ордер размещён: ${order.id} (${orderType}${postOnly ? ' PostOnly' : ''})`);
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
      const order = await this.exchange.createOrder(this._toLinear(pair), 'market', closeSide, amount, undefined, {
        reduceOnly: true,
      });
      logger.info(`Position closed: ${order.id}`);
      return order;
    }, `closePosition(${pair})`);
  }

  /**
   * Cancel an open order.
   */
  async cancelOrder(orderId, pair) {
    return this._retry(async () => {
      logger.info(`Cancelling order ${orderId} on ${pair}`);
      await this.exchange.cancelOrder(orderId, this._toLinear(pair));
      logger.info(`Order ${orderId} cancelled`);
    }, `cancelOrder(${pair})`);
  }

  /**
   * Check order status (open, closed, canceled).
   */
  async fetchOrder(orderId, pair) {
    return this._retry(async () => {
      return this.exchange.fetchOrder(orderId, this._toLinear(pair));
    }, `fetchOrder(${pair})`);
  }

  /**
   * Fetch 24h ticker for volume data.
   */
  async fetchTicker(pair) {
    this.validatePair(pair);
    return this._retry(async () => {
      return this.exchange.fetchTicker(this._toLinear(pair));
    }, `fetchTicker(${pair})`);
  }

  /**
   * Get open positions.
   */
  async fetchOpenPositions(pair) {
    return this._retry(async () => {
      const pairs = pair ? [pair] : ALLOWED_PAIRS;
      let allPositions = [];

      // Bybit requires fetching positions one pair at a time
      for (const p of pairs) {
        try {
          const positions = await this.exchange.fetchPositions([this._toLinear(p)]);
          allPositions = allPositions.concat(positions);
        } catch (err) {
          logger.warn(`fetchOpenPositions(${p}): ${err.message}`);
        }
      }

      // Filter: use Math.abs to catch both longs (positive) and shorts (negative)
      const open = allPositions.filter((p) => Math.abs(p.contracts) > 0);
      if (open.length > 0) {
        logger.info(`fetchOpenPositions: ${allPositions.length} raw, ${open.length} open`);
      }
      return open;
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
