const ccxt = require('ccxt');

class ExchangeManager {
  constructor() {
    this.exchanges = new Map();
  }

  addExchange(id, exchangeId, config = {}) {
    if (!ccxt[exchangeId]) {
      throw new Error(`Exchange "${exchangeId}" is not supported by CCXT`);
    }

    const exchange = new ccxt[exchangeId]({
      ...config,
      enableRateLimit: true,
    });

    this.exchanges.set(id, {
      instance: exchange,
      exchangeId,
      config,
    });

    return exchange;
  }

  getExchange(id) {
    const entry = this.exchanges.get(id);
    if (!entry) {
      throw new Error(`Exchange "${id}" not found`);
    }
    return entry.instance;
  }

  getExchangeIds() {
    return Array.from(this.exchanges.keys());
  }

  async fetchTicker(exchangeId, symbol) {
    const exchange = this.getExchange(exchangeId);
    return exchange.fetchTicker(symbol);
  }

  async fetchTickers(exchangeId, symbols = undefined) {
    const exchange = this.getExchange(exchangeId);
    return exchange.fetchTickers(symbols);
  }

  async fetchOHLCV(exchangeId, symbol, timeframe = '1h', limit = 100) {
    const exchange = this.getExchange(exchangeId);
    if (!exchange.has.fetchOHLCV) {
      throw new Error(`Exchange "${exchangeId}" does not support OHLCV data`);
    }
    return exchange.fetchOHLCV(symbol, timeframe, undefined, limit);
  }

  async fetchOrderBook(exchangeId, symbol, limit = 20) {
    const exchange = this.getExchange(exchangeId);
    return exchange.fetchOrderBook(symbol, limit);
  }

  async createOrder(exchangeId, symbol, type, side, amount, price = undefined) {
    const exchange = this.getExchange(exchangeId);
    return exchange.createOrder(symbol, type, side, amount, price);
  }

  async cancelOrder(exchangeId, orderId, symbol = undefined) {
    const exchange = this.getExchange(exchangeId);
    return exchange.cancelOrder(orderId, symbol);
  }

  async fetchOpenOrders(exchangeId, symbol = undefined) {
    const exchange = this.getExchange(exchangeId);
    return exchange.fetchOpenOrders(symbol);
  }

  async fetchBalance(exchangeId) {
    const exchange = this.getExchange(exchangeId);
    return exchange.fetchBalance();
  }

  async fetchMarkets(exchangeId) {
    const exchange = this.getExchange(exchangeId);
    return exchange.loadMarkets();
  }

  getSupportedExchanges() {
    return ccxt.exchanges;
  }

  removeExchange(id) {
    this.exchanges.delete(id);
  }
}

module.exports = { ExchangeManager };
