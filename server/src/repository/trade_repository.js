class TradeRepository {
  constructor(db) {
    this.db = db;
  }

  create(trade) {
    const stmt = this.db.prepare(`
      INSERT INTO trades (exchange, symbol, side, type, amount, price, cost, fee, status, order_id, strategy)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    const result = stmt.run(
      trade.exchange, trade.symbol, trade.side, trade.type,
      trade.amount, trade.price, trade.cost || 0, trade.fee || 0,
      trade.status || 'open', trade.orderId || null, trade.strategy || null
    );
    return result.lastInsertRowid;
  }

  updateStatus(id, status, pnl = null) {
    if (pnl !== null) {
      this.db.prepare(`
        UPDATE trades SET status = ?, pnl = ?, closed_at = datetime('now') WHERE id = ?
      `).run(status, pnl, id);
    } else {
      this.db.prepare(`
        UPDATE trades SET status = ? WHERE id = ?
      `).run(status, id);
    }
  }

  getOpen() {
    return this.db.prepare(`
      SELECT * FROM trades WHERE status = 'open' ORDER BY created_at DESC
    `).all();
  }

  getAll(limit = 50, offset = 0) {
    return this.db.prepare(`
      SELECT * FROM trades ORDER BY created_at DESC LIMIT ? OFFSET ?
    `).all(limit, offset);
  }

  getBySymbol(exchange, symbol, limit = 50) {
    return this.db.prepare(`
      SELECT * FROM trades WHERE exchange = ? AND symbol = ? ORDER BY created_at DESC LIMIT ?
    `).all(exchange, symbol, limit);
  }

  getStats() {
    const stats = this.db.prepare(`
      SELECT
        COUNT(*) as total_trades,
        SUM(CASE WHEN status = 'closed' AND pnl > 0 THEN 1 ELSE 0 END) as winning_trades,
        SUM(CASE WHEN status = 'closed' AND pnl <= 0 THEN 1 ELSE 0 END) as losing_trades,
        SUM(CASE WHEN status = 'closed' THEN pnl ELSE 0 END) as total_pnl,
        AVG(CASE WHEN status = 'closed' THEN pnl ELSE NULL END) as avg_pnl,
        COUNT(CASE WHEN status = 'open' THEN 1 END) as open_trades
      FROM trades
    `).get();
    return stats;
  }

  // Positions
  openPosition(position) {
    const stmt = this.db.prepare(`
      INSERT OR REPLACE INTO positions (exchange, symbol, side, entry_price, amount, current_price, strategy, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, 'open')
    `);
    const result = stmt.run(
      position.exchange, position.symbol, position.side,
      position.entryPrice, position.amount, position.entryPrice,
      position.strategy || null
    );
    return result.lastInsertRowid;
  }

  updatePosition(id, currentPrice) {
    const pos = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
    if (!pos) return;

    const pnl = pos.side === 'long'
      ? (currentPrice - pos.entry_price) * pos.amount
      : (pos.entry_price - currentPrice) * pos.amount;
    const pnlPercent = ((currentPrice - pos.entry_price) / pos.entry_price) * 100 *
      (pos.side === 'long' ? 1 : -1);

    this.db.prepare(`
      UPDATE positions SET current_price = ?, pnl = ?, pnl_percent = ? WHERE id = ?
    `).run(currentPrice, pnl, pnlPercent, id);
  }

  closePosition(id, closePrice) {
    const pos = this.db.prepare('SELECT * FROM positions WHERE id = ?').get(id);
    if (!pos) return;

    const pnl = pos.side === 'long'
      ? (closePrice - pos.entry_price) * pos.amount
      : (pos.entry_price - closePrice) * pos.amount;
    const pnlPercent = ((closePrice - pos.entry_price) / pos.entry_price) * 100 *
      (pos.side === 'long' ? 1 : -1);

    this.db.prepare(`
      UPDATE positions SET status = 'closed', current_price = ?, pnl = ?, pnl_percent = ?, closed_at = datetime('now')
      WHERE id = ?
    `).run(closePrice, pnl, pnlPercent, id);
  }

  getOpenPositions() {
    return this.db.prepare(`
      SELECT * FROM positions WHERE status = 'open' ORDER BY opened_at DESC
    `).all();
  }

  getAllPositions(limit = 50) {
    return this.db.prepare(`
      SELECT * FROM positions ORDER BY opened_at DESC LIMIT ?
    `).all(limit);
  }

  // Signals
  saveSignal(exchange, symbol, strategy, signal) {
    this.db.prepare(`
      INSERT INTO signals (exchange, symbol, strategy, signal, price, indicators)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      exchange, symbol, strategy, signal.signal,
      signal.price || 0,
      JSON.stringify(signal.indicators || {})
    );
  }

  getRecentSignals(limit = 50) {
    return this.db.prepare(`
      SELECT * FROM signals ORDER BY created_at DESC LIMIT ?
    `).all(limit);
  }

  getSignalsByPair(exchange, symbol, limit = 20) {
    return this.db.prepare(`
      SELECT * FROM signals WHERE exchange = ? AND symbol = ? ORDER BY created_at DESC LIMIT ?
    `).all(exchange, symbol, limit);
  }
}

module.exports = { TradeRepository };
