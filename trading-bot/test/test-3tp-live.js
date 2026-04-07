'use strict';

/**
 * Тест механики 3 тейк-профитов на Bybit Demo.
 * Открывает 10 LONG позиций минимального размера,
 * затем мониторит TP1/TP2/TP3 на каждой.
 *
 * Запуск на VPS:
 *   cd /opt/trading-bot/trading-bot
 *   node test/test-3tp-live.js
 *
 * Для отмены: Ctrl+C (закроет все тестовые позиции)
 */

require('dotenv').config({ path: require('path').resolve(__dirname, '..', '.env') });

const BybitExchange = require('../src/bybit-exchange');
const logger = require('../src/logger');

// ── Настройки теста ──
const PAIRS = [
  'BTC/USDT', 'ETH/USDT', 'SOL/USDT', 'BNB/USDT', 'XRP/USDT',
  'DOGE/USDT', 'ADA/USDT', 'AVAX/USDT', 'LINK/USDT', 'DOT/USDT',
];

const SL_PCT = 1;    // стоп 1% от входа
const LEVERAGE = 10;

// Минимальные размеры позиций на Bybit (в базовой валюте)
const MIN_SIZES = {
  'BTC/USDT': 0.001,
  'ETH/USDT': 0.01,
  'SOL/USDT': 0.1,
  'BNB/USDT': 0.01,
  'XRP/USDT': 1,
  'DOGE/USDT': 10,
  'ADA/USDT': 1,
  'AVAX/USDT': 0.1,
  'LINK/USDT': 0.1,
  'DOT/USDT': 0.1,
};

// ── Состояние ──
const exchange = new BybitExchange();
const positions = new Map(); // pair -> { entry, sl, tp1, tp2, tp3, size, _tp1Hit, _tp2Hit, _originalSize }

// Telegram уведомление (опционально)
let notifier = null;
try {
  const TelegramNotifier = require('../src/telegram-notifier');
  notifier = new TelegramNotifier();
} catch (e) {
  console.log('Telegram не подключён — только консоль');
}

async function sendTg(msg) {
  if (notifier) {
    try { await notifier.sendMessage(msg); } catch (e) { /* skip */ }
  }
}

// ── Открытие позиций ──
async function openTestPositions() {
  console.log('\n═══════════════════════════════════════');
  console.log('  ТЕСТ 3 ТЕЙК-ПРОФИТОВ — ОТКРЫТИЕ');
  console.log('═══════════════════════════════════════\n');

  await sendTg('🧪 <b>ТЕСТ 3 TP — старт</b>\nОткрытие 10 LONG позиций...');

  // Установить плечо
  for (const pair of PAIRS) {
    try {
      await exchange.setLeverage(pair, LEVERAGE);
    } catch (e) { /* ok */ }
  }

  let opened = 0;
  for (const pair of PAIRS) {
    try {
      // Получаем текущую цену
      const ticker = await exchange.fetchTicker(pair);
      const price = ticker.last;
      const size = MIN_SIZES[pair] || 0.01;

      // Расчёт уровней
      const sl = parseFloat((price * (1 - SL_PCT / 100)).toFixed(8));
      const risk = price - sl;
      const tp1 = parseFloat((price + risk * 1).toFixed(8));  // 1R
      const tp2 = parseFloat((price + risk * 2).toFixed(8));  // 2R
      const tp3 = parseFloat((price + risk * 3).toFixed(8));  // 3R

      // Открываем MARKET LONG
      console.log(`Открытие LONG ${pair}: цена=${price} размер=${size}`);
      const order = await exchange.exchange.createOrder(
        exchange._toLinear(pair), 'market', 'buy', size
      );

      const fillPrice = order.average || order.price || price;

      // Ставим SL + TP3 на бирже
      await exchange.setTradingStop(pair, { stopLoss: sl, takeProfit: tp3 });

      positions.set(pair, {
        entry: fillPrice,
        sl, tp1, tp2, tp3,
        size,
        _originalSize: size,
        _tp1Hit: false,
        _tp2Hit: false,
        orderId: order.id,
      });

      const msg =
        `✅ ${pair} LONG\n` +
        `  Вход: ${fillPrice}\n` +
        `  SL: ${sl} (-${SL_PCT}%)\n` +
        `  TP1 (1R, 30%): ${tp1}\n` +
        `  TP2 (2R, 40%): ${tp2}\n` +
        `  TP3 (3R, 30%): ${tp3}\n` +
        `  Размер: ${size}`;
      console.log(msg);
      logger.info(`TEST 3TP: ${msg.replace(/\n/g, ' | ')}`);

      opened++;

      // Пауза между ордерами (rate limit)
      await sleep(500);
    } catch (err) {
      console.error(`❌ ${pair}: ${err.message}`);
      logger.error(`TEST 3TP ${pair}: ${err.message}`);
    }
  }

  const summary = `🧪 <b>ТЕСТ 3 TP</b>\nОткрыто: ${opened}/${PAIRS.length}\n\n` +
    [...positions.entries()].map(([pair, p]) =>
      `${pair}: ${p.entry} | SL=${p.sl} | TP1=${p.tp1} | TP2=${p.tp2} | TP3=${p.tp3}`
    ).join('\n');
  await sendTg(summary);

  console.log(`\nОткрыто ${opened} позиций. Запуск мониторинга TP...\n`);
}

// ── Мониторинг TP уровней ──
async function monitorTPs() {
  console.log('─── Мониторинг TP (каждые 10с) ───\n');

  while (positions.size > 0) {
    for (const [pair, pos] of [...positions]) {
      try {
        const ticker = await exchange.fetchTicker(pair);
        const price = ticker.last;
        const profit = price - pos.entry;
        const risk = pos.entry - pos.sl;
        const profitR = risk > 0 ? (profit / risk).toFixed(2) : '?';

        // ── TP1: 1R — закрыть 30%, SL → безубыток ──
        if (!pos._tp1Hit && price >= pos.tp1) {
          const closeSize = parseFloat((pos._originalSize * 0.3).toFixed(6));
          console.log(`🎯 TP1 HIT ${pair}: цена ${price} >= ${pos.tp1} | закрытие 30% (${closeSize})`);
          logger.info(`TEST 3TP TP1 HIT ${pair}: price=${price} tp1=${pos.tp1} close=${closeSize}`);

          try {
            await exchange.closePartial(pair, 'long', closeSize, 'TEST TP1');
            pos._tp1Hit = true;
            pos.size = parseFloat((pos.size - closeSize).toFixed(6));

            // SL → безубыток
            await exchange.setTradingStop(pair, { stopLoss: pos.entry, takeProfit: pos.tp3 });
            pos.sl = pos.entry;

            const pnl = (price - pos.entry) * closeSize;
            const msg = `🎯 <b>TP1 (1R)</b> ${pair}\nЗакрыто 30% (${closeSize}) по ${price}\nPnL: ${pnl.toFixed(4)} USDT\n🔒 SL → ${pos.entry}\nОстаток: ${pos.size}`;
            await sendTg(msg);
            console.log(`   PnL=${pnl.toFixed(4)} | SL→${pos.entry} | остаток=${pos.size}`);
          } catch (e) {
            console.error(`   TP1 ошибка ${pair}: ${e.message}`);
          }
        }

        // ── TP2: 2R — закрыть 40% ──
        if (pos._tp1Hit && !pos._tp2Hit && price >= pos.tp2) {
          const closeSize = parseFloat((pos._originalSize * 0.4).toFixed(6));
          const actualClose = Math.min(closeSize, pos.size);
          console.log(`🎯🎯 TP2 HIT ${pair}: цена ${price} >= ${pos.tp2} | закрытие 40% (${actualClose})`);
          logger.info(`TEST 3TP TP2 HIT ${pair}: price=${price} tp2=${pos.tp2} close=${actualClose}`);

          try {
            await exchange.closePartial(pair, 'long', actualClose, 'TEST TP2');
            pos._tp2Hit = true;
            pos.size = parseFloat((pos.size - actualClose).toFixed(6));

            await exchange.setTradingStop(pair, { stopLoss: pos.sl, takeProfit: pos.tp3 });

            const pnl = (price - pos.entry) * actualClose;
            const msg = `🎯🎯 <b>TP2 (2R)</b> ${pair}\nЗакрыто 40% (${actualClose}) по ${price}\nPnL: ${pnl.toFixed(4)} USDT\nОстаток: ${pos.size}`;
            await sendTg(msg);
            console.log(`   PnL=${pnl.toFixed(4)} | остаток=${pos.size}`);
          } catch (e) {
            console.error(`   TP2 ошибка ${pair}: ${e.message}`);
          }
        }

        // ── TP3: 3R — позиция закрывается биржей ──
        // Проверяем, жива ли позиция
        if (pos._tp2Hit) {
          const openPos = await exchange.fetchOpenPositions(pair);
          const alive = openPos.some(p => Math.abs(p.contracts) > 0);
          if (!alive) {
            console.log(`🏆 TP3 DONE ${pair}: позиция полностью закрыта биржей`);
            logger.info(`TEST 3TP TP3 DONE ${pair}`);
            await sendTg(`🏆 <b>TP3 (3R)</b> ${pair}\nПозиция полностью закрыта!\nВсе 3 тейка отработали.`);
            positions.delete(pair);
          }
        }

        // Проверка SL (позиция закрыта)
        if (price <= pos.sl && !pos._tp1Hit) {
          const openPos = await exchange.fetchOpenPositions(pair);
          const alive = openPos.some(p => Math.abs(p.contracts) > 0);
          if (!alive) {
            console.log(`🛑 SL HIT ${pair}: цена ${price} <= ${pos.sl}`);
            logger.info(`TEST 3TP SL HIT ${pair}: price=${price}`);
            await sendTg(`🛑 <b>SL</b> ${pair}\nЗакрыта по стопу ${pos.sl}`);
            positions.delete(pair);
          }
        }

      } catch (err) {
        console.error(`Мониторинг ${pair}: ${err.message}`);
      }

      await sleep(200); // rate limit
    }

    // Статус каждые 10с
    const statusLine = [...positions.entries()].map(([pair, p]) => {
      const tp = p._tp2Hit ? 'TP2✅' : p._tp1Hit ? 'TP1✅' : '...';
      return `${pair.replace('/USDT', '')}:${tp}`;
    }).join(' | ');
    if (statusLine) {
      process.stdout.write(`\r[${new Date().toISOString().slice(11, 19)}] ${statusLine}    `);
    }

    await sleep(10000); // 10с между циклами
  }

  console.log('\n\n✅ Все позиции закрыты. Тест завершён.');
  await sendTg('✅ <b>ТЕСТ 3 TP завершён</b>\nВсе позиции обработаны.');
}

// ── Graceful shutdown — закрыть все тестовые позиции ──
async function cleanup() {
  console.log('\n\n🧹 Закрытие всех тестовых позиций...');
  for (const [pair, pos] of positions) {
    try {
      // Получаем актуальный размер с биржи
      const openPos = await exchange.fetchOpenPositions(pair);
      for (const p of openPos) {
        if (Math.abs(p.contracts) > 0) {
          await exchange.closePosition(pair, 'long', Math.abs(p.contracts));
          console.log(`  Закрыта: ${pair} (${Math.abs(p.contracts)})`);
        }
      }
    } catch (e) {
      console.error(`  Ошибка закрытия ${pair}: ${e.message}`);
    }
  }
  positions.clear();
  console.log('Всё закрыто.');
  process.exit(0);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

// ── Запуск ──
process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);

(async () => {
  try {
    await openTestPositions();
    await monitorTPs();
  } catch (err) {
    console.error(`Фатальная ошибка: ${err.message}`);
    await cleanup();
  }
})();
