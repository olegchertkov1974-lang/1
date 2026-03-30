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

// Список пар определяется в bot.js — здесь ограничений нет
const ALLOWED_PAIRS = [];
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
    if (!pair || !pair.endsWith('/USDT')) {
      throw new Error(`Pair ${pair} is not valid. Only USDT pairs are supported.`);
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
   * Разместить Limit PostOnly ордер (вход в позицию).
   * PostOnly гарантирует maker-комиссию 0.02%. Если цена ушла и ордер
   * стал бы taker — биржа его автоматически отменит.
   *
   * SL и TP ставятся ОТДЕЛЬНО после исполнения через setTradingStop().
   * Это надёжнее, чем прикреплять к ордеру (Bybit может игнорировать
   * attached SL/TP на limit ордерах).
   *
   * @param {string} pair — торговая пара
   * @param {string} side — 'buy' или 'sell'
   * @param {number} amount — объём
   * @param {number} limitPrice — цена лимитного ордера
   * @param {boolean} postOnly — PostOnly режим (по умолчанию true)
   * @returns {object} ордер с id, status, type
   */
  async placeOrder(pair, side, amount, stopLoss, takeProfit, limitPrice, postOnly = true) {
    this.validatePair(pair);

    return this._retry(async () => {
      const params = {};

      // PostOnly — гарантия maker-комиссии (ордер отменится если станет taker)
      if (postOnly && limitPrice) {
        params.timeInForce = 'PostOnly';
      }

      // SL/TP прикрепляем к ордеру как fallback (основной путь — setTradingStop после fill)
      // SL всегда Stop Market — гарантия исполнения
      if (stopLoss) params.stopLoss = { triggerPrice: stopLoss, type: 'market' };
      // TP — тоже ставим сразу, Bybit сам сделает limit
      if (takeProfit) params.takeProfit = { triggerPrice: takeProfit, type: 'limit' };

      const orderType = limitPrice ? 'limit' : 'market';
      const price = limitPrice || undefined;

      logger.info(
        `Ордер ${orderType}${postOnly ? ' PostOnly' : ''} ${side}: ` +
        `${pair} объём=${amount} цена=${limitPrice || 'market'} ` +
        `SL=${stopLoss} (Stop Market) TP=${takeProfit} (Limit)`
      );

      const order = await this.exchange.createOrder(
        this._toLinear(pair), orderType, side, amount, price, params
      );

      logger.info(`Ордер размещён: ${order.id} (${orderType}${postOnly ? ' PostOnly' : ''}) статус=${order.status}`);
      return order;
    }, `placeOrder(${pair}, ${side})`);
  }

  /**
   * Установить/обновить SL и TP на открытой позиции через Bybit Trading Stop API.
   *
   * Используется:
   * 1. После исполнения лимитного ордера — установка SL/TP
   * 2. Перенос SL в безубыток после 1R
   *
   * SL — Stop Market (гарантия исполнения).
   * TP — Limit (PostOnly maker-комиссия).
   *
   * @param {string} pair — торговая пара
   * @param {object} opts — { stopLoss, takeProfit, side }
   */
  async setTradingStop(pair, opts = {}) {
    this.validatePair(pair);
    const symbol = this._toLinear(pair);

    return this._retry(async () => {
      const params = {
        category: 'linear',
        symbol: pair.replace('/', ''),  // BTCUSDT
        positionIdx: 0,                 // one-way mode
        tpSlMode: 'Full',               // обязательно для tpOrderType/slOrderType
      };

      if (opts.stopLoss) {
        params.stopLoss = String(opts.stopLoss);
        params.slTriggerBy = 'LastPrice';
        params.slOrderType = 'Market';  // Stop Market — гарантия исполнения
      }

      if (opts.takeProfit) {
        params.takeProfit = String(opts.takeProfit);
        params.tpTriggerBy = 'LastPrice';
        params.tpOrderType = 'Limit';       // Limit TP — maker-комиссия
        params.tpLimitPrice = String(opts.takeProfit); // обязательное поле для Limit TP
      }

      logger.info(
        `setTradingStop ${pair}: ` +
        `SL=${opts.stopLoss || '—'} (Stop Market) ` +
        `TP=${opts.takeProfit || '—'} (Limit)`
      );

      const response = await this.exchange.privatePostV5PositionTradingStop(params);
      const retCode = response?.retCode ?? response?.ret_code;

      if (retCode !== undefined && retCode !== 0) {
        throw new Error(`setTradingStop: retCode=${retCode} msg=${response?.retMsg || response?.ret_msg || '?'}`);
      }

      logger.info(`setTradingStop ${pair}: OK`);
      return response;
    }, `setTradingStop(${pair})`);
  }

  /**
   * Закрыть позицию рыночным ордером.
   */
  async closePosition(pair, side, amount) {
    this.validatePair(pair);
    const closeSide = side === 'long' ? 'sell' : 'buy';

    return this._retry(async () => {
      logger.info(`Закрытие ${side} позиции: ${pair} объём=${amount}`);
      const order = await this.exchange.createOrder(this._toLinear(pair), 'market', closeSide, amount, undefined, {
        reduceOnly: true,
      });
      logger.info(`Позиция закрыта: ${order.id}`);
      return order;
    }, `closePosition(${pair})`);
  }

  /**
   * Отменить открытый ордер.
   */
  async cancelOrder(orderId, pair) {
    return this._retry(async () => {
      logger.info(`Отмена ордера ${orderId} на ${pair}`);
      await this.exchange.cancelOrder(orderId, this._toLinear(pair));
      logger.info(`Ордер ${orderId} отменён`);
    }, `cancelOrder(${pair})`);
  }

  /**
   * Проверить статус ордера (open, closed, canceled).
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

  /**
   * Получить историю исполнений (execution list) за период.
   * Используется для подсчёта комиссий.
   * @param {string} startTime — ISO timestamp
   * @param {string} endTime — ISO timestamp
   */
  async fetchExecutions(startTime, endTime) {
    return this._retry(async () => {
      const params = {
        category: 'linear',
        limit: 100,
      };
      if (startTime) params.startTime = String(new Date(startTime).getTime());
      if (endTime) params.endTime = String(new Date(endTime).getTime());

      const response = await this.exchange.privateGetV5ExecutionList(params);
      const list = response?.result?.list || [];
      return list.map(e => ({
        symbol: e.symbol,
        side: e.side,
        execType: e.execType,
        execQty: parseFloat(e.execQty || '0'),
        execPrice: parseFloat(e.execPrice || '0'),
        execFee: parseFloat(e.execFee || '0'),
        feeRate: parseFloat(e.feeRate || '0'),
        isMaker: e.isMaker === 'true' || e.isMaker === true,
        execTime: parseInt(e.execTime || '0'),
        orderId: e.orderId,
      }));
    }, 'fetchExecutions');
  }
}

module.exports = BybitExchange;
