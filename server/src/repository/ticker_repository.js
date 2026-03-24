class TickerRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO tickers (exchange, symbol, price, bid, ask, volume, change_percent, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
    `);
  }

  save(exchange, symbol, ticker) {
    this.insertStmt.run(
      exchange,
      symbol,
      ticker.last || 0,
      ticker.bid || 0,
      ticker.ask || 0,
      ticker.baseVolume || 0,
      ticker.percentage || 0
    );
  }

  getLatest(exchange, symbol) {
    return this.db.prepare(`
      SELECT * FROM tickers
      WHERE exchange = ? AND symbol = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(exchange, symbol);
  }

  getAll() {
    return this.db.prepare(`
      SELECT t1.* FROM tickers t1
      INNER JOIN (
        SELECT exchange, symbol, MAX(timestamp) as max_ts
        FROM tickers GROUP BY exchange, symbol
      ) t2 ON t1.exchange = t2.exchange AND t1.symbol = t2.symbol AND t1.timestamp = t2.max_ts
      ORDER BY t1.symbol
    `).all();
  }

  getHistory(exchange, symbol, limit = 100) {
    return this.db.prepare(`
      SELECT * FROM tickers
      WHERE exchange = ? AND symbol = ?
      ORDER BY timestamp DESC LIMIT ?
    `).all(exchange, symbol, limit);
  }

  cleanup(daysToKeep = 7) {
    return this.db.prepare(`
      DELETE FROM tickers WHERE timestamp < datetime('now', ?)
    `).run(`-${daysToKeep} days`);
  }
}

module.exports = { TickerRepository };
