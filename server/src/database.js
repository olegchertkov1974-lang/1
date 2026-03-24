const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dataDir = path.join(__dirname, '..', 'data');
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

const db = new Database(path.join(dataDir, 'trading_bot.db'));

// Enable WAL mode for better concurrent read performance
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// Create tables
db.exec(`
  CREATE TABLE IF NOT EXISTS exchanges (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    config TEXT DEFAULT '{}',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tickers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    price REAL NOT NULL,
    bid REAL,
    ask REAL,
    volume REAL,
    change_percent REAL,
    timestamp TEXT DEFAULT (datetime('now')),
    UNIQUE(exchange, symbol, timestamp)
  );

  CREATE TABLE IF NOT EXISTS candles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    timeframe TEXT NOT NULL,
    open REAL NOT NULL,
    high REAL NOT NULL,
    low REAL NOT NULL,
    close REAL NOT NULL,
    volume REAL NOT NULL,
    timestamp TEXT NOT NULL,
    UNIQUE(exchange, symbol, timeframe, timestamp)
  );

  CREATE TABLE IF NOT EXISTS trades (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('buy', 'sell')),
    type TEXT NOT NULL CHECK(type IN ('market', 'limit', 'stop')),
    amount REAL NOT NULL,
    price REAL,
    cost REAL,
    fee REAL DEFAULT 0,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed', 'canceled')),
    order_id TEXT,
    strategy TEXT,
    pnl REAL,
    created_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    side TEXT NOT NULL CHECK(side IN ('long', 'short')),
    entry_price REAL NOT NULL,
    amount REAL NOT NULL,
    current_price REAL,
    pnl REAL DEFAULT 0,
    pnl_percent REAL DEFAULT 0,
    strategy TEXT,
    status TEXT DEFAULT 'open' CHECK(status IN ('open', 'closed')),
    opened_at TEXT DEFAULT (datetime('now')),
    closed_at TEXT,
    UNIQUE(exchange, symbol, side, status)
  );

  CREATE TABLE IF NOT EXISTS signals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    exchange TEXT NOT NULL,
    symbol TEXT NOT NULL,
    strategy TEXT NOT NULL,
    signal TEXT NOT NULL CHECK(signal IN ('buy', 'sell', 'close', 'hold')),
    price REAL,
    indicators TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS strategy_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    config TEXT NOT NULL DEFAULT '{}',
    enabled INTEGER DEFAULT 0,
    pairs TEXT DEFAULT '[]',
    exchange TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tickers_symbol ON tickers(exchange, symbol);
  CREATE INDEX IF NOT EXISTS idx_candles_lookup ON candles(exchange, symbol, timeframe);
  CREATE INDEX IF NOT EXISTS idx_trades_symbol ON trades(exchange, symbol);
  CREATE INDEX IF NOT EXISTS idx_trades_status ON trades(status);
  CREATE INDEX IF NOT EXISTS idx_positions_status ON positions(status);
  CREATE INDEX IF NOT EXISTS idx_signals_lookup ON signals(exchange, symbol, strategy);
`);

module.exports = db;
