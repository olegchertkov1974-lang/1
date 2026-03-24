/**
 * Dip Catcher Strategy
 *
 * Identifies price dips using RSI oversold conditions combined with
 * Bollinger Band lower band touches. Sells when RSI becomes overbought.
 */
module.exports = {
  name: 'dip_catcher',
  description: 'Catches price dips using RSI and Bollinger Bands',
  defaultConfig: {
    rsiPeriod: 14,
    rsiBuyThreshold: 30,
    rsiSellThreshold: 70,
    bbPeriod: 20,
    bbStdDev: 2
  },

  evaluate(context) {
    const { indicators, candles, config = {} } = context;
    const rsiBuyThreshold = config.rsiBuyThreshold || 30;
    const rsiSellThreshold = config.rsiSellThreshold || 70;

    if (!indicators.rsi || !indicators.bollingerBands) {
      return { signal: 'hold', reason: 'Insufficient indicator data' };
    }

    const currentRsi = indicators.rsi[indicators.rsi.length - 1];
    const currentBB = indicators.bollingerBands[indicators.bollingerBands.length - 1];
    const currentPrice = candles[candles.length - 1].close;
    const prevPrice = candles[candles.length - 2].close;

    // Buy signal: RSI oversold + price near or below lower Bollinger Band
    if (currentRsi <= rsiBuyThreshold && currentPrice <= currentBB.lower * 1.02) {
      return {
        signal: 'buy',
        price: currentPrice,
        reason: `RSI oversold (${currentRsi.toFixed(1)}) + price near lower BB`,
        indicators: {
          rsi: currentRsi,
          bbLower: currentBB.lower,
          bbUpper: currentBB.upper
        }
      };
    }

    // Sell signal: RSI overbought
    if (currentRsi >= rsiSellThreshold && currentPrice >= currentBB.upper * 0.98) {
      return {
        signal: 'sell',
        price: currentPrice,
        reason: `RSI overbought (${currentRsi.toFixed(1)}) + price near upper BB`,
        indicators: {
          rsi: currentRsi,
          bbLower: currentBB.lower,
          bbUpper: currentBB.upper
        }
      };
    }

    return { signal: 'hold', price: currentPrice };
  }
};
