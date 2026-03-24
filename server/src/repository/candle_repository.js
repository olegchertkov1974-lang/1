class CandleRepository {
  constructor(db) {
    this.db = db;
    this.insertStmt = db.prepare(`
      INSERT OR REPLACE INTO candles (exchange, symbol, timeframe, open, high, low, close, volume, timestamp)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
  }

  save(exchange, symbol, timeframe, candle) {
    this.insertStmt.run(
      exchange, symbol, timeframe,
      candle.open, candle.high, candle.low, candle.close, candle.volume,
      candle.timestamp
    );
  }

  saveBatch(exchange, symbol, timeframe, candles) {
    const transaction = this.db.transaction((items) => {
      for (const candle of items) {
        this.insertStmt.run(
          exchange, symbol, timeframe,
          candle.open, candle.high, candle.low, candle.close, candle.volume,
          candle.timestamp
        );
      }
    });
    transaction(candles);
  }

  getRecent(exchange, symbol, timeframe, limit = 200) {
    return this.db.prepare(`
      SELECT * FROM candles
      WHERE exchange = ? AND symbol = ? AND timeframe = ?
      ORDER BY timestamp ASC
      LIMIT ?
    `).all(exchange, symbol, timeframe, limit);
  }

  getRange(exchange, symbol, timeframe, from, to) {
    return this.db.prepare(`
      SELECT * FROM candles
      WHERE exchange = ? AND symbol = ? AND timeframe = ?
        AND timestamp >= ? AND timestamp <= ?
      ORDER BY timestamp ASC
    `).all(exchange, symbol, timeframe, from, to);
  }

  getLatest(exchange, symbol, timeframe) {
    return this.db.prepare(`
      SELECT * FROM candles
      WHERE exchange = ? AND symbol = ? AND timeframe = ?
      ORDER BY timestamp DESC LIMIT 1
    `).get(exchange, symbol, timeframe);
  }

  cleanup(daysToKeep = 30) {
    return this.db.prepare(`
      DELETE FROM candles WHERE timestamp < datetime('now', ?)
    `).run(`-${daysToKeep} days`);
  }
}

module.exports = { CandleRepository };
