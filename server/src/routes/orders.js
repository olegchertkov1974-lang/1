const express = require('express');
const router = express.Router();

// GET /api/orders - List all trades
router.get('/', (req, res) => {
  const { tradeRepo } = req.app.locals;
  const { limit = 50, offset = 0 } = req.query;

  try {
    const trades = tradeRepo.getAll(parseInt(limit), parseInt(offset));
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/open - List open trades
router.get('/open', (req, res) => {
  const { tradeRepo } = req.app.locals;

  try {
    const trades = tradeRepo.getOpen();
    res.json({ trades });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders - Create a manual order
router.post('/', async (req, res) => {
  const { exchangeManager, tradeRepo, notificationService } = req.app.locals;
  const { exchange, symbol, type, side, amount, price } = req.body;

  if (!exchange || !symbol || !type || !side || !amount) {
    return res.status(400).json({ error: 'exchange, symbol, type, side, and amount are required' });
  }

  if (!['buy', 'sell'].includes(side)) {
    return res.status(400).json({ error: 'side must be "buy" or "sell"' });
  }
  if (!['market', 'limit', 'stop'].includes(type)) {
    return res.status(400).json({ error: 'type must be "market", "limit", or "stop"' });
  }

  try {
    // Place order on exchange
    const order = await exchangeManager.createOrder(exchange, symbol, type, side, parseFloat(amount), price ? parseFloat(price) : undefined);

    // Record in database
    const tradeId = tradeRepo.create({
      exchange,
      symbol,
      side,
      type,
      amount: parseFloat(amount),
      price: order.price || price,
      cost: order.cost || 0,
      fee: order.fee?.cost || 0,
      status: order.status || 'open',
      orderId: order.id
    });

    notificationService.send(
      `Manual ${side.toUpperCase()} order placed: ${amount} ${symbol} on ${exchange} (${type})`
    );

    res.json({ tradeId, order });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// DELETE /api/orders/:id - Cancel an order
router.delete('/:id', async (req, res) => {
  const { exchangeManager, tradeRepo } = req.app.locals;
  const { id } = req.params;

  try {
    const trade = tradeRepo.db.prepare('SELECT * FROM trades WHERE id = ?').get(id);
    if (!trade) {
      return res.status(404).json({ error: 'Trade not found' });
    }

    if (trade.order_id) {
      await exchangeManager.cancelOrder(trade.exchange, trade.order_id, trade.symbol);
    }

    tradeRepo.updateStatus(parseInt(id), 'canceled');
    res.json({ status: 'canceled', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/positions - List positions
router.get('/positions', (req, res) => {
  const { tradeRepo } = req.app.locals;
  const { status } = req.query;

  try {
    const positions = status === 'open'
      ? tradeRepo.getOpenPositions()
      : tradeRepo.getAllPositions();
    res.json({ positions });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/orders/positions - Open a position
router.post('/positions', (req, res) => {
  const { tradeRepo } = req.app.locals;
  const { exchange, symbol, side, entryPrice, amount, strategy } = req.body;

  if (!exchange || !symbol || !side || !entryPrice || !amount) {
    return res.status(400).json({ error: 'exchange, symbol, side, entryPrice, and amount are required' });
  }

  try {
    const id = tradeRepo.openPosition({ exchange, symbol, side, entryPrice: parseFloat(entryPrice), amount: parseFloat(amount), strategy });
    res.json({ id, status: 'opened' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/orders/positions/:id/close - Close a position
router.put('/positions/:id/close', (req, res) => {
  const { tradeRepo, notificationService } = req.app.locals;
  const { id } = req.params;
  const { closePrice } = req.body;

  if (!closePrice) {
    return res.status(400).json({ error: 'closePrice is required' });
  }

  try {
    tradeRepo.closePosition(parseInt(id), parseFloat(closePrice));
    const pos = tradeRepo.db.prepare('SELECT * FROM positions WHERE id = ?').get(parseInt(id));
    if (pos) {
      notificationService.send(
        `Position closed: ${pos.symbol} ${pos.side} | PnL: ${pos.pnl?.toFixed(2)} (${pos.pnl_percent?.toFixed(2)}%)`
      );
    }
    res.json({ status: 'closed', id });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/orders/signals - Recent signals
router.get('/signals', (req, res) => {
  const { tradeRepo } = req.app.locals;
  const { limit = 50 } = req.query;

  try {
    const signals = tradeRepo.getRecentSignals(parseInt(limit));
    res.json({ signals });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
