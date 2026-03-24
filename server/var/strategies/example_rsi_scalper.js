/**
 * Example Custom Strategy: RSI Scalper
 *
 * Place this file in var/strategies/ to load it automatically.
 * Each strategy must export: name, description, defaultConfig, evaluate(context)
 *
 * Context object:
 *   - exchange: exchange ID
 *   - symbol: trading pair
 *   - candles: array of { open, high, low, close, volume, timestamp }
 *   - indicators: calculated technical indicators (RSI, BB, EMA, MACD, etc.)
 *   - config: user-provided configuration merged with defaults
 *
 * Return value:
 *   - { signal: 'buy'|'sell'|'close'|'hold', price, reason, indicators }
 */
module.exports = {
  name: 'rsi_scalper',
  description: 'Quick RSI-based scalping strategy for short timeframes',
  defaultConfig: {
    rsiPeriod: 7,
    rsiBuy: 25,
    rsiSell: 75,
    takeProfit: 1.5,  // 1.5% take profit
    stopLoss: 1.0     // 1% stop loss
  },

  evaluate(context) {
    const { indicators, candles, config = {} } = context;
    const rsiBuy = config.rsiBuy || 25;
    const rsiSell = config.rsiSell || 75;

    if (!indicators.rsi || indicators.rsi.length < 2) {
      return { signal: 'hold', reason: 'Waiting for RSI data' };
    }

    const currentRsi = indicators.rsi[indicators.rsi.length - 1];
    const prevRsi = indicators.rsi[indicators.rsi.length - 2];
    const currentPrice = candles[candles.length - 1].close;

    // Buy when RSI crosses up from oversold
    if (prevRsi < rsiBuy && currentRsi >= rsiBuy) {
      return {
        signal: 'buy',
        price: currentPrice,
        reason: `RSI crossed up from oversold (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})`,
        indicators: { rsi: currentRsi }
      };
    }

    // Sell when RSI crosses down from overbought
    if (prevRsi > rsiSell && currentRsi <= rsiSell) {
      return {
        signal: 'sell',
        price: currentPrice,
        reason: `RSI crossed down from overbought (${prevRsi.toFixed(1)} -> ${currentRsi.toFixed(1)})`,
        indicators: { rsi: currentRsi }
      };
    }

    return { signal: 'hold', price: currentPrice };
  }
};
