'use strict';

/**
 * Тестовый скрипт: проверка полного цикла ордера на Bybit Demo.
 *
 * 1. Открывает LONG по рынку (минимальный объём)
 * 2. Выставляет SL и TP через setTradingStop
 * 3. Проверяет что SL/TP установлены на позиции
 * 4. Переносит SL в безубыток (SL = entry)
 * 5. Проверяет что SL обновлён
 * 6. Закрывает позицию по рынку
 *
 * Запуск: node test/test-order-flow.js
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const BybitExchange = require('../src/bybit-exchange');
const logger = require('../src/logger');

const PAIR = 'BTC/USDT';

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function main() {
  const ex = new BybitExchange();

  console.log('\n════════════════════════════════════════');
  console.log('  ТЕСТ: полный цикл ордера на Bybit Demo');
  console.log('════════════════════════════════════════\n');

  // 0. Баланс
  const balance = await ex.fetchBalance();
  console.log(`✅ Баланс: ${balance.free} USDT свободно (всего: ${balance.total})`);

  // 1. Получаем текущую цену
  const ticker = await ex.fetchTicker(PAIR);
  const price = ticker.last;
  console.log(`✅ Цена ${PAIR}: ${price}`);

  // Минимальный объём BTC = 0.001
  const qty = 0.001;
  const slPrice = Math.round(price * 0.995);   // SL на -0.5% от цены
  const tpPrice = Math.round(price * 1.01);     // TP на +1% от цены

  console.log(`\n─── Шаг 1: Открытие LONG по рынку ───`);
  console.log(`   Объём: ${qty} BTC`);
  console.log(`   SL план: ${slPrice} (-0.5%)`);
  console.log(`   TP план: ${tpPrice} (+1%)`);

  // 2. Открываем позицию по рынку (без SL/TP пока)
  const order = await ex.exchange.createOrder(
    ex._toLinear(PAIR), 'market', 'buy', qty, undefined, {}
  );
  console.log(`✅ Ордер размещён: id=${order.id}, status=${order.status}`);

  await sleep(2000); // ждём исполнения

  // 3. Проверяем позицию
  const positions1 = await ex.fetchOpenPositions(PAIR);
  const pos1 = positions1.find(p => {
    const sym = (p.symbol || '').replace(':USDT', '');
    return sym === PAIR;
  });

  if (!pos1) {
    console.log('❌ Позиция не найдена после открытия!');
    return;
  }

  const entryPrice = pos1.entryPrice || parseFloat(pos1.info?.avgPrice || '0');
  console.log(`✅ Позиция открыта: entry=${entryPrice}, side=${pos1.side}, size=${pos1.contracts}`);
  console.log(`   SL на позиции: ${pos1.stopLossPrice || 'нет'}`);
  console.log(`   TP на позиции: ${pos1.takeProfitPrice || 'нет'}`);

  // 4. Ставим SL и TP через setTradingStop
  console.log(`\n─── Шаг 2: Установка SL=${slPrice} и TP=${tpPrice} ───`);

  await ex.setTradingStop(PAIR, {
    stopLoss: slPrice,
    takeProfit: tpPrice,
  });
  console.log(`✅ setTradingStop вызван`);

  await sleep(2000);

  // 5. Проверяем что SL/TP установились
  const positions2 = await ex.fetchOpenPositions(PAIR);
  const pos2 = positions2.find(p => {
    const sym = (p.symbol || '').replace(':USDT', '');
    return sym === PAIR;
  });

  const actualSL = pos2?.stopLossPrice || parseFloat(pos2?.info?.stopLoss || '0');
  const actualTP = pos2?.takeProfitPrice || parseFloat(pos2?.info?.takeProfit || '0');

  console.log(`   SL на позиции: ${actualSL} (ожидали: ${slPrice})`);
  console.log(`   TP на позиции: ${actualTP} (ожидали: ${tpPrice})`);

  if (Math.abs(actualSL - slPrice) < 1) {
    console.log(`✅ SL установлен верно`);
  } else {
    console.log(`❌ SL НЕ совпадает! actual=${actualSL} expected=${slPrice}`);
  }

  if (Math.abs(actualTP - tpPrice) < 1) {
    console.log(`✅ TP установлен верно`);
  } else {
    console.log(`❌ TP НЕ совпадает! actual=${actualTP} expected=${tpPrice}`);
  }

  // 6. Перенос SL в безубыток (SL ближе к текущей цене, но ниже неё для LONG)
  // Для LONG: SL должен быть НИЖЕ текущей цены. Берём entry - маленький буфер
  const ticker2 = await ex.fetchTicker(PAIR);
  const nowPrice = ticker2.last;
  // Безубыток = чуть ниже текущей цены (чтобы Bybit не отклонил)
  const breakevenSL = Math.round(Math.min(entryPrice, nowPrice) - 10);
  console.log(`\n─── Шаг 3: Безубыток — SL → ${breakevenSL} (≈entry, ниже текущей ${nowPrice}) ───`);

  // ВАЖНО: передаём и TP, иначе Bybit его сбросит!
  await ex.setTradingStop(PAIR, {
    stopLoss: breakevenSL,
    takeProfit: tpPrice,
  });
  console.log(`✅ setTradingStop (безубыток) вызван`);

  await sleep(2000);

  // 7. Проверяем обновлённый SL
  const positions3 = await ex.fetchOpenPositions(PAIR);
  const pos3 = positions3.find(p => {
    const sym = (p.symbol || '').replace(':USDT', '');
    return sym === PAIR;
  });

  const actualSL2 = pos3?.stopLossPrice || parseFloat(pos3?.info?.stopLoss || '0');
  const actualTP2 = pos3?.takeProfitPrice || parseFloat(pos3?.info?.takeProfit || '0');

  console.log(`   SL на позиции: ${actualSL2} (ожидали: ${breakevenSL})`);
  console.log(`   TP на позиции: ${actualTP2} (должен остаться: ${tpPrice})`);

  if (Math.abs(actualSL2 - breakevenSL) < 1) {
    console.log(`✅ Безубыток установлен верно — SL = entry`);
  } else {
    console.log(`❌ Безубыток НЕ сработал! actual=${actualSL2} expected=${breakevenSL}`);
  }

  if (Math.abs(actualTP2 - tpPrice) < 1) {
    console.log(`✅ TP не изменился — OK`);
  } else {
    console.log(`⚠️  TP изменился: ${actualTP2} (был ${tpPrice})`);
  }

  // 8. Закрываем позицию
  console.log(`\n─── Шаг 4: Закрытие позиции ───`);

  const closeOrder = await ex.exchange.createOrder(
    ex._toLinear(PAIR), 'market', 'sell', qty, undefined, { reduceOnly: true }
  );
  console.log(`✅ Позиция закрыта: id=${closeOrder.id}`);

  await sleep(1000);

  // 9. Финальная проверка
  const positions4 = await ex.fetchOpenPositions(PAIR);
  const remaining = positions4.filter(p => {
    const sym = (p.symbol || '').replace(':USDT', '');
    return sym === PAIR;
  });

  if (remaining.length === 0) {
    console.log(`✅ Позиция полностью закрыта`);
  } else {
    console.log(`❌ Позиция всё ещё открыта!`);
  }

  console.log('\n════════════════════════════════════════');
  console.log('  ТЕСТ ЗАВЕРШЁН');
  console.log('════════════════════════════════════════\n');
}

main().catch(err => {
  console.error(`\n❌ ОШИБКА: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
