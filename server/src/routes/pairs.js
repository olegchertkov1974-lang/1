const express = require('express');
const router = express.Router();

// GET /api/pairs/exchanges - List supported exchanges
router.get('/exchanges', (req, res) => {
  const { exchangeManager } = req.app.locals;
  res.json({ exchanges: exchangeManager.getSupportedExchanges() });
});

// POST /api/pairs/exchange - Add/configure an exchange
router.post('/exchange', async (req, res) => {
  const { exchangeManager, db } = req.app.locals;
  const { id, exchangeId, apiKey, secret, sandbox = true } = req.body;

  if (!id || !exchangeId) {
    return res.status(400).json({ error: 'id and exchangeId are required' });
  }

  try {
    const config = {};
    if (apiKey) config.apiKey = apiKey;
    if (secret) config.secret = secret;
    if (sandbox) config.sandbox = true;

    exchangeManager.addExchange(id, exchangeId, config);

    // Persist to database
    db.prepare(`
      INSERT OR REPLACE INTO exchanges (id, name, config, enabled)
      VALUES (?, ?, ?, 1)
    `).run(id, exchangeId, JSON.stringify({ sandbox }));

    res.json({ status: 'added', id, exchangeId });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/pairs/markets/:exchangeId - List available markets
router.get('/markets/:exchangeId', async (req, res) => {
  const { exchangeManager } = req.app.locals;

  try {
    const markets = await exchangeManager.fetchMarkets(req.params.exchangeId);
    const pairs = Object.keys(markets).map(symbol => ({
      symbol,
      base: markets[symbol].base,
      quote: markets[symbol].quote,
      active: markets[symbol].active
    }));
    res.json({ pairs });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pairs/ticker/:exchangeId/:symbol - Get ticker for a pair
router.get('/ticker/:exchangeId/:symbol', async (req, res) => {
  const { exchangeManager, tickerRepo } = req.app.locals;
  const { exchangeId, symbol } = req.params;
  const decodedSymbol = decodeURIComponent(symbol);

  try {
    const ticker = await exchangeManager.fetchTicker(exchangeId, decodedSymbol);
    tickerRepo.save(exchangeId, decodedSymbol, ticker);

    res.json({
      exchange: exchangeId,
      symbol: decodedSymbol,
      price: ticker.last,
      bid: ticker.bid,
      ask: ticker.ask,
      high: ticker.high,
      low: ticker.low,
      volume: ticker.baseVolume,
      changePercent: ticker.percentage,
      timestamp: ticker.timestamp
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pairs/candles/:exchangeId/:symbol - Get OHLCV candles
router.get('/candles/:exchangeId/:symbol', async (req, res) => {
  const { exchangeManager, candleRepo } = req.app.locals;
  const { exchangeId, symbol } = req.params;
  const { timeframe = '1h', limit = 100 } = req.query;
  const decodedSymbol = decodeURIComponent(symbol);

  try {
    const ohlcv = await exchangeManager.fetchOHLCV(exchangeId, decodedSymbol, timeframe, parseInt(limit));
    const candles = ohlcv.map(c => ({
      timestamp: new Date(c[0]).toISOString(),
      open: c[1],
      high: c[2],
      low: c[3],
      close: c[4],
      volume: c[5]
    }));

    // Save to database
    for (const candle of candles) {
      candleRepo.save(exchangeId, decodedSymbol, timeframe, candle);
    }

    res.json({ exchange: exchangeId, symbol: decodedSymbol, timeframe, candles });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pairs/orderbook/:exchangeId/:symbol - Get order book
router.get('/orderbook/:exchangeId/:symbol', async (req, res) => {
  const { exchangeManager } = req.app.locals;
  const { exchangeId, symbol } = req.params;
  const { limit = 20 } = req.query;

  try {
    const orderbook = await exchangeManager.fetchOrderBook(
      exchangeId, decodeURIComponent(symbol), parseInt(limit)
    );
    res.json(orderbook);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/pairs/signals/:exchangeId/:symbol - Get signals for a pair
router.get('/signals/:exchangeId/:symbol', (req, res) => {
  const { tradeRepo } = req.app.locals;
  const { exchangeId, symbol } = req.params;

  try {
    const signals = tradeRepo.getSignalsByPair(exchangeId, decodeURIComponent(symbol));
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
