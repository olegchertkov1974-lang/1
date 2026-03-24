/**
 * DCA Dipper Strategy
 *
 * Dollar-Cost Averaging strategy for long-term investing.
 * Buys at regular intervals, increasing position size during dips.
 * Uses EMA crossovers and RSI for timing entries.
 */
module.exports = {
  name: 'dca_dipper',
  description: 'Dollar-Cost Averaging with dip detection for long-term investing',
  defaultConfig: {
    emaFastPeriod: 12,
    emaSlowPeriod: 26,
    rsiThreshold: 40,
    dipMultiplier: 2.0, // Buy 2x during dips
    baseAmount: 100     // Base buy amount in quote currency
  },

  evaluate(context) {
    const { indicators, candles, config = {} } = context;
    const rsiThreshold = config.rsiThreshold || 40;

    if (!indicators.rsi || !indicators.emaFast || !indicators.emaSlow) {
      return { signal: 'hold', reason: 'Insufficient indicator data' };
    }

    const currentRsi = indicators.rsi[indicators.rsi.length - 1];
    const currentPrice = candles[candles.length - 1].close;
    const emaFast = indicators.emaFast[indicators.emaFast.length - 1];
    const emaSlow = indicators.emaSlow[indicators.emaSlow.length - 1];
    const prevEmaFast = indicators.emaFast[indicators.emaFast.length - 2];
    const prevEmaSlow = indicators.emaSlow[indicators.emaSlow.length - 2];

    const isDip = currentRsi < rsiThreshold;
    const isBullishCross = prevEmaFast <= prevEmaSlow && emaFast > emaSlow;
    const isBearishCross = prevEmaFast >= prevEmaSlow && emaFast < emaSlow;

    // Strong buy: dip detected (low RSI)
    if (isDip) {
      return {
        signal: 'buy',
        price: currentPrice,
        reason: `DCA dip buy - RSI at ${currentRsi.toFixed(1)}, multiplied position`,
        multiplier: config.dipMultiplier || 2.0,
        indicators: { rsi: currentRsi, emaFast, emaSlow }
      };
    }

    // Regular buy: bullish EMA crossover
    if (isBullishCross) {
      return {
        signal: 'buy',
        price: currentPrice,
        reason: 'DCA regular buy - bullish EMA crossover',
        multiplier: 1.0,
        indicators: { rsi: currentRsi, emaFast, emaSlow }
      };
    }

    // Take profit signal on bearish cross with high RSI
    if (isBearishCross && currentRsi > 70) {
      return {
        signal: 'sell',
        price: currentPrice,
        reason: `Take profit - bearish cross with RSI ${currentRsi.toFixed(1)}`,
        indicators: { rsi: currentRsi, emaFast, emaSlow }
      };
    }

    return { signal: 'hold', price: currentPrice };
  }
};
