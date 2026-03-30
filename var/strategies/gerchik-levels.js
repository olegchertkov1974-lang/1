'use strict';

/**
 * Gerchik Levels Strategy (полная методология Герчика)
 *
 * Уровни строятся по ТЕЛАМ свечей на 1D.
 * Классификация: зеркальный, ложный пробой, мульти-тач.
 * Паттерны входа на 5m: ложный пробой, отбой, поглощение, база.
 * SL за зоной уровня + 2-3 тика, TP на следующем дневном уровне.
 * Минимум R:R = 1:3.
 */

const LEVEL_LOOKBACK = 120;          // дневных свечей для поиска уровней
const LEVEL_TOUCH_MIN = 2;           // мин касаний для подтверждения уровня
const LEVEL_ZONE_PCT = 0.4;          // % ширина зоны уровня (BTC 87k = ~350$)
const MIN_RR_RATIO = 3;              // минимальное R:R
const TICK_BUFFER = 3;               // тиков буфер для SL
const ENTRY_OFFSET_TICKS = 2;        // тиков отступ для лимитки
const MAX_LEVEL_TOUCHES = 4;         // макс касаний — дальше уровень изношен
const ROUND_NUMBER_THRESHOLD = 1000; // для крипто: 60000, 65000 etc

class GerchikLevels {
  getName() {
    return 'gerchik-levels';
  }

  // ────────────────────────────────────────────────
  //  УРОВНИ — построение по ТЕЛАМ свечей (1D)
  // ────────────────────────────────────────────────

  /**
   * Найти уровни по дневным свечам (тела свечей, не хвосты).
   * Возвращает массив объектов с классификацией и оценкой силы.
   */
  findLevels(dailyCandles) {
    if (!dailyCandles || dailyCandles.length < 20) return [];

    const pivots = [];

    // Ищем развороты по ТЕЛАМ свечей (сравнение с 1 соседом с каждой стороны)
    for (let i = 1; i < dailyCandles.length - 1; i++) {
      const c = dailyCandles[i];
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);

      // Локальный максимум по телу (выше соседей)
      const prevBodyHigh = Math.max(dailyCandles[i - 1].open, dailyCandles[i - 1].close);
      const nextBodyHigh = Math.max(dailyCandles[i + 1].open, dailyCandles[i + 1].close);
      const isBodyHigh = bodyHigh > prevBodyHigh && bodyHigh > nextBodyHigh;

      // Локальный минимум по телу (ниже соседей)
      const prevBodyLow = Math.min(dailyCandles[i - 1].open, dailyCandles[i - 1].close);
      const nextBodyLow = Math.min(dailyCandles[i + 1].open, dailyCandles[i + 1].close);
      const isBodyLow = bodyLow < prevBodyLow && bodyLow < nextBodyLow;

      if (isBodyHigh) pivots.push({ price: bodyHigh, type: 'high', index: i });
      if (isBodyLow) pivots.push({ price: bodyLow, type: 'low', index: i });
    }

    // Для каждого пивота считаем ВСЕ касания тел свечей в зоне (не только другие пивоты)
    // Это ключевое отличие — уровень подтверждается реакцией цены, а не только разворотами
    const levels = [];
    const usedPivots = new Set();

    // Сначала кластеризуем близкие пивоты, чтобы не дублировать уровни
    const pivotClusters = [];
    const pivotUsed = new Set();

    for (let i = 0; i < pivots.length; i++) {
      if (pivotUsed.has(i)) continue;
      const cluster = [pivots[i]];
      pivotUsed.add(i);

      for (let j = i + 1; j < pivots.length; j++) {
        if (pivotUsed.has(j)) continue;
        const diff = Math.abs(pivots[i].price - pivots[j].price) / pivots[i].price;
        if (diff <= LEVEL_ZONE_PCT / 100) {
          cluster.push(pivots[j]);
          pivotUsed.add(j);
        }
      }
      pivotClusters.push(cluster);
    }

    for (const cluster of pivotClusters) {
      const avgPrice = cluster.reduce((s, p) => s + p.price, 0) / cluster.length;
      const zone = avgPrice * (LEVEL_ZONE_PCT / 100);
      const hasHighs = cluster.some((p) => p.type === 'high');
      const hasLows = cluster.some((p) => p.type === 'low');

      // Считаем ВСЕ свечи, чьи тела касаются зоны уровня
      let touches = 0;
      let lastTouchIndex = 0;
      let firstTouchIndex = dailyCandles.length;
      const touchPrices = [];

      for (let i = 0; i < dailyCandles.length; i++) {
        const c = dailyCandles[i];
        const bodyHigh = Math.max(c.open, c.close);
        const bodyLow = Math.min(c.open, c.close);

        // Тело свечи касается зоны уровня (тело пересекает зону или находится на границе)
        if (bodyLow <= avgPrice + zone && bodyHigh >= avgPrice - zone) {
          touches++;
          touchPrices.push(bodyHigh, bodyLow);
          if (i > lastTouchIndex) lastTouchIndex = i;
          if (i < firstTouchIndex) firstTouchIndex = i;
        }
      }

      // Уровень должен иметь минимум LEVEL_TOUCH_MIN касаний
      if (touches < LEVEL_TOUCH_MIN) continue;

      const zoneHigh = Math.max(...cluster.map(p => p.price), avgPrice + zone * 0.5);
      const zoneLow = Math.min(...cluster.map(p => p.price), avgPrice - zone * 0.5);

      const level = {
        price: parseFloat(avgPrice.toFixed(8)),
        zoneHigh: parseFloat(zoneHigh.toFixed(8)),
        zoneLow: parseFloat(zoneLow.toFixed(8)),
        touches,
        pivotCount: cluster.length,
        lastTouchIndex,
        firstTouchIndex,
        isMirror: hasHighs && hasLows,
        hasFalseBreakout: false,
        hasLongWicks: false,
        isRoundNumber: false,
        strength: 0,
        classification: '',
        type: hasHighs && hasLows ? 'dual' : hasHighs ? 'resistance' : 'support',
      };

      // Проверяем ложный пробой
      level.hasFalseBreakout = this._detectFalseBreakout(dailyCandles, level);

      // Проверяем длинные хвосты от уровня
      level.hasLongWicks = this._detectLongWicks(dailyCandles, level);

      // Проверяем круглое число
      level.isRoundNumber = this._isRoundNumber(level.price);

      // Классификация
      level.classification = this._classifyLevel(level);

      // Оценка силы
      level.strength = this._scoreLevel(level, dailyCandles);

      levels.push(level);
    }

    // Сортировка по силе (сильнейшие первые)
    levels.sort((a, b) => b.strength - a.strength);

    // Фильтруем слабые уровни (сила < 2)
    return levels.filter((l) => l.strength >= 2);
  }

  // ────────────────────────────────────────────────
  //  КЛАССИФИКАЦИЯ УРОВНЯ
  // ────────────────────────────────────────────────

  _classifyLevel(level) {
    if (level.isMirror) return 'mirror';           // Зеркальный — самый сильный
    if (level.hasFalseBreakout) return 'false_breakout'; // С ложным пробоем
    if (level.pivotCount >= 3) return 'multi_touch';  // Мульти-тач
    return 'standard';                              // Стандартный
  }

  _scoreLevel(level, dailyCandles) {
    let score = 0;

    // Базовый балл за пивоты (не за все касания — касания считают все свечи в зоне)
    const pivots = level.pivotCount || 1;
    if (pivots <= 3) {
      score += pivots + 1; // 1 пивот = +2, 2 = +3, 3 = +4
    } else {
      score += 4; // 4 — максимум, дальше износ
      score -= (pivots - 3); // штраф за каждый пивот свыше 3
    }

    // Зеркальность: +3
    if (level.isMirror) score += 3;

    // Ложный пробой: +2
    if (level.hasFalseBreakout) score += 2;

    // Длинные хвосты: +1
    if (level.hasLongWicks) score += 1;

    // Круглое число: +1
    if (level.isRoundNumber) score += 1;

    // Свежесть: первый-второй подход — +1
    const totalCandles = dailyCandles.length;
    const recency = totalCandles - level.lastTouchIndex;
    if (recency <= 10) score += 1; // недавний тест

    // Давно не тестировался (>60 дневных свечей) — -1
    if (recency > 60) score -= 1;

    return score;
  }

  _detectFalseBreakout(candles, level) {
    const zone = (level.zoneHigh - level.zoneLow) || level.price * (LEVEL_ZONE_PCT / 100);
    const upperBound = level.zoneHigh + zone * 0.5;
    const lowerBound = level.zoneLow - zone * 0.5;

    for (let i = 3; i < candles.length - 1; i++) {
      const c = candles[i];
      const next = candles[i + 1];
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);

      // Пробой вверх и возврат
      if (bodyHigh > upperBound) {
        const nextBodyHigh = Math.max(next.open, next.close);
        if (nextBodyHigh < upperBound) return true;
      }

      // Пробой вниз и возврат
      if (bodyLow < lowerBound) {
        const nextBodyLow = Math.min(next.open, next.close);
        if (nextBodyLow > lowerBound) return true;
      }
    }

    return false;
  }

  _detectLongWicks(candles, level) {
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    let longWickCount = 0;

    for (const c of candles) {
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      const bodySize = bodyHigh - bodyLow || 0.0001;

      // Свеча касается зоны уровня
      if (c.low <= level.price + zone && c.high >= level.price - zone) {
        const lowerWick = bodyLow - c.low;
        const upperWick = c.high - bodyHigh;

        // Длинный хвост = хвост > тела
        if (lowerWick > bodySize || upperWick > bodySize) {
          longWickCount++;
        }
      }
    }

    return longWickCount >= 2;
  }

  _isRoundNumber(price) {
    // Для крипто: кратные 1000 (60000, 65000, etc.)
    if (price >= 10000) return price % 5000 === 0 || price % 1000 === 0;
    if (price >= 100) return price % 100 === 0 || price % 50 === 0;
    if (price >= 10) return price % 10 === 0 || price % 5 === 0;
    return price % 1 === 0 || price % 0.5 === 0;
  }

  // ────────────────────────────────────────────────
  //  ТРЕНД НА 4H
  // ────────────────────────────────────────────────

  /**
   * Определить тренд по 4H свечам.
   * Возвращает: 'up', 'down', 'neutral'
   */
  detectTrend4H(candles4H) {
    if (!candles4H || candles4H.length < 20) return 'neutral';

    // Серия повышающихся минимумов = восходящий
    // Серия понижающихся максимумов = нисходящий
    const recent = candles4H.slice(-20);
    let higherLows = 0;
    let lowerHighs = 0;

    for (let i = 1; i < recent.length; i++) {
      const prevLow = Math.min(recent[i - 1].open, recent[i - 1].close);
      const currLow = Math.min(recent[i].open, recent[i].close);
      const prevHigh = Math.max(recent[i - 1].open, recent[i - 1].close);
      const currHigh = Math.max(recent[i].open, recent[i].close);

      if (currLow > prevLow) higherLows++;
      if (currHigh < prevHigh) lowerHighs++;
    }

    const total = recent.length - 1;
    if (higherLows > total * 0.55) return 'up';
    if (lowerHighs > total * 0.55) return 'down';
    return 'neutral';
  }

  /**
   * Проверяет, подтверждает ли 4H тренд направление сделки.
   * Возвращает: { confirmed: bool, reduce: bool }
   */
  check4HConfirmation(candles4H, direction) {
    const trend = this.detectTrend4H(candles4H);

    if (direction === 'long') {
      if (trend === 'up') return { confirmed: true, reduce: false };
      if (trend === 'neutral') return { confirmed: true, reduce: false };
      return { confirmed: false, reduce: true }; // 4H вниз — противоречие
    }

    if (direction === 'short') {
      if (trend === 'down') return { confirmed: true, reduce: false };
      if (trend === 'neutral') return { confirmed: true, reduce: false };
      return { confirmed: false, reduce: true }; // 4H вверх — противоречие
    }

    return { confirmed: true, reduce: false };
  }

  /**
   * Проверяет поведение цены на 4H при подходе к уровню.
   * Ищет: поджатие, ложный пробой, формирование базы.
   */
  analyze4HApproach(candles4H, level) {
    if (!candles4H || candles4H.length < 5) return { approach: 'unknown' };

    const recent = candles4H.slice(-6);
    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const upperBound = level.price + zone;
    const lowerBound = level.price - zone;

    // Проверяем последние свечи
    let inZone = 0;
    let smallBodies = 0;
    let falseBreak = false;

    for (let i = 0; i < recent.length; i++) {
      const c = recent[i];
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);

      if (bodyLow <= upperBound && bodyHigh >= lowerBound) {
        inZone++;
      }

      const bodySize = bodyHigh - bodyLow;
      const range = c.high - c.low;
      if (range > 0 && bodySize / range < 0.3) {
        smallBodies++;
      }

      // Ложный пробой на 4H
      if (i < recent.length - 1) {
        const next = recent[i + 1];
        if (bodyHigh > upperBound && Math.max(next.open, next.close) < upperBound) {
          falseBreak = true;
        }
        if (bodyLow < lowerBound && Math.min(next.open, next.close) > lowerBound) {
          falseBreak = true;
        }
      }
    }

    if (falseBreak) return { approach: 'false_breakout' };
    if (smallBodies >= 3) return { approach: 'base' }; // Формирование базы
    if (inZone >= 2) return { approach: 'compression' }; // Поджатие

    return { approach: 'direct' };
  }

  // ────────────────────────────────────────────────
  //  ПАТТЕРНЫ ВХОДА НА 5m
  // ────────────────────────────────────────────────

  /**
   * Искать паттерн входа на 5m свечах в зоне дневного уровня.
   * Возвращает сигнал или null.
   */
  findEntryPattern(candles5m, level, direction, allDailyLevels, tickSize) {
    if (!candles5m || candles5m.length < 6) return null;

    const tick = tickSize || this._estimateTickSize(level.price);
    const zone = Math.max(level.zoneHigh - level.zoneLow, level.price * (LEVEL_ZONE_PCT / 100));
    const upperBound = level.zoneHigh || (level.price + zone / 2);
    const lowerBound = level.zoneLow || (level.price - zone / 2);

    // Проверяем, что цена находится в зоне уровня
    const current = candles5m[candles5m.length - 1];
    const distToLevel = Math.abs(current.close - level.price) / level.price;
    if (distToLevel > LEVEL_ZONE_PCT / 100 * 3) return null; // слишком далеко

    // Проверяем 4 паттерна в порядке приоритета
    let pattern = null;

    pattern = this._checkFalseBreakoutPattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);

    pattern = this._checkEngulfingPattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);

    pattern = this._checkBouncePattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);

    pattern = this._checkBasePattern(candles5m, level, direction, tick);
    if (pattern) return this._buildSignal(pattern, level, direction, allDailyLevels, tick);

    return null;
  }

  /**
   * 1. Ложный пробой — свеча пробивает уровень, следующая возвращается.
   */
  _checkFalseBreakoutPattern(candles, level, direction, tick) {
    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];
    if (!prev || !curr) return null;

    const zone = level.price * (LEVEL_ZONE_PCT / 100);

    if (direction === 'long') {
      // Пробой вниз (хвостом или телом) + возврат
      const prevPenetrated = prev.low < level.price - zone;
      const currReturned = curr.close > level.price - zone / 2;
      const currBullish = curr.close > curr.open;

      if (prevPenetrated && currReturned && currBullish) {
        return { type: 'false_breakout', typeRu: 'Ложный пробой', entry: curr.close };
      }
    }

    if (direction === 'short') {
      // Пробой вверх + возврат
      const prevPenetrated = prev.high > level.price + zone;
      const currReturned = curr.close < level.price + zone / 2;
      const currBearish = curr.close < curr.open;

      if (prevPenetrated && currReturned && currBearish) {
        return { type: 'false_breakout', typeRu: 'Ложный пробой', entry: curr.close };
      }
    }

    return null;
  }

  /**
   * 2. Отбой — свеча касается зоны с длинным хвостом, тело по правильную сторону.
   */
  _checkBouncePattern(candles, level, direction, tick) {
    const curr = candles[candles.length - 1];
    if (!curr) return null;

    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const bodyHigh = Math.max(curr.open, curr.close);
    const bodyLow = Math.min(curr.open, curr.close);
    const bodySize = bodyHigh - bodyLow || 0.0001;
    const range = curr.high - curr.low;

    if (direction === 'long') {
      // Касание зоны поддержки + длинный нижний хвост
      const touchesZone = curr.low <= level.price + zone && curr.low >= level.price - zone * 2;
      const longLowerWick = (bodyLow - curr.low) > bodySize;
      const bodyAbove = bodyLow > level.price - zone;
      const bullish = curr.close >= curr.open;

      if (touchesZone && longLowerWick && bodyAbove && bullish) {
        return { type: 'bounce', typeRu: 'Отскок', entry: curr.close };
      }
    }

    if (direction === 'short') {
      // Касание зоны сопротивления + длинный верхний хвост
      const touchesZone = curr.high >= level.price - zone && curr.high <= level.price + zone * 2;
      const longUpperWick = (curr.high - bodyHigh) > bodySize;
      const bodyBelow = bodyHigh < level.price + zone;
      const bearish = curr.close <= curr.open;

      if (touchesZone && longUpperWick && bodyBelow && bearish) {
        return { type: 'bounce', typeRu: 'Отскок', entry: curr.close };
      }
    }

    return null;
  }

  /**
   * 3. Поглощение — свеча полностью перекрывает тело предыдущей в направлении отбоя.
   */
  _checkEngulfingPattern(candles, level, direction, tick) {
    const prev = candles[candles.length - 2];
    const curr = candles[candles.length - 1];
    if (!prev || !curr) return null;

    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const distToLevel = Math.abs(curr.close - level.price) / level.price;
    if (distToLevel > LEVEL_ZONE_PCT / 100 * 2) return null;

    const prevBodyHigh = Math.max(prev.open, prev.close);
    const prevBodyLow = Math.min(prev.open, prev.close);
    const currBodyHigh = Math.max(curr.open, curr.close);
    const currBodyLow = Math.min(curr.open, curr.close);

    if (direction === 'long') {
      // Бычье поглощение у поддержки
      const prevBearish = prev.close < prev.open;
      const currBullish = curr.close > curr.open;
      const engulfs = currBodyHigh > prevBodyHigh && currBodyLow <= prevBodyLow;
      const nearLevel = curr.low <= level.price + zone;

      if (prevBearish && currBullish && engulfs && nearLevel) {
        return { type: 'engulfing', typeRu: 'Поглощение', entry: curr.close };
      }
    }

    if (direction === 'short') {
      // Медвежье поглощение у сопротивления
      const prevBullish = prev.close > prev.open;
      const currBearish = curr.close < curr.open;
      const engulfs = currBodyLow < prevBodyLow && currBodyHigh >= prevBodyHigh;
      const nearLevel = curr.high >= level.price - zone;

      if (prevBullish && currBearish && engulfs && nearLevel) {
        return { type: 'engulfing', typeRu: 'Поглощение', entry: curr.close };
      }
    }

    return null;
  }

  /**
   * 4. База (проторговка) — 3-5 маленьких свечей у уровня, затем выход.
   */
  _checkBasePattern(candles, level, direction, tick) {
    if (candles.length < 5) return null;

    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    const recent = candles.slice(-5);
    const curr = recent[recent.length - 1];

    // Считаем маленькие свечи в зоне
    let smallInZone = 0;
    let avgRange = 0;

    for (let i = 0; i < recent.length - 1; i++) {
      const c = recent[i];
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);
      const bodySize = bodyHigh - bodyLow;
      const range = c.high - c.low;
      avgRange += range;

      const nearLevel = Math.abs(c.close - level.price) / level.price <= LEVEL_ZONE_PCT / 100 * 2;
      const smallBody = range > 0 && bodySize / range < 0.4;

      if (nearLevel && smallBody) smallInZone++;
    }

    avgRange /= (recent.length - 1);
    if (smallInZone < 3) return null;

    // Последняя свеча — выход из базы
    const currBodySize = Math.abs(curr.close - curr.open);

    if (direction === 'long') {
      const breakout = curr.close > curr.open && currBodySize > avgRange * 0.5;
      if (breakout) {
        return { type: 'base', typeRu: 'База (проторговка)', entry: curr.close };
      }
    }

    if (direction === 'short') {
      const breakout = curr.close < curr.open && currBodySize > avgRange * 0.5;
      if (breakout) {
        return { type: 'base', typeRu: 'База (проторговка)', entry: curr.close };
      }
    }

    return null;
  }

  // ────────────────────────────────────────────────
  //  ПОСТРОЕНИЕ СИГНАЛА
  // ────────────────────────────────────────────────

  _buildSignal(pattern, level, direction, allDailyLevels, tick) {
    // SL: за границей зоны уровня + буфер 2-3 тика
    const buffer = tick * TICK_BUFFER;
    let stopLoss;
    let entry;

    if (direction === 'long') {
      stopLoss = (level.zoneLow || level.price) - buffer;
      entry = (level.zoneLow || level.price) + tick * ENTRY_OFFSET_TICKS;
    } else {
      stopLoss = (level.zoneHigh || level.price) + buffer;
      entry = (level.zoneHigh || level.price) - tick * ENTRY_OFFSET_TICKS;
    }

    // Используем цену из паттерна как альтернативу если ближе к рынку
    if (direction === 'long' && pattern.entry > entry) entry = pattern.entry;
    if (direction === 'short' && pattern.entry < entry) entry = pattern.entry;

    // TP: на следующем дневном уровне
    let takeProfit = null;
    if (allDailyLevels && allDailyLevels.length > 0) {
      takeProfit = this._findNextLevel(entry, direction, allDailyLevels);
    }

    // Fallback: если нет следующего уровня — математический TP
    const risk = Math.abs(entry - stopLoss);
    if (!takeProfit) {
      takeProfit = direction === 'long'
        ? entry + risk * MIN_RR_RATIO
        : entry - risk * MIN_RR_RATIO;
    }

    // Проверка R:R
    const reward = Math.abs(takeProfit - entry);
    const rr = risk > 0 ? reward / risk : 0;
    if (rr < MIN_RR_RATIO) return null; // R:R недостаточный — пропускаем

    return {
      signal: direction,
      type: pattern.type,
      typeRu: pattern.typeRu,
      entry: parseFloat(entry.toFixed(8)),
      stopLoss: parseFloat(stopLoss.toFixed(8)),
      takeProfit: parseFloat(takeProfit.toFixed(8)),
      level: level.price,
      levelClassification: level.classification,
      levelStrength: level.strength,
      risk: parseFloat(risk.toFixed(8)),
      riskRewardRatio: parseFloat(rr.toFixed(2)),
      reason: `${pattern.typeRu} от ${level.type === 'support' ? 'поддержки' : level.type === 'resistance' ? 'сопротивления' : 'уровня'} ${level.price.toFixed(2)} (${this._classificationRu(level.classification)}, сила: ${level.strength})`,
    };
  }

  _classificationRu(classification) {
    const map = {
      'mirror': 'зеркальный',
      'false_breakout': 'с ложным пробоем',
      'multi_touch': 'мульти-тач',
      'standard': 'стандартный',
    };
    return map[classification] || classification;
  }

  /**
   * Найти ближайший дневной уровень в направлении сделки для TP.
   */
  _findNextLevel(entry, direction, allLevels) {
    let best = null;
    let bestDist = Infinity;

    for (const l of allLevels) {
      if (direction === 'long' && l.price > entry) {
        const dist = l.price - entry;
        if (dist < bestDist) {
          bestDist = dist;
          best = l.price;
        }
      }
      if (direction === 'short' && l.price < entry) {
        const dist = entry - l.price;
        if (dist < bestDist) {
          bestDist = dist;
          best = l.price;
        }
      }
    }

    return best;
  }

  // ────────────────────────────────────────────────
  //  ПРОВЕРКА ПРОБОЯ УРОВНЯ (для отмены ордера)
  // ────────────────────────────────────────────────

  /**
   * Проверяет, пробит ли уровень на 5m (закрытие тела за уровнем).
   * Это главный триггер отмены лимитного ордера.
   */
  isLevelBroken(candle5m, level, direction) {
    const bodyClose = candle5m.close;
    const zone = level.price * (LEVEL_ZONE_PCT / 100);

    if (direction === 'long') {
      // Для лонга (поддержка): пробой вниз = закрытие тела ниже зоны
      return bodyClose < (level.zoneLow || level.price) - zone;
    }

    if (direction === 'short') {
      // Для шорта (сопротивление): пробой вверх = закрытие тела выше зоны
      return bodyClose > (level.zoneHigh || level.price) + zone;
    }

    return false;
  }

  /**
   * Проверяет, изношен ли уровень (4+ касаний за последние N свечей).
   */
  isLevelWornOut(level, recentDailyCandles) {
    if (!recentDailyCandles || recentDailyCandles.length < 5) return false;

    const zone = level.price * (LEVEL_ZONE_PCT / 100);
    let recentTouches = 0;
    const lookback = Math.min(recentDailyCandles.length, 10); // последние 10 дней

    for (let i = recentDailyCandles.length - lookback; i < recentDailyCandles.length; i++) {
      const c = recentDailyCandles[i];
      if (!c) continue;
      const bodyHigh = Math.max(c.open, c.close);
      const bodyLow = Math.min(c.open, c.close);

      if (bodyLow <= level.price + zone && bodyHigh >= level.price - zone) {
        recentTouches++;
      }
    }

    return recentTouches >= MAX_LEVEL_TOUCHES;
  }

  // ────────────────────────────────────────────────
  //  ВСПОМОГАТЕЛЬНЫЕ МЕТОДЫ
  // ────────────────────────────────────────────────

  _estimateTickSize(price) {
    // Примерный размер тика для крипто
    if (price >= 10000) return 1;    // BTC: 1 USD
    if (price >= 1000) return 0.1;   // ETH: 0.1 USD
    if (price >= 100) return 0.01;   // SOL/BNB: 0.01
    if (price >= 1) return 0.001;    // XRP: 0.001
    return 0.0001;
  }

  calculatePositionSize(balance, entry, stopLoss, riskPct) {
    const riskPercent = Math.min(Math.max(riskPct || 1, 0.5), 3);
    const riskAmount = balance * (riskPercent / 100);
    const riskPerUnit = Math.abs(entry - stopLoss);
    if (riskPerUnit <= 0) return 0;
    return riskAmount / riskPerUnit;
  }

  getOptions() {
    return {
      period: {
        label: 'Entry Timeframe',
        default: '5m',
        options: ['5m'],
      },
      dailyTf: {
        label: 'Levels Timeframe',
        default: '1d',
        options: ['1d'],
      },
      confirmTf: {
        label: 'Confirmation Timeframe',
        default: '4h',
        options: ['4h'],
      },
      riskPct: {
        label: 'Risk per trade (%)',
        default: 1,
        min: 0.5,
        max: 3,
      },
    };
  }
}

module.exports = GerchikLevels;
