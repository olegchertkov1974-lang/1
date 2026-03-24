const { RSI, BollingerBands, EMA, SMA, MACD, Stochastic, ATR, ADX } = require('technicalindicators');

class TechnicalAnalysis {
  calculate(closes, highs, lows, volumes) {
    const result = {};

    // RSI (14 period)
    try {
      result.rsi = RSI.calculate({ values: closes, period: 14 });
    } catch (e) {
      result.rsi = null;
    }

    // Bollinger Bands (20 period, 2 std dev)
    try {
      result.bollingerBands = BollingerBands.calculate({
        values: closes,
        period: 20,
        stdDev: 2
      });
    } catch (e) {
      result.bollingerBands = null;
    }

    // EMA Fast (12) and Slow (26)
    try {
      result.emaFast = EMA.calculate({ values: closes, period: 12 });
      result.emaSlow = EMA.calculate({ values: closes, period: 26 });
    } catch (e) {
      result.emaFast = null;
      result.emaSlow = null;
    }

    // SMA (50 and 200)
    try {
      result.sma50 = SMA.calculate({ values: closes, period: 50 });
      result.sma200 = SMA.calculate({ values: closes, period: 200 });
    } catch (e) {
      result.sma50 = null;
      result.sma200 = null;
    }

    // MACD
    try {
      result.macd = MACD.calculate({
        values: closes,
        fastPeriod: 12,
        slowPeriod: 26,
        signalPeriod: 9,
        SimpleMAOscillator: false,
        SimpleMASignal: false
      });
    } catch (e) {
      result.macd = null;
    }

    // Stochastic RSI
    try {
      result.stochastic = Stochastic.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14,
        signalPeriod: 3
      });
    } catch (e) {
      result.stochastic = null;
    }

    // ATR (Average True Range)
    try {
      result.atr = ATR.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14
      });
    } catch (e) {
      result.atr = null;
    }

    // ADX (Average Directional Index)
    try {
      result.adx = ADX.calculate({
        high: highs,
        low: lows,
        close: closes,
        period: 14
      });
    } catch (e) {
      result.adx = null;
    }

    return result;
  }

  // Helper: check if golden cross (SMA50 crosses above SMA200)
  isGoldenCross(sma50, sma200) {
    if (!sma50 || !sma200 || sma50.length < 2 || sma200.length < 2) return false;
    const len = Math.min(sma50.length, sma200.length);
    return sma50[len - 2] <= sma200[len - 2] && sma50[len - 1] > sma200[len - 1];
  }

  // Helper: check if death cross (SMA50 crosses below SMA200)
  isDeathCross(sma50, sma200) {
    if (!sma50 || !sma200 || sma50.length < 2 || sma200.length < 2) return false;
    const len = Math.min(sma50.length, sma200.length);
    return sma50[len - 2] >= sma200[len - 2] && sma50[len - 1] < sma200[len - 1];
  }
}

module.exports = { TechnicalAnalysis };
