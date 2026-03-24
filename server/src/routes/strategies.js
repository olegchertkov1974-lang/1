const express = require('express');
const router = express.Router();

// GET /api/strategies - List all available strategies
router.get('/', (req, res) => {
  const { botRunner, db } = req.app.locals;

  try {
    const available = botRunner.strategyEngine.getAllStrategies();
    const configs = db.prepare('SELECT * FROM strategy_configs ORDER BY name').all();

    res.json({
      available,
      configured: configs.map(c => ({
        ...c,
        config: JSON.parse(c.config),
        pairs: JSON.parse(c.pairs)
      }))
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/strategies/:name - Get strategy details
router.get('/:name', (req, res) => {
  const { botRunner, db } = req.app.locals;
  const { name } = req.params;

  try {
    const strategy = botRunner.strategyEngine.getStrategy(name);
    if (!strategy) {
      return res.status(404).json({ error: `Strategy "${name}" not found` });
    }

    const config = db.prepare('SELECT * FROM strategy_configs WHERE name = ?').get(name);

    res.json({
      name: strategy.name,
      description: strategy.description || '',
      defaultConfig: strategy.defaultConfig || {},
      savedConfig: config ? {
        ...config,
        config: JSON.parse(config.config),
        pairs: JSON.parse(config.pairs)
      } : null
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/strategies/:name/config - Save strategy configuration
router.post('/:name/config', (req, res) => {
  const { db } = req.app.locals;
  const { name } = req.params;
  const { config = {}, pairs = [], exchange, enabled = false } = req.body;

  try {
    db.prepare(`
      INSERT OR REPLACE INTO strategy_configs (name, config, pairs, exchange, enabled, updated_at)
      VALUES (?, ?, ?, ?, ?, datetime('now'))
    `).run(name, JSON.stringify(config), JSON.stringify(pairs), exchange || null, enabled ? 1 : 0);

    res.json({ status: 'saved', name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/strategies/:name/config - Delete strategy configuration
router.delete('/:name/config', (req, res) => {
  const { db } = req.app.locals;
  const { name } = req.params;

  try {
    db.prepare('DELETE FROM strategy_configs WHERE name = ?').run(name);
    res.json({ status: 'deleted', name });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/strategies/:name/backtest - Run a simple backtest
router.post('/:name/backtest', (req, res) => {
  const { botRunner, candleRepo } = req.app.locals;
  const { name } = req.params;
  const { exchange, symbol, timeframe = '1h', config = {} } = req.body;

  if (!exchange || !symbol) {
    return res.status(400).json({ error: 'exchange and symbol are required' });
  }

  try {
    const strategy = botRunner.strategyEngine.getStrategy(name);
    if (!strategy) {
      return res.status(404).json({ error: `Strategy "${name}" not found` });
    }

    const candles = candleRepo.getRecent(exchange, symbol, timeframe, 500);
    if (candles.length < 50) {
      return res.status(400).json({ error: 'Not enough candle data for backtesting (need at least 50 candles)' });
    }

    // Simple backtest: evaluate strategy on historical data
    const signals = [];
    const ta = botRunner.ta;
    let position = null;
    let totalPnl = 0;
    let trades = 0;
    let wins = 0;

    for (let i = 50; i < candles.length; i++) {
      const slice = candles.slice(0, i + 1);
      const closes = slice.map(c => c.close);
      const highs = slice.map(c => c.high);
      const lows = slice.map(c => c.low);
      const volumes = slice.map(c => c.volume);

      const indicators = ta.calculate(closes, highs, lows, volumes);
      const signal = strategy.evaluate({
        exchange, symbol, candles: slice, indicators, config
      });

      if (signal.signal === 'buy' && !position) {
        position = { price: signal.price, timestamp: candles[i].timestamp };
        signals.push({ ...signal, index: i, timestamp: candles[i].timestamp });
      } else if (signal.signal === 'sell' && position) {
        const pnl = ((signal.price - position.price) / position.price) * 100;
        totalPnl += pnl;
        trades++;
        if (pnl > 0) wins++;
        signals.push({ ...signal, index: i, timestamp: candles[i].timestamp, pnl });
        position = null;
      }
    }

    res.json({
      strategy: name,
      pair: `${exchange}:${symbol}`,
      timeframe,
      candleCount: candles.length,
      totalSignals: signals.length,
      totalTrades: trades,
      winRate: trades > 0 ? ((wins / trades) * 100).toFixed(1) : 0,
      totalPnlPercent: totalPnl.toFixed(2),
      signals: signals.slice(-20) // Last 20 signals
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
