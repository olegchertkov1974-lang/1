/**
 * MACD Trend Strategy
 *
 * Follows trends using MACD crossovers confirmed by volume analysis.
 * Enters on MACD line crossing above signal line with increasing volume.
 */
module.exports = {
  name: 'macd_trend',
  description: 'Trend following using MACD crossovers with volume confirmation',
  defaultConfig: {
    fastPeriod: 12,
    slowPeriod: 26,
    signalPeriod: 9,
    volumeMultiplier: 1.5
  },

  evaluate(context) {
    const { indicators, candles, config = {} } = context;
    const volumeMultiplier = config.volumeMultiplier || 1.5;

    if (!indicators.macd || indicators.macd.length < 2) {
      return { signal: 'hold', reason: 'Insufficient MACD data' };
    }

    const currentPrice = candles[candles.length - 1].close;
    const currentVolume = candles[candles.length - 1].volume;
    const currentMACD = indicators.macd[indicators.macd.length - 1];
    const prevMACD = indicators.macd[indicators.macd.length - 2];

    // Calculate average volume (last 20 candles)
    const recentVolumes = candles.slice(-20).map(c => c.volume);
    const avgVolume = recentVolumes.reduce((a, b) => a + b, 0) / recentVolumes.length;
    const highVolume = currentVolume > avgVolume * volumeMultiplier;

    const isBullishCross = prevMACD.MACD <= prevMACD.signal && currentMACD.MACD > currentMACD.signal;
    const isBearishCross = prevMACD.MACD >= prevMACD.signal && currentMACD.MACD < currentMACD.signal;

    // Buy: MACD bullish crossover with volume confirmation
    if (isBullishCross && highVolume) {
      return {
        signal: 'buy',
        price: currentPrice,
        reason: `MACD bullish crossover with ${(currentVolume / avgVolume).toFixed(1)}x volume`,
        indicators: {
          macd: currentMACD.MACD,
          signal: currentMACD.signal,
          histogram: currentMACD.histogram,
          volumeRatio: currentVolume / avgVolume
        }
      };
    }

    // Sell: MACD bearish crossover
    if (isBearishCross) {
      return {
        signal: 'sell',
        price: currentPrice,
        reason: 'MACD bearish crossover',
        indicators: {
          macd: currentMACD.MACD,
          signal: currentMACD.signal,
          histogram: currentMACD.histogram
        }
      };
    }

    return { signal: 'hold', price: currentPrice };
  }
};
