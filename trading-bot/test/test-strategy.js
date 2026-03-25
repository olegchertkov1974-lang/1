'use strict';

/**
 * Basic tests for GerchikLevels strategy.
 */

const GerchikLevels = require('../../var/strategies/gerchik-levels');

const strategy = new GerchikLevels();

// Generate synthetic candles with a clear support level at ~100 and resistance at ~110
function makeCandles(count) {
  const candles = [];
  let price = 105;
  for (let i = 0; i < count; i++) {
    // oscillate between 100 and 110
    const phase = Math.sin((i / count) * Math.PI * 6);
    price = 105 + phase * 5;
    const open = price + (Math.random() - 0.5) * 0.5;
    const close = price + (Math.random() - 0.5) * 0.5;
    const high = Math.max(open, close) + Math.random() * 0.3;
    const low = Math.min(open, close) - Math.random() * 0.3;
    candles.push({
      time: Date.now() - (count - i) * 60000,
      open,
      high,
      low,
      close,
      volume: 1000000 + Math.random() * 500000,
    });
  }
  return candles;
}

// Test 1: Level detection
console.log('--- Test 1: Level Detection ---');
const candles = makeCandles(120);
const levels = strategy._findLevels(candles);
console.log(`Found ${levels.length} levels:`);
levels.forEach((l) => console.log(`  ${l.type} @ ${l.price.toFixed(2)} (${l.touches} touches)`));
console.assert(levels.length > 0, 'Should find at least one level');

// Test 2: ATR calculation
console.log('\n--- Test 2: ATR ---');
const atr = strategy._calculateATR(candles, 14);
console.log(`ATR(14) = ${atr.toFixed(4)}`);
console.assert(atr > 0, 'ATR should be positive');

// Test 3: Position sizing
console.log('\n--- Test 3: Position Sizing ---');
const size = strategy.calculatePositionSize(10000, 100, 98, 1);
console.log(`Position size: ${size.toFixed(4)} units (balance=10000, entry=100, SL=98, risk=1%)`);
console.assert(size === 50, `Expected 50, got ${size}`);

// Test 4: Candle helpers
console.log('\n--- Test 4: Candle Helpers ---');
const bullish = { open: 100, close: 105, high: 106, low: 99.5 };
const bearish = { open: 105, close: 100, high: 106, low: 99.5 };
console.assert(strategy._isStrongBullishCandle(bullish), 'Should detect bullish candle');
console.assert(strategy._isStrongBearishCandle(bearish), 'Should detect bearish candle');
console.assert(!strategy._isStrongBullishCandle(bearish), 'Bearish should not be bullish');

// Test 5: Options
console.log('\n--- Test 5: Options ---');
const opts = strategy.getOptions();
console.log('Available options:', JSON.stringify(opts, null, 2));
console.assert(opts.period.options.includes('15m'), '15m should be available');
console.assert(opts.period.options.includes('1h'), '1h should be available');
console.assert(opts.period.options.includes('4h'), '4h should be available');

console.log('\n✓ All tests passed');
