const schedule = require('node-schedule');
const path = require('path');
const fs = require('fs');
const { TechnicalAnalysis } = require('../ta');
const { StrategyEngine } = require('./strategy_engine');

class BotRunner {
  constructor(exchangeManager, tickerRepo, candleRepo, tradeRepo, notificationService, io) {
    this.exchangeManager = exchangeManager;
    this.tickerRepo = tickerRepo;
    this.candleRepo = candleRepo;
    this.tradeRepo = tradeRepo;
    this.notificationService = notificationService;
    this.io = io;
    this.ta = new TechnicalAnalysis();
    this.strategyEngine = new StrategyEngine();
    this.jobs = new Map();
    this.running = false;
    this.activePairs = new Map(); // exchange:symbol -> { strategy, config }
  }

  async init() {
    // Load built-in strategies
    this.strategyEngine.loadBuiltinStrategies();

    // Load custom strategies from var/strategies
    const strategiesDir = path.join(__dirname, '..', '..', '..', 'var', 'strategies');
    if (fs.existsSync(strategiesDir)) {
      this.strategyEngine.loadCustomStrategies(strategiesDir);
    }

    console.log(`Loaded ${this.strategyEngine.getStrategyNames().length} strategies:`,
      this.strategyEngine.getStrategyNames().join(', '));
  }

  async start(configs) {
    if (this.running) {
      console.log('Bot runner is already running');
      return;
    }

    this.running = true;

    for (const config of configs) {
      await this.addPair(config);
    }

    // Schedule ticker collection every 30 seconds
    this.jobs.set('ticker_collector', schedule.scheduleJob('*/30 * * * * *', async () => {
      await this.collectTickers();
    }));

    // Schedule candle collection every 5 minutes
    this.jobs.set('candle_collector', schedule.scheduleJob('*/5 * * * *', async () => {
      await this.collectCandles();
    }));

    // Schedule strategy evaluation every minute
    this.jobs.set('strategy_runner', schedule.scheduleJob('* * * * *', async () => {
      await this.evaluateStrategies();
    }));

    console.log('Bot runner started');
  }

  async stop() {
    this.running = false;
    for (const [name, job] of this.jobs) {
      job.cancel();
    }
    this.jobs.clear();
    this.activePairs.clear();
    console.log('Bot runner stopped');
  }

  async addPair(config) {
    const { exchange, symbol, strategy, strategyConfig = {} } = config;
    const key = `${exchange}:${symbol}`;
    this.activePairs.set(key, { strategy, config: strategyConfig });
    console.log(`Added pair ${key} with strategy "${strategy}"`);
  }

  removePair(exchange, symbol) {
    const key = `${exchange}:${symbol}`;
    this.activePairs.delete(key);
    console.log(`Removed pair ${key}`);
  }

  async collectTickers() {
    for (const [key] of this.activePairs) {
      const [exchangeId, symbol] = key.split(':');
      try {
        const ticker = await this.exchangeManager.fetchTicker(exchangeId, symbol);
        this.tickerRepo.save(exchangeId, symbol, ticker);

        // Emit real-time update
        this.io.to(`ticker:${symbol}`).emit('ticker:update', {
          exchange: exchangeId,
          symbol,
          price: ticker.last,
          bid: ticker.bid,
          ask: ticker.ask,
          volume: ticker.baseVolume,
          changePercent: ticker.percentage,
          timestamp: new Date().toISOString()
        });
      } catch (err) {
        console.error(`Failed to fetch ticker for ${key}:`, err.message);
      }
    }
  }

  async collectCandles() {
    for (const [key] of this.activePairs) {
      const [exchangeId, symbol] = key.split(':');
      try {
        const ohlcv = await this.exchangeManager.fetchOHLCV(exchangeId, symbol, '1h', 200);
        for (const candle of ohlcv) {
          this.candleRepo.save(exchangeId, symbol, '1h', {
            timestamp: new Date(candle[0]).toISOString(),
            open: candle[1],
            high: candle[2],
            low: candle[3],
            close: candle[4],
            volume: candle[5]
          });
        }
      } catch (err) {
        console.error(`Failed to fetch candles for ${key}:`, err.message);
      }
    }
  }

  async evaluateStrategies() {
    for (const [key, pairConfig] of this.activePairs) {
      const [exchangeId, symbol] = key.split(':');
      try {
        const candles = this.candleRepo.getRecent(exchangeId, symbol, '1h', 200);
        if (candles.length < 50) continue;

        const closes = candles.map(c => c.close);
        const highs = candles.map(c => c.high);
        const lows = candles.map(c => c.low);
        const volumes = candles.map(c => c.volume);

        // Calculate indicators
        const indicators = this.ta.calculate(closes, highs, lows, volumes);

        // Run strategy
        const strategy = this.strategyEngine.getStrategy(pairConfig.strategy);
        if (!strategy) {
          console.error(`Strategy "${pairConfig.strategy}" not found`);
          continue;
        }

        const signal = strategy.evaluate({
          exchange: exchangeId,
          symbol,
          candles,
          indicators,
          config: pairConfig.config
        });

        if (signal && signal.signal !== 'hold') {
          console.log(`Signal: ${signal.signal} for ${key} (${pairConfig.strategy})`);

          // Save signal
          this.tradeRepo.saveSignal(exchangeId, symbol, pairConfig.strategy, signal);

          // Notify
          this.notificationService.send(
            `${signal.signal.toUpperCase()} signal for ${symbol} on ${exchangeId}\n` +
            `Price: ${signal.price}\nStrategy: ${pairConfig.strategy}`
          );

          // Emit signal via WebSocket
          this.io.emit('signal:new', {
            exchange: exchangeId,
            symbol,
            strategy: pairConfig.strategy,
            ...signal
          });
        }
      } catch (err) {
        console.error(`Strategy evaluation failed for ${key}:`, err.message);
      }
    }
  }

  getStatus() {
    return {
      running: this.running,
      activePairs: Array.from(this.activePairs.entries()).map(([key, config]) => ({
        pair: key,
        strategy: config.strategy
      })),
      jobs: Array.from(this.jobs.keys())
    };
  }
}

module.exports = { BotRunner };
