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
   * Валидация ордера перед исполнением.
   * @param {string} pair — торговая пара (для проверки: макс 1 позиция на инструмент)
   */
  validateOrder(order, pair) {
    const errors = [];

    if (!order.entry || order.entry <= 0) errors.push('Нет цены входа');
    if (!order.stopLoss || order.stopLoss <= 0) errors.push('Нет стоп-лосса');
    if (!order.takeProfit || order.takeProfit <= 0) errors.push('Нет тейк-профита');
    if (!order.size || order.size <= 0) errors.push('Нет размера позиции');

    if (order.side === 'long') {
      if (order.stopLoss >= order.entry) errors.push('SL должен быть ниже входа для лонга');
      if (order.takeProfit <= order.entry) errors.push('TP должен быть выше входа для лонга');
    } else if (order.side === 'short') {
      if (order.stopLoss <= order.entry) errors.push('SL должен быть выше входа для шорта');
      if (order.takeProfit >= order.entry) errors.push('TP должен быть ниже входа для шорта');
    }

    // Проверка R:R
    const risk = Math.abs(order.entry - order.stopLoss);
    const reward = Math.abs(order.takeProfit - order.entry);
    if (risk > 0 && reward / risk < this.minRR) {
      errors.push(`R:R ${(reward / risk).toFixed(2)} ниже минимума ${this.minRR}`);
    }

    // Макс 1 позиция на инструмент (Герчик)
    if (pair) {
      const hasPosition = this.openPositions.some((p) => p.id === pair);
      if (hasPosition) {
        errors.push(`Уже есть позиция по ${pair} (макс 1 на инструмент)`);
      }
    }

    // Общий лимит позиций
    if (this.openPositions.length >= this.maxConcurrent) {
      errors.push(`Достигнут лимит позиций (${this.maxConcurrent})`);
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
