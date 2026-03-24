const express = require('express');
const router = express.Router();

// GET /api/dashboard - Overview data
router.get('/', (req, res) => {
  const { tickerRepo, tradeRepo, botRunner } = req.app.locals;

  try {
    const tickers = tickerRepo.getAll();
    const openPositions = tradeRepo.getOpenPositions();
    const openTrades = tradeRepo.getOpen();
    const stats = tradeRepo.getStats();
    const recentSignals = tradeRepo.getRecentSignals(10);
    const botStatus = botRunner.getStatus();

    res.json({
      tickers,
      positions: openPositions,
      openTrades,
      stats,
      recentSignals,
      botStatus
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/dashboard/stats - Trading statistics
router.get('/stats', (req, res) => {
  const { tradeRepo } = req.app.locals;
  try {
    const stats = tradeRepo.getStats();
    res.json(stats);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/bot/start - Start the bot
router.post('/bot/start', async (req, res) => {
  const { botRunner } = req.app.locals;
  const { configs } = req.body;

  try {
    await botRunner.start(configs || []);
    res.json({ status: 'started', ...botRunner.getStatus() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/bot/stop - Stop the bot
router.post('/bot/stop', async (req, res) => {
  const { botRunner } = req.app.locals;

  try {
    await botRunner.stop();
    res.json({ status: 'stopped' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/dashboard/bot/pair - Add a trading pair
router.post('/bot/pair', async (req, res) => {
  const { botRunner } = req.app.locals;
  const { exchange, symbol, strategy, strategyConfig } = req.body;

  if (!exchange || !symbol || !strategy) {
    return res.status(400).json({ error: 'exchange, symbol, and strategy are required' });
  }

  try {
    await botRunner.addPair({ exchange, symbol, strategy, strategyConfig });
    res.json({ status: 'added', pair: `${exchange}:${symbol}` });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/dashboard/bot/pair - Remove a trading pair
router.delete('/bot/pair', (req, res) => {
  const { botRunner } = req.app.locals;
  const { exchange, symbol } = req.body;

  if (!exchange || !symbol) {
    return res.status(400).json({ error: 'exchange and symbol are required' });
  }

  botRunner.removePair(exchange, symbol);
  res.json({ status: 'removed', pair: `${exchange}:${symbol}` });
});

module.exports = router;
