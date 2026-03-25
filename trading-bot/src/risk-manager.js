'use strict';

/**
 * Risk Manager
 *
 * Enforces position sizing rules:
 *   - Max 1-3% of balance per trade
 *   - Always sets SL and TP (min 1:3 R:R)
 *   - Validates orders before submission
 */

const DEFAULT_RISK_PCT = 1;
const MIN_RR_RATIO = 3;
const MAX_RISK_PCT = 3;
const MIN_RISK_PCT = 0.5;
const MAX_CONCURRENT_POSITIONS = 3;

class RiskManager {
  constructor(options = {}) {
    this.riskPct = Math.min(Math.max(options.riskPct || DEFAULT_RISK_PCT, MIN_RISK_PCT), MAX_RISK_PCT);
    this.minRR = options.minRR || MIN_RR_RATIO;
    this.maxConcurrent = options.maxConcurrentPositions || MAX_CONCURRENT_POSITIONS;
    this.openPositions = [];
  }

  /**
   * Calculate position size based on balance, entry, stop-loss, and risk %.
   */
  calculatePositionSize(balance, entry, stopLoss) {
    if (!balance || balance <= 0) throw new Error('Invalid balance');
    if (!entry || entry <= 0) throw new Error('Invalid entry price');
    if (!stopLoss || stopLoss <= 0) throw new Error('Invalid stop-loss');

    const riskAmount = balance * (this.riskPct / 100);
    const riskPerUnit = Math.abs(entry - stopLoss);

    if (riskPerUnit <= 0) throw new Error('Entry and stop-loss are equal');

    const size = riskAmount / riskPerUnit;
    return {
      size: parseFloat(size.toFixed(6)),
      riskAmount: parseFloat(riskAmount.toFixed(2)),
      riskPerUnit: parseFloat(riskPerUnit.toFixed(8)),
      riskPct: this.riskPct,
    };
  }

  /**
   * Calculate take-profit given entry, stop-loss, and side.
   */
  calculateTakeProfit(entry, stopLoss, side) {
    const risk = Math.abs(entry - stopLoss);
    if (side === 'long') {
      return parseFloat((entry + risk * this.minRR).toFixed(8));
    }
    return parseFloat((entry - risk * this.minRR).toFixed(8));
  }

  /**
   * Validate an order before execution.
   */
  validateOrder(order) {
    const errors = [];

    if (!order.entry || order.entry <= 0) errors.push('Missing or invalid entry price');
    if (!order.stopLoss || order.stopLoss <= 0) errors.push('Missing stop-loss');
    if (!order.takeProfit || order.takeProfit <= 0) errors.push('Missing take-profit');
    if (!order.size || order.size <= 0) errors.push('Missing or invalid position size');

    if (order.side === 'long') {
      if (order.stopLoss >= order.entry) errors.push('Stop-loss must be below entry for long');
      if (order.takeProfit <= order.entry) errors.push('Take-profit must be above entry for long');
    } else if (order.side === 'short') {
      if (order.stopLoss <= order.entry) errors.push('Stop-loss must be above entry for short');
      if (order.takeProfit >= order.entry) errors.push('Take-profit must be below entry for short');
    }

    // Check R:R ratio
    const risk = Math.abs(order.entry - order.stopLoss);
    const reward = Math.abs(order.takeProfit - order.entry);
    if (risk > 0 && reward / risk < this.minRR) {
      errors.push(`R:R ratio ${(reward / risk).toFixed(2)} is below minimum ${this.minRR}`);
    }

    // Check concurrent positions
    if (this.openPositions.length >= this.maxConcurrent) {
      errors.push(`Max concurrent positions (${this.maxConcurrent}) reached`);
    }

    return { valid: errors.length === 0, errors };
  }

  addPosition(position) {
    this.openPositions.push(position);
  }

  removePosition(id) {
    this.openPositions = this.openPositions.filter((p) => p.id !== id);
  }

  getOpenPositions() {
    return [...this.openPositions];
  }
}

module.exports = RiskManager;
