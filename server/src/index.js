require('dotenv').config();
const express = require('express');
const http = require('http');
const cors = require('cors');
const { Server } = require('socket.io');
const path = require('path');

const db = require('./database');
const { ExchangeManager } = require('./modules/exchange/exchange_manager');
const { BotRunner } = require('./modules/strategy/bot_runner');
const { NotificationService } = require('./notify/notification_service');
const { TickerRepository } = require('./repository/ticker_repository');
const { CandleRepository } = require('./repository/candle_repository');
const { TradeRepository } = require('./repository/trade_repository');

const dashboardRoutes = require('./routes/dashboard');
const pairsRoutes = require('./routes/pairs');
const ordersRoutes = require('./routes/orders');
const strategiesRoutes = require('./routes/strategies');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: process.env.CLIENT_URL || 'http://localhost:3000', methods: ['GET', 'POST'] }
});

app.use(cors());
app.use(express.json());

// Repositories
const tickerRepo = new TickerRepository(db);
const candleRepo = new CandleRepository(db);
const tradeRepo = new TradeRepository(db);

// Core services
const exchangeManager = new ExchangeManager();
const notificationService = new NotificationService({
  telegram: {
    token: process.env.TELEGRAM_BOT_TOKEN,
    chatId: process.env.TELEGRAM_CHAT_ID
  },
  slack: {
    webhookUrl: process.env.SLACK_WEBHOOK_URL
  }
});
const botRunner = new BotRunner(exchangeManager, tickerRepo, candleRepo, tradeRepo, notificationService, io);

// Make services available to routes
app.locals.exchangeManager = exchangeManager;
app.locals.botRunner = botRunner;
app.locals.tickerRepo = tickerRepo;
app.locals.candleRepo = candleRepo;
app.locals.tradeRepo = tradeRepo;
app.locals.notificationService = notificationService;
app.locals.io = io;
app.locals.db = db;

// API routes
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/pairs', pairsRoutes);
app.use('/api/orders', ordersRoutes);
app.use('/api/strategies', strategiesRoutes);

// Health check
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// Socket.IO for real-time updates
io.on('connection', (socket) => {
  console.log('Client connected:', socket.id);

  socket.on('subscribe:ticker', (pair) => {
    socket.join(`ticker:${pair}`);
  });

  socket.on('unsubscribe:ticker', (pair) => {
    socket.leave(`ticker:${pair}`);
  });

  socket.on('disconnect', () => {
    console.log('Client disconnected:', socket.id);
  });
});

const PORT = process.env.PORT || 5000;

server.listen(PORT, () => {
  console.log(`Crypto Trading Bot server running on port ${PORT}`);
  console.log(`Dashboard: http://127.0.0.1:${PORT}`);

  // Initialize exchanges from config
  botRunner.init().catch(err => {
    console.error('Failed to initialize bot runner:', err.message);
  });
});

module.exports = { app, server };
