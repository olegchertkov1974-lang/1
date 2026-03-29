'use strict';

/**
 * Gerchik Levels Strategy
 *
 * Finds horizontal price levels from historical data (local highs/lows,
 * accumulation zones) and generates entry/exit signals based on:
 *   - Confirmed breakout above resistance  → long
 *   - Confirmed breakout below support     → short
 *   - Bounce off support                   → long
 *   - Bounce off resistance                → short
 *
 * Uses candle-close confirmation to filter false breakouts.
 * Integrates risk management: 1-3% risk per trade, SL/TP with min 1:3 R:R.
 * Volume filter: skips signals when daily volume < threshold.
 */

const LEVEL_LOOKBACK = 100;          // candles to scan for levels
const LEVEL_TOUCH_MIN = 2;           // min touches to confirm a level
const LEVEL_ZONE_PCT = 0.15;         // % tolerance around a level
const BREAKOUT_CONFIRM_CANDLES = 2;  // candles closing beyond level
const BOUNCE_WICK_RATIO = 0.6;       // wick-to-body ratio for bounce candle
const DEFAULT_RISK_PCT = 1;          // % of balance risked per trade (1-3)
const MIN_RR_RATIO = 3;              // minimum reward-to-risk ratio
const ATR_PERIOD = 14;               // ATR period for SL calculation
const VOLUME_MA_PERIOD = 20;         // period for average volume

class GerchikLevels {
  getName() {
    return 'gerchik-levels';
  }

  buildIndicator(indicatorBuilder, options) {
    if (!indicatorBuilder) return;
    indicatorBuilder.add('atr', 'atr', options.period || '15m', { length: ATR_PERIOD });
    indicatorBuilder.add('volume_ma', 'sma', options.period || '15m', {
      length: VOLUME_MA_PERIOD,
      source: 'volume',
    });
  }

  /**
   * Main period callback — called on every new candle.
   */
  async period(indicatorPeriod, options = {}) {
    const candles = indicatorPeriod.getLatestCandles
      ? indicatorPeriod.getLatestCandles(LEVEL_LOOKBACK)
      : indicatorPeriod.lookback
        ? indicatorPeriod.lookback(LEVEL_LOOKBACK)
        : [];

    if (!candles || candles.length < LEVEL_LOOKBACK / 2) {
      return undefined; // not enough data
    }

    const currentCandle = candles[candles.length - 1];
    const prevCandle = candles[candles.length - 2];
    if (!currentCandle || !prevCandle) return undefined;

    // --- Volume filter ---
    const volumeThreshold = options.volumeThreshold || 0;
    if (volumeThreshold > 0) {
      const avgVolume = this._averageVolume(candles, VOLUME_MA_PERIOD);
      if (currentCandle.volume < volumeThreshold || currentCandle.volume < avgVolume * 0.5) {
        return undefined; // insufficient volume
      }
    }

    // --- Find horizontal levels ---
    const levels = this._findLevels(candles);
    if (levels.length === 0) return undefined;

    // --- ATR for stop-loss ---
    const atrValue = indicatorPeriod.getIndicator
      ? indicatorPeriod.getIndicator('atr')
      : this._calculateATR(candles, ATR_PERIOD);
    const atr = typeof atrValue === 'number' ? atrValue : (atrValue && atrValue.value) || this._calculateATR(candles, ATR_PERIOD);

    // --- Check signals against each level ---
    const signal = this._evaluateSignals(candles, levels, atr, options);
    return signal;
  }

  // ────────────────────────────────────────────────
  //  ENTRY SIGNAL
  // ────────────────────────────────────────────────
  entrySignal(candles, levels, atr, options = {}) {
    if (!candles || candles.length < 3) return null;

    const current = candles[candles.length - 1];
    const prev = candles[candles.length - 2];
    const prev2 = candles[candles.length - 3];

    for (const level of levels) {
      const zonePct = (options.levelZonePct || LEVEL_ZONE_PCT) / 100;
      const zoneSize = level.price * zonePct;
      const upperBound = level.price + zoneSize;
      const lowerBound = level.price - zoneSize;

      // --- BREAKOUT UP (resistance) ---
      if (level.type === 'resistance' || level.type === 'dual') {
        if (
          this._isCandleClosedAbove(current, upperBound) &&
          this._isCandleClosedAbove(prev, upperBound) &&
          prev2.close <= upperBound
        ) {
          if (this._isStrongBullishCandle(current) && this._isStrongBullishCandle(prev)) {
            const stopLoss = lowerBound - atr * 0.5;
            const entry = current.close;
            const risk = entry - stopLoss;
            const takeProfit = entry + risk * MIN_RR_RATIO;

            return {
              signal: 'long',
              type: 'breakout',
              entry,
              stopLoss,
              takeProfit,
              level: level.price,
              risk,
              riskRewardRatio: MIN_RR_RATIO,
              reason: `Пробой сопротивления ${level.price.toFixed(2)}`,
            };
          }
        }
      }

      // --- BREAKOUT DOWN (support) ---
      if (level.type === 'support' || level.type === 'dual') {
        if (
          this._isCandleClosedBelow(current, lowerBound) &&
          this._isCandleClosedBelow(prev, lowerBound) &&
          prev2.close >= lowerBound
        ) {
          if (this._isStrongBearishCandle(current) && this._isStrongBearishCandle(prev)) {
            const stopLoss = upperBound + atr * 0.5;
            const entry = current.close;
            const risk = stopLoss - entry;
            const takeProfit = entry - risk * MIN_RR_RATIO;

            return {
              signal: 'short',
              type: 'breakout',
              entry,
              stopLoss,
              takeProfit,
              level: level.price,
              risk,
              riskRewardRatio: MIN_RR_RATIO,
              reason: `Пробой поддержки ${level.price.toFixed(2)}`,
            };
          }
        }
      }

      // --- BOUNCE OFF SUPPORT ---
      if (level.type === 'support' || level.type === 'dual') {
        if (
          prev.low <= upperBound &&
          prev.low >= lowerBound - atr * 0.3 &&
          current.close > level.price &&
          this._isBounceCandle(current, 'up')
        ) {
          const stopLoss = lowerBound - atr * 0.5;
          const entry = current.close;
          const risk = entry - stopLoss;
          const takeProfit = entry + risk * MIN_RR_RATIO;

          return {
            signal: 'long',
            type: 'bounce',
            entry,
            stopLoss,
            takeProfit,
            level: level.price,
            risk,
            riskRewardRatio: MIN_RR_RATIO,
            reason: `Отскок от поддержки ${level.price.toFixed(2)}`,
          };
        }
      }

      // --- BOUNCE OFF RESISTANCE ---
      if (level.type === 'resistance' || level.type === 'dual') {
        if (
          prev.high >= lowerBound &&
          prev.high <= upperBound + atr * 0.3 &&
          current.close < level.price &&
          this._isBounceCandle(current, 'down')
        ) {
          const stopLoss = upperBound + atr * 0.5;
          const entry = current.close;
          const risk = stopLoss - entry;
          const takeProfit = entry - risk * MIN_RR_RATIO;

          return {
            signal: 'short',
            type: 'bounce',
            entry,
            stopLoss,
            takeProfit,
            level: level.price,
            risk,
            riskRewardRatio: MIN_RR_RATIO,
            reason: `Отскок от сопротивления ${level.price.toFixed(2)}`,
          };
        }
      }
    }

    return null;
  }

  // ────────────────────────────────────────────────
  //  EXIT SIGNAL
  // ────────────────────────────────────────────────
  exitSignal(candles, position, levels, atr) {
    if (!position || !candles || candles.length < 2) return null;

    const current = candles[candles.length - 1];

    // --- Hard stop-loss hit ---
    if (position.side === 'long' && current.low <= position.stopLoss) {
      return { signal: 'close', reason: 'Stop-loss hit (long)', price: position.stopLoss };
    }
    if (position.side === 'short' && current.high >= position.stopLoss) {
      return { signal: 'close', reason: 'Stop-loss hit (short)', price: position.stopLoss };
    }

    // --- Take-profit hit ---
    if (position.side === 'long' && current.high >= position.takeProfit) {
      return { signal: 'close', reason: 'Take-profit hit (long)', price: position.takeProfit };
    }
    if (position.side === 'short' && current.low <= position.takeProfit) {
      return { signal: 'close', reason: 'Take-profit hit (short)', price: position.takeProfit };
    }

    // --- Opposing level reached → tighten or exit ---
    for (const level of levels) {
      const zone = level.price * (LEVEL_ZONE_PCT / 100);
      if (position.side === 'long' && level.type === 'resistance') {
        if (current.close >= level.price - zone && current.close < level.price + zone) {
          return { signal: 'close', reason: `Приближение к сопротивлению ${level.price.toFixed(2)}`, price: current.close };
        }
      }
      if (position.side === 'short' && level.type === 'support') {
        if (current.close <= level.price + zone && current.close > level.price - zone) {
          return { signal: 'close', reason: `Приближение к поддержке ${level.price.toFixed(2)}`, price: current.close };
        }
      }
    }

    return null;
  }

  // ────────────────────────────────────────────────
  //  RISK MANAGEMENT — position sizing
  // ────────────────────────────────────────────────
  calculatePositionSize(balance, entry, stopLoss, riskPct) {
    const riskPercent = Math.min(Math.max(riskPct || DEFAULT_RISK_PCT, 0.5), 3);
    const riskAmount = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entry - stopLoss);
    if (riskPerUnit <= 0) return 0;
    return riskAmount / riskPerUnit;
  }

  // ────────────────────────────────────────────────
  //  INTERNAL: evaluate signals (wraps entry/exit)
  // ────────────────────────────────────────────────
  _evaluateSignals(candles, levels, atr, options) {
    const entry = this.entrySignal(candles, levels, atr, options);
    if (!entry) return undefined;

    const balance = options.balance || 10000;
    const riskPct = options.riskPct || DEFAULT_RISK_PCT;
    const positionSize = this.calculatePositionSize(balance, entry.entry, entry.stopLoss, riskPct);

    return {
      ...entry,
      positionSize: parseFloat(positionSize.toFixed(6)),
      balance,
      riskPct,
    };
  }

  // ────────────────────────────────────────────────
  //  LEVEL DETECTION
  // ────────────────────────────────────────────────
  _findLevels(candles) {
    const pivots = [];

    // Detect local highs and lows (swing points)
    for (let i = 2; i < candles.length - 2; i++) {
      const c = candles[i];
      const isLocalHigh =
        c.high > candles[i - 1].high &&
        c.high > candles[i - 2].high &&
        c.high > candles[i + 1].high &&
        c.high > candles[i + 2].high;

      const isLocalLow =
        c.low < candles[i - 1].low &&
        c.low < candles[i - 2].low &&
        c.low < candles[i + 1].low &&
        c.low < candles[i + 2].low;

      if (isLocalHigh) pivots.push({ price: c.high, type: 'high', index: i });
      if (isLocalLow) pivots.push({ price: c.low, type: 'low', index: i });
    }

    // Cluster nearby pivots into levels
    const levels = [];
    const used = new Set();

    for (let i = 0; i < pivots.length; i++) {
      if (used.has(i)) continue;

      const cluster = [pivots[i]];
      used.add(i);

      for (let j = i + 1; j < pivots.length; j++) {
        if (used.has(j)) continue;
        const diff = Math.abs(pivots[i].price - pivots[j].price) / pivots[i].price;
        if (diff <= LEVEL_ZONE_PCT / 100) {
          cluster.push(pivots[j]);
          used.add(j);
        }
      }

      if (cluster.length >= LEVEL_TOUCH_MIN) {
        const avgPrice = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
        const hasHighs = cluster.some((p) => p.type === 'high');
        const hasLows = cluster.some((p) => p.type === 'low');

        let type;
        if (hasHighs && hasLows) type = 'dual';
        else if (hasHighs) type = 'resistance';
        else type = 'support';

        levels.push({
          price: parseFloat(avgPrice.toFixed(8)),
          type,
          touches: cluster.length,
          lastTouchIndex: Math.max(...cluster.map((p) => p.index)),
        });
      }
    }

    // Sort by number of touches (strongest first)
    levels.sort((a, b) => b.touches - a.touches);
    return levels.slice(0, 10); // top 10 levels
  }

  // ────────────────────────────────────────────────
  //  CANDLE HELPERS
  // ────────────────────────────────────────────────
  _isCandleClosedAbove(candle, price) {
    return candle.close > price;
  }

  _isCandleClosedBelow(candle, price) {
    return candle.close < price;
  }

  _isStrongBullishCandle(candle) {
    const body = candle.close - candle.open;
    const range = candle.high - candle.low;
    return body > 0 && range > 0 && body / range > 0.5;
  }

  _isStrongBearishCandle(candle) {
    const body = candle.open - candle.close;
    const range = candle.high - candle.low;
    return body > 0 && range > 0 && body / range > 0.5;
  }

  _isBounceCandle(candle, direction) {
    const body = Math.abs(candle.close - candle.open);
    const range = candle.high - candle.low;
    if (range === 0) return false;

    if (direction === 'up') {
      // Long lower wick, small body, close near high
      const lowerWick = Math.min(candle.open, candle.close) - candle.low;
      return lowerWick / range >= BOUNCE_WICK_RATIO && candle.close > candle.open;
    }
    if (direction === 'down') {
      // Long upper wick, small body, close near low
      const upperWick = candle.high - Math.max(candle.open, candle.close);
      return upperWick / range >= BOUNCE_WICK_RATIO && candle.close < candle.open;
    }
    return false;
  }

  _averageVolume(candles, period) {
    const slice = candles.slice(-period);
    if (slice.length === 0) return 0;
    return slice.reduce((sum, c) => sum + (c.volume || 0), 0) / slice.length;
  }

  _calculateATR(candles, period) {
    if (candles.length < period + 1) return 0;
    const trs = [];
    for (let i = candles.length - period; i < candles.length; i++) {
      const c = candles[i];
      const p = candles[i - 1];
      if (!p) continue;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close));
      trs.push(tr);
    }
    return trs.reduce((s, v) => s + v, 0) / trs.length;
  }

  getOptions() {
    return {
      period: {
        label: 'Timeframe',
        default: '1h',
        options: ['15m', '1h', '4h'],
      },
      riskPct: {
        label: 'Risk per trade (%)',
        default: 1,
        min: 0.5,
        max: 3,
      },
      volumeThreshold: {
        label: 'Minimum daily volume (USD)',
        default: 1000000,
      },
      levelZonePct: {
        label: 'Level zone tolerance (%)',
        default: LEVEL_ZONE_PCT,
      },
    };
  }
}

module.exports = GerchikLevels;
