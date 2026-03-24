# Crypto Trading Bot

A cryptocurrency trading bot with multi-exchange support via CCXT, technical analysis, customizable strategies, and a React dashboard.

> **Not production ready** — for educational and experimental use only. Trade at your own risk.

## Features

- **Multi-exchange support** — 100+ exchanges via [CCXT](https://github.com/ccxt/ccxt)
- **Multiple trading pairs** — run concurrent strategies on different pairs
- **Built-in strategies** — dip_catcher, dca_dipper, macd_trend
- **Custom strategies** — add your own strategies in `server/var/strategies/`
- **Technical indicators** — RSI, Bollinger Bands, EMA, SMA, MACD, Stochastic, ATR, ADX
- **SQLite persistence** — stores candles, tickers, trades, positions, and signals
- **Web dashboard** — React-based UI for monitoring and manual trading
- **Real-time updates** — WebSocket (Socket.IO) for live ticker and signal data
- **Notifications** — Telegram and Slack alerts for signals and trades
- **Backtesting** — simple backtester built into the strategy configuration UI
- **Long & short positions** — track and manage both directions

## Quick Start

```bash
npm run install-all
npm run dev
```

Server: http://127.0.0.1:5000
Dashboard: http://127.0.0.1:3000

## Project Structure

```
├── server/
│   ├── src/
│   │   ├── index.js                    # Express + Socket.IO entry point
│   │   ├── database.js                 # SQLite schema and initialization
│   │   ├── modules/
│   │   │   ├── exchange/
│   │   │   │   └── exchange_manager.js # CCXT exchange wrapper
│   │   │   ├── strategy/
│   │   │   │   ├── bot_runner.js       # Scheduler: tickers, candles, strategy eval
│   │   │   │   ├── strategy_engine.js  # Strategy loader
│   │   │   │   └── builtin/            # Built-in strategies
│   │   │   └── ta.js                   # Technical analysis calculations
│   │   ├── notify/
│   │   │   └── notification_service.js # Telegram + Slack notifications
│   │   ├── repository/                 # Database access layer
│   │   └── routes/                     # REST API endpoints
│   ├── var/strategies/                 # Custom user strategies
│   └── data/                           # SQLite database files
├── client/
│   └── src/
│       ├── pages/                      # Dashboard, Pairs, Orders, Strategies
│       └── services/                   # API client + Socket.IO
└── package.json
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | `/api/dashboard` | Overview: tickers, positions, stats, signals |
| POST | `/api/dashboard/bot/start` | Start the bot runner |
| POST | `/api/dashboard/bot/stop` | Stop the bot runner |
| POST | `/api/dashboard/bot/pair` | Add a trading pair |
| GET | `/api/pairs/exchanges` | List supported exchanges |
| POST | `/api/pairs/exchange` | Configure an exchange |
| GET | `/api/pairs/markets/:id` | List markets for an exchange |
| GET | `/api/pairs/ticker/:id/:symbol` | Get current ticker |
| GET | `/api/pairs/candles/:id/:symbol` | Get OHLCV candles |
| GET | `/api/orders` | List all trades |
| POST | `/api/orders` | Place a manual order |
| GET | `/api/orders/positions` | List positions |
| GET | `/api/strategies` | List available strategies |
| POST | `/api/strategies/:name/config` | Save strategy config |
| POST | `/api/strategies/:name/backtest` | Run backtest |

## Built-in Strategies

### dip_catcher
Catches price dips using RSI oversold conditions + Bollinger Band lower touches. Sells on RSI overbought.

### dca_dipper
Dollar-Cost Averaging for long-term investing. Buys more during dips (low RSI), regular buys on bullish EMA crossovers.

### macd_trend
Trend following using MACD crossovers confirmed by above-average volume.

## Custom Strategies

Create a `.js` file in `server/var/strategies/`:

```js
module.exports = {
  name: 'my_strategy',
  description: 'My custom strategy',
  defaultConfig: { threshold: 30 },

  evaluate(context) {
    const { indicators, candles, config } = context;
    // Your logic here
    return { signal: 'buy', price: candles.at(-1).close, reason: 'Signal triggered' };
  }
};
```

## Notifications

Set environment variables in `.env`:

```
TELEGRAM_BOT_TOKEN=your_bot_token
TELEGRAM_CHAT_ID=your_chat_id
SLACK_WEBHOOK_URL=https://hooks.slack.com/services/...
```

## Tech Stack

- **Backend:** Node.js, Express, Socket.IO, CCXT, better-sqlite3, technicalindicators
- **Frontend:** React 18, React Router, Axios, Socket.IO Client
- **Database:** SQLite with WAL mode

## License

MIT
