'use strict';

/**
 * Telegram Notifier + Command Handler
 *
 * Sends trade notifications and provides inline keyboard
 * for bot management (stop, close positions, status).
 */

const https = require('https');
const logger = require('./logger');

class TelegramNotifier {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);
    this._polling = false;
    this._lastUpdateId = 0;
    this._bot = null; // Reference to TradingBot, set via setBot()

    if (!this.enabled) {
      logger.warn('Telegram notifications disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    }
  }

  /**
   * Set reference to main bot for command handling.
   */
  setBot(bot) {
    this._bot = bot;
  }

  /**
   * Start polling for Telegram updates (commands & button presses).
   */
  startPolling() {
    if (!this.enabled) return;
    this._polling = true;
    this._pollLoop();
    logger.info('Telegram: command polling started');
  }

  stopPolling() {
    this._polling = false;
  }

  async _pollLoop() {
    while (this._polling) {
      try {
        const updates = await this._getUpdates();
        for (const update of updates) {
          this._lastUpdateId = update.update_id + 1;
          try {
            await this._handleUpdate(update);
          } catch (err) {
            logger.error(`Telegram update handler error: ${err.message}`);
          }
        }
      } catch (err) {
        logger.error(`Telegram polling error: ${err.message}`);
      }
      await new Promise((r) => setTimeout(r, 1500));
    }
  }

  _getUpdates() {
    return new Promise((resolve, reject) => {
      const url = `/bot${this.token}/getUpdates?offset=${this._lastUpdateId}&timeout=5&allowed_updates=["message","callback_query"]`;
      const req = https.request(
        { hostname: 'api.telegram.org', path: url, method: 'GET', timeout: 15000 },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            try {
              const json = JSON.parse(data);
              resolve(json.ok ? json.result : []);
            } catch { resolve([]); }
          });
        }
      );
      req.on('error', reject);
      req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
      req.end();
    });
  }

  async _handleUpdate(update) {
    // Handle button presses (callback queries)
    if (update.callback_query) {
      const cb = update.callback_query;
      const chatId = cb.message?.chat?.id;
      if (String(chatId) !== String(this.chatId)) return;
      await this._handleCallback(cb);
      return;
    }

    // Handle text commands
    if (update.message?.text) {
      const chatId = update.message.chat.id;
      if (String(chatId) !== String(this.chatId)) return;
      await this._handleCommand(update.message.text, chatId);
    }
  }

  async _handleCommand(text, chatId) {
    const cmd = text.trim().toLowerCase();

    if (cmd === '/start' || cmd === '/menu' || cmd === '/help') {
      await this._sendMainMenu();
    } else if (cmd === '/status') {
      await this._cmdStatus();
    } else if (cmd === '/positions') {
      await this._cmdPositions();
    } else if (cmd === '/levels') {
      await this._cmdLevels();
    } else if (cmd === '/orders') {
      await this._cmdOrders();
    } else if (cmd === '/balance') {
      await this._cmdBalance();
    } else if (cmd === '/report') {
      await this._cmdReport();
    } else if (cmd === '/history') {
      await this._cmdHistory();
    } else if (cmd === '/logs') {
      await this._cmdLogs();
    } else if (cmd === '/settings') {
      await this._cmdSettings();
    } else if (cmd === '/stop') {
      await this._cmdStop();
    } else if (cmd === '/close_all') {
      await this._cmdCloseAll();
    } else if (cmd === '/pause') {
      await this._cmdPause();
    } else if (cmd === '/resume') {
      await this._cmdResume();
    }
  }

  async _handleCallback(cb) {
    const data = cb.data;

    // Answer callback to remove loading spinner
    await this._answerCallback(cb.id);

    if (data === 'menu') {
      await this._sendMainMenu();
    } else if (data === 'status') {
      await this._cmdStatus();
    } else if (data === 'positions') {
      await this._cmdPositions();
    } else if (data === 'levels') {
      await this._cmdLevels();
    } else if (data === 'orders') {
      await this._cmdOrders();
    } else if (data === 'balance') {
      await this._cmdBalance();
    } else if (data === 'report') {
      await this._cmdReport();
    } else if (data === 'history') {
      await this._cmdHistory();
    } else if (data === 'logs') {
      await this._cmdLogs();
    } else if (data === 'settings') {
      await this._cmdSettings();
    } else if (data === 'refresh_levels') {
      await this._cmdRefreshLevels();
    } else if (data === 'close_all') {
      await this._sendConfirm('close_all_confirm', '⚠️ Закрыть ВСЕ позиции?');
    } else if (data === 'close_all_confirm') {
      await this._cmdCloseAll();
    } else if (data === 'stop_bot') {
      await this._sendConfirm('stop_bot_confirm', '⚠️ Остановить бота?');
    } else if (data === 'stop_bot_confirm') {
      await this._cmdStop();
    } else if (data === 'pause') {
      await this._cmdPause();
    } else if (data === 'resume') {
      await this._cmdResume();
    } else if (data === 'force_scan') {
      await this._cmdForceScan();
    } else if (data.startsWith('close_')) {
      const posKey = data.replace('close_', '');
      if (posKey.endsWith('_confirm')) {
        await this._cmdClosePosition(posKey.replace('_confirm', ''));
      } else {
        await this._sendConfirm(`close_${posKey}_confirm`, `⚠️ Закрыть позицию ${posKey}?`);
      }
    } else if (data === 'cancel') {
      await this.sendMessage('❌ Отменено');
    }
  }

  async _sendMainMenu() {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '📊 Статус', callback_data: 'status' },
          { text: '📋 Позиции', callback_data: 'positions' },
        ],
        [
          { text: '📈 Уровни', callback_data: 'levels' },
          { text: '⏳ Ордера', callback_data: 'orders' },
        ],
        [
          { text: '💰 Баланс', callback_data: 'balance' },
          { text: '📊 Отчёт', callback_data: 'report' },
        ],
        [
          { text: '📋 История', callback_data: 'history' },
          { text: '📝 Логи', callback_data: 'logs' },
        ],
        [
          { text: '⚙️ Настройки', callback_data: 'settings' },
          { text: '🔄 Обновить уровни', callback_data: 'refresh_levels' },
        ],
        [
          { text: '⏸ Пауза', callback_data: 'pause' },
          { text: '▶️ Продолжить', callback_data: 'resume' },
        ],
        [
          { text: '🔍 Сканировать', callback_data: 'force_scan' },
          { text: '🔴 Закрыть все', callback_data: 'close_all' },
        ],
        [
          { text: '🛑 Остановить бота', callback_data: 'stop_bot' },
        ],
      ],
    };

    await this._sendWithKeyboard('🤖 <b>Gerchik Bot — Управление</b>\n\nВыберите действие:', keyboard);
  }

  async _sendConfirm(confirmAction, text) {
    const keyboard = {
      inline_keyboard: [
        [
          { text: '✅ Да', callback_data: confirmAction },
          { text: '❌ Отмена', callback_data: 'cancel' },
        ],
      ],
    };
    await this._sendWithKeyboard(text, keyboard);
  }

  async _cmdStatus() {
    if (!this._bot) return;

    try {
      const balance = await this._bot.exchange.fetchBalance();
      const posCount = this._bot.positions.size;
      const paused = this._bot.paused;
      const stats = this._bot.tradeStore.getStats();

      const usedMargin = (balance.total - balance.free).toFixed(2);
      const msg =
        `📊 <b>Статус бота</b>\n\n` +
        `Состояние: ${paused ? '⏸ Пауза' : '✅ Активен'}\n` +
        `💰 Баланс: <code>${balance.total.toFixed(2)} USDT</code>\n` +
        `├ Свободно: <code>${balance.free.toFixed(2)} USDT</code>\n` +
        `└ В маржe: <code>${usedMargin} USDT</code>\n` +
        `Открытых позиций: ${posCount}\n` +
        `Всего сделок: ${stats.total || 0}\n` +
        `Побед/Поражений: ${stats.wins || 0}/${stats.losses || 0}\n` +
        `PnL: <code>${(stats.total_pnl || 0).toFixed(2)} USDT</code>`;

      const keyboard = {
        inline_keyboard: [
          [
            { text: '📋 Позиции', callback_data: 'positions' },
            { text: '◀️ Меню', callback_data: 'menu' },
          ],
        ],
      };
      await this._sendWithKeyboard(msg, keyboard);
    } catch (err) {
      await this.sendMessage(`❌ Ошибка: ${err.message}`);
    }
  }

  async _cmdPositions() {
    if (!this._bot) return;

    const positions = this._bot.positions;
    if (positions.size === 0) {
      const keyboard = {
        inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]],
      };
      await this._sendWithKeyboard('📋 <b>Нет открытых позиций</b>', keyboard);
      return;
    }

    let msg = '📋 <b>Открытые позиции:</b>\n\n';
    const buttons = [];

    for (const [key, pos] of positions) {
      const icon = pos.side === 'long' ? '🟢' : '🔴';
      const sideRu = pos.side === 'long' ? 'ЛОНГ' : 'ШОРТ';
      msg +=
        `${icon} <b>${sideRu}</b> ${key}\n` +
        `  Вход: <code>${pos.entry}</code>\n` +
        `  SL: <code>${pos.stopLoss}</code> | TP: <code>${pos.takeProfit}</code>\n` +
        `  Размер: <code>${pos.size}</code>\n\n`;

      buttons.push([{ text: `❌ Закрыть ${key}`, callback_data: `close_${key}` }]);
    }

    buttons.push([
      { text: '🔴 Закрыть все', callback_data: 'close_all' },
      { text: '◀️ Меню', callback_data: 'menu' },
    ]);

    await this._sendWithKeyboard(msg, { inline_keyboard: buttons });
  }

  async _cmdClosePosition(posKey) {
    if (!this._bot) return;

    const pos = this._bot.positions.get(posKey);
    if (!pos) {
      await this.sendMessage(`❌ Позиция ${posKey} не найдена`);
      return;
    }

    try {
      const pair = posKey.split(':')[0];
      await this._bot.exchange.closePosition(pair, pos.side, pos.size);
      this._bot.riskManager.removePosition(posKey);
      this._bot.positions.delete(posKey);

      await this.sendMessage(`✅ Позиция ${posKey} закрыта`);
      logger.info(`Telegram command: closed position ${posKey}`);
    } catch (err) {
      await this.sendMessage(`❌ Ошибка закрытия ${posKey}: ${err.message}`);
    }
  }

  async _cmdCloseAll() {
    if (!this._bot) return;

    const positions = this._bot.positions;
    if (positions.size === 0) {
      await this.sendMessage('📋 Нет открытых позиций');
      return;
    }

    let closed = 0;
    let errors = 0;

    for (const [key, pos] of [...positions]) {
      try {
        const pair = key.split(':')[0];
        await this._bot.exchange.closePosition(pair, pos.side, pos.size);
        this._bot.riskManager.removePosition(key);
        this._bot.positions.delete(key);
        closed++;
      } catch (err) {
        logger.error(`Failed to close ${key}: ${err.message}`);
        errors++;
      }
    }

    await this.sendMessage(`✅ Закрыто позиций: ${closed}${errors > 0 ? `\n❌ Ошибок: ${errors}` : ''}`);
    logger.info(`Telegram command: close_all — closed ${closed}, errors ${errors}`);
  }

  async _cmdStop() {
    if (!this._bot) return;
    await this.sendMessage('🛑 <b>Бот останавливается...</b>');
    logger.info('Telegram command: stop bot');
    this._bot.stop();
  }

  async _cmdPause() {
    if (!this._bot) return;
    this._bot.paused = true;
    await this.sendMessage('⏸ <b>Бот на паузе</b>\nНовые сигналы не обрабатываются.');
    logger.info('Telegram command: pause');
  }

  async _cmdResume() {
    if (!this._bot) return;
    this._bot.paused = false;
    await this.sendMessage('▶️ <b>Бот возобновлён</b>\nСканирование активно.');
    logger.info('Telegram command: resume');
  }

  async _cmdForceScan() {
    if (!this._bot) return;
    await this.sendMessage('🔍 <b>Принудительное сканирование...</b>');
    logger.info('Telegram command: force_scan');
    try {
      await this._bot._tick();
      await this.sendMessage('✅ Сканирование завершено');
    } catch (err) {
      await this.sendMessage(`❌ Ошибка: ${err.message}`);
    }
  }

  // ─── New command handlers ───

  async _cmdLevels() {
    if (!this._bot) return;
    const dailyLevels = this._bot._dailyLevels;
    if (!dailyLevels || dailyLevels.size === 0) {
      await this._sendWithKeyboard('📈 <b>Уровни ещё не загружены</b>', { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'refresh_levels' }, { text: '◀️ Меню', callback_data: 'menu' }]] });
      return;
    }

    let msg = '📈 <b>Уровни 1D по парам</b>\n\n';
    let count = 0;
    for (const [pair, data] of dailyLevels) {
      if (!data.levels || data.levels.length === 0) continue;
      const top3 = data.levels.slice(0, 3);
      msg += `<b>${pair}</b> (${data.levels.length} ур.)\n`;
      for (const l of top3) {
        const typeIcon = l.isMirror ? '🪞' : l.hasFalseBreakout ? '💥' : '📊';
        msg += `  ${typeIcon} ${l.price.toFixed(2)} | ${l.classification} | сила: ${l.strength}\n`;
      }
      msg += '\n';
      count++;
      if (count >= 10) { msg += `<i>...и ещё ${dailyLevels.size - 10} пар</i>\n`; break; }
    }

    await this._sendWithKeyboard(msg, { inline_keyboard: [[{ text: '🔄 Обновить', callback_data: 'refresh_levels' }, { text: '◀️ Меню', callback_data: 'menu' }]] });
  }

  async _cmdOrders() {
    if (!this._bot) return;
    const pending = this._bot._pendingOrders;
    if (!pending || pending.size === 0) {
      await this._sendWithKeyboard('⏳ <b>Нет активных ордеров</b>', { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
      return;
    }

    let msg = '⏳ <b>Активные лимитные ордера</b>\n\n';
    for (const [orderId, p] of pending) {
      const sideIcon = p.direction === 'long' ? '🟢' : '🔴';
      const sideRu = p.direction === 'long' ? 'ЛОНГ' : 'ШОРТ';
      const waitMin = Math.floor((Date.now() - p.createdAt) / 60000);
      msg += `${sideIcon} <b>${sideRu}</b> ${p.pair}\n`;
      msg += `  Вход: <code>${p.signal?.entry || '?'}</code>\n`;
      msg += `  Уровень: <code>${p.level?.price?.toFixed(2) || '?'}</code>\n`;
      msg += `  Ожидание: ${waitMin} мин\n`;
      msg += `  ID: <code>${orderId}</code>\n\n`;
    }

    await this._sendWithKeyboard(msg, { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
  }

  async _cmdBalance() {
    if (!this._bot) return;
    try {
      const balance = await this._bot.exchange.fetchBalance();
      const msg = `💰 <b>Баланс</b>\n\n` +
        `Всего: <code>${balance.total.toFixed(2)} USDT</code>\n` +
        `Свободно: <code>${balance.free.toFixed(2)} USDT</code>\n` +
        `В марже: <code>${(balance.total - balance.free).toFixed(2)} USDT</code>`;
      await this._sendWithKeyboard(msg, { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
    } catch (err) {
      await this.sendMessage(`❌ ${err.message}`);
    }
  }

  async _cmdReport() {
    if (!this._bot) return;
    try {
      await this.sendMessage('📊 <b>Генерация отчёта...</b>');
      const today = new Date().toISOString().slice(0, 10);
      await this._bot._generateAndSendDailyReport(today);
    } catch (err) {
      await this.sendMessage(`❌ Ошибка отчёта: ${err.message}`);
    }
  }

  async _cmdHistory() {
    if (!this._bot) return;
    const trades = this._bot.tradeStore.getRecentTrades(10);
    if (!trades || trades.length === 0) {
      await this._sendWithKeyboard('📋 <b>Нет закрытых сделок</b>', { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
      return;
    }

    let msg = '📋 <b>Последние 10 сделок</b>\n\n';
    for (const t of trades) {
      const icon = (t.pnl || 0) > 0 ? '✅' : (t.pnl || 0) < 0 ? '❌' : '⬜';
      const sideRu = t.side === 'long' ? 'L' : 'S';
      const closeRu = { tp: 'TP', sl: 'SL', breakeven: 'BE' }[t.close_type] || t.close_type || '?';
      msg += `${icon} ${sideRu} <b>${t.pair}</b> | ${closeRu} | ` +
        `<code>${(t.pnl || 0) >= 0 ? '+' : ''}${(t.pnl || 0).toFixed(2)} USDT</code> | ` +
        `R:R ${t.realized_rr || '?'}\n`;
    }

    await this._sendWithKeyboard(msg, { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
  }

  async _cmdLogs() {
    if (!this._bot) return;
    try {
      const fs = require('fs');
      const path = require('path');
      const logPath = path.resolve(__dirname, '..', 'logs', 'trading-bot.log');
      let lines = [];
      if (fs.existsSync(logPath)) {
        const content = fs.readFileSync(logPath, 'utf8');
        lines = content.split('\n').filter(Boolean).slice(-30);
      }
      if (lines.length === 0) {
        await this.sendMessage('📝 <b>Логи пусты</b>');
        return;
      }

      // Форматируем логи для читаемости
      const formatted = lines.map(line => {
        // Извлекаем время (HH:MM) и сообщение
        const timeMatch = line.match(/T(\d{2}:\d{2})/);
        const time = timeMatch ? timeMatch[1] : '';
        // Убираем timestamp и [INFO]/[WARN]/[ERROR]
        let msg = line.replace(/\[[\d\-T:.Z]+\]\s*/, '').replace(/\[(INFO|DEBUG)\]\s*/, '').trim();

        // Подсветка ключевых событий
        if (line.includes('[ERROR]')) {
          msg = line.replace(/\[[\d\-T:.Z]+\]\s*/, '').replace(/\[ERROR\]\s*/, '').trim();
          return `❌ <b>${time}</b> ${msg}`;
        }
        if (line.includes('[WARN]')) {
          msg = line.replace(/\[[\d\-T:.Z]+\]\s*/, '').replace(/\[WARN\]\s*/, '').trim();
          return `⚠️ <b>${time}</b> ${msg}`;
        }
        if (line.includes('СИГНАЛ')) {
          return `🎯 <b>${time}</b> ${msg}`;
        }
        if (line.includes('нет паттерна')) {
          // Извлекаем пару и уровень
          const pairMatch = msg.match(/^(\w+\/\w+)/);
          const pair = pairMatch ? pairMatch[1] : '';
          const lvlMatch = msg.match(/уровня ([\d.]+)/);
          const lvl = lvlMatch ? lvlMatch[1] : '';
          const dirMatch = msg.match(/\((long|short)\)/);
          const dir = dirMatch ? (dirMatch[1] === 'long' ? '🟢' : '🔴') : '';
          return `🔍 <b>${time} ${pair}</b> ${dir} ждёт паттерн у ${lvl}`;
        }
        if (line.includes('в зоне!')) {
          const pairMatch = msg.match(/^(\w+\/\w+)/);
          const pair = pairMatch ? pairMatch[1] : '';
          return `📍 <b>${time} ${pair}</b> в зоне уровня`;
        }
        if (line.includes('AI') && line.includes('REJECTED') || line.includes('отклонил')) {
          return `🤖 <b>${time}</b> ${msg}`;
        }
        if (line.includes('Ордер исполнен') || line.includes('БЕЗУБЫТОК')) {
          return `✅ <b>${time}</b> ${msg}`;
        }
        if (line.includes('Сканирование 5m')) {
          return `\n⏰ <b>${time} ─── 5m скан ───</b>`;
        }
        if (line.includes('Баланс:')) {
          return `💰 <b>${time}</b> ${msg}`;
        }
        // Пропускаем малоинформативные строки
        if (line.includes('ближайший уровень')) {
          const pairMatch = msg.match(/^(\w+\/\w+)/);
          const pair = pairMatch ? pairMatch[1] : '';
          const priceMatch = msg.match(/цена ([\d.]+)/);
          const price = priceMatch ? priceMatch[1] : '';
          const lvlMatch = msg.match(/уровень ([\d.]+)/);
          const lvl = lvlMatch ? lvlMatch[1] : '';
          const distMatch = msg.match(/\(([\-\d.]+%)\)/);
          const dist = distMatch ? distMatch[1] : '';
          return `  ${pair}: ${price} → ${lvl} (${dist})`;
        }

        return `  ${time} ${msg}`;
      });

      const msg = '📝 <b>Лог</b>\n\n' + formatted.join('\n');
      // Telegram limit 4096 chars
      const trimmed = msg.length > 4000 ? msg.slice(0, 4000) + '...' : msg;
      await this._sendWithKeyboard(trimmed, { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
    } catch (err) {
      await this.sendMessage(`📝 <b>Логи недоступны</b>\n${err.message}`);
    }
  }

  async _cmdSettings() {
    if (!this._bot) return;
    const rm = this._bot.riskManager;
    const pairs = this._bot._dailyLevels ? this._bot._dailyLevels.size : 0;
    const leverage = process.env.LEVERAGE || '10';
    const msg = '⚙️ <b>Настройки бота</b>\n\n' +
      `Пар: <code>${pairs}</code>\n` +
      `ТФ уровней: <code>1D</code>\n` +
      `ТФ тренда: <code>4H</code>\n` +
      `ТФ входа: <code>5m</code>\n` +
      `Риск на сделку: <code>${rm.riskPct}%</code>\n` +
      `Мин R:R: <code>1:${rm.minRR}</code>\n` +
      `Макс позиций: <code>${rm.maxConcurrent}</code>\n` +
      `Плечо: <code>${leverage}x</code>\n` +
      `AI фильтр: <code>${process.env.AI_FILTER_ENABLED !== 'false' ? 'ВКЛ' : 'ВЫКЛ'}</code>\n` +
      `Мин AI уверенность: <code>${process.env.AI_MIN_CONFIDENCE || 60}%</code>\n` +
      `Интервал: <code>${process.env.POLL_INTERVAL_MS || 60000}мс</code>\n` +
      `Безубыток: <code>ВКЛ (после 1R)</code>`;
    await this._sendWithKeyboard(msg, { inline_keyboard: [[{ text: '◀️ Меню', callback_data: 'menu' }]] });
  }

  async _cmdRefreshLevels() {
    if (!this._bot) return;
    await this.sendMessage('🔄 <b>Обновление уровней...</b>');
    try {
      this._bot._lastLevelUpdate = 0; // сбросить таймер
      await this._bot._updateDailyLevels();
      this._bot._lastLevelUpdate = Date.now();
      let total = 0;
      for (const [, data] of this._bot._dailyLevels) total += data.levels.length;
      await this.sendMessage(`✅ Уровни обновлены: ${total} по ${this._bot._dailyLevels.size} парам`);
    } catch (err) {
      await this.sendMessage(`❌ Ошибка: ${err.message}`);
    }
  }

  // ─── Core API methods ───

  async sendMessage(text) {
    if (!this.enabled) return;

    const payload = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
    });

    return this._apiRequest('sendMessage', payload);
  }

  async _sendWithKeyboard(text, keyboard) {
    if (!this.enabled) return;

    const payload = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
      disable_web_page_preview: true,
      reply_markup: keyboard,
    });

    return this._apiRequest('sendMessage', payload);
  }

  async _answerCallback(callbackQueryId) {
    const payload = JSON.stringify({ callback_query_id: callbackQueryId });
    return this._apiRequest('answerCallbackQuery', payload).catch(() => {});
  }

  _apiRequest(method, payload) {
    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${this.token}/${method}`,
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 10000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode === 200) {
              resolve(data);
            } else {
              logger.error(`Telegram API error (${method}): ${res.statusCode} — ${data}`);
              reject(new Error(`Telegram: ${res.statusCode}`));
            }
          });
        }
      );

      req.on('error', (err) => {
        logger.error(`Telegram request error: ${err.message}`);
        reject(err);
      });

      req.on('timeout', () => {
        req.destroy();
        logger.error('Telegram request timed out');
        reject(new Error('Telegram timeout'));
      });

      req.write(payload);
      req.end();
    });
  }

  // ─── Notification methods ───

  async notifyTrade(signal) {
    const icon = signal.signal === 'long' ? '🟢' : signal.signal === 'short' ? '🔴' : '⚪';
    const sideRu = signal.signal === 'long' ? 'ЛОНГ' : 'ШОРТ';
    const typeMap = {
      'false_breakout': 'Ложный пробой',
      'bounce': 'Отскок',
      'engulfing': 'Поглощение',
      'base': 'База (проторговка)',
      'breakout': 'Пробой',
    };
    const typeRu = signal.typeRu || typeMap[signal.type] || (signal.type || '');

    let msg =
      `${icon} <b>ОТКРЫТА ПОЗИЦИЯ: ${sideRu}</b>\n` +
      `━━━━━━━━━━━━━━━━━━\n` +
      `Пара: <code>${signal.pair || 'N/A'}</code>\n` +
      `Тип: <b>${typeRu}</b>\n` +
      `Вход: <code>${signal.entry}</code>\n` +
      `SL: <code>${signal.stopLoss}</code>\n` +
      `TP: <code>${signal.takeProfit}</code>\n` +
      `Размер: <code>${signal.positionSize}</code>\n` +
      `Риск: <code>${signal.riskPct}% ($${signal.riskAmount || '?'})</code>\n` +
      `R:R: <code>1:${signal.riskRewardRatio}</code>\n` +
      `\n📐 <b>Уровень:</b> ${signal.reason || ''}`;

    // AI analysis details
    if (signal._aiConfidence) {
      msg += `\n\n🤖 <b>AI анализ</b> (${signal._aiConfidence}%):\n${signal._aiReason || ''}`;
    }

    // Market regime
    if (signal._regime && signal._regime.regime !== 'unknown') {
      const regimeRu = {
        'trending_up': '📈 Восходящий тренд',
        'trending_down': '📉 Нисходящий тренд',
        'ranging': '↔️ Боковик (флэт)',
        'volatile': '⚡ Высокая волатильность',
      };
      msg += `\n\n🌍 <b>Режим рынка:</b> ${regimeRu[signal._regime.regime] || signal._regime.regime}`;
      if (signal._regime.suggestion) {
        msg += `\n${signal._regime.suggestion}`;
      }
    }

    const keyboard = {
      inline_keyboard: [
        [{ text: '📋 Позиции', callback_data: 'positions' }, { text: '◀️ Меню', callback_data: 'menu' }],
      ],
    };

    try {
      await this._sendWithKeyboard(msg, keyboard);
    } catch (e) {
      logger.error(`Failed to send trade notification: ${e.message}`);
    }
  }

  async notifyClose(info) {
    const pnlIcon = info.pnl > 0 ? '✅' : info.pnl < 0 ? '❌' : '⬜';
    const msg =
      `${pnlIcon} <b>ЗАКРЫТИЕ</b>\n` +
      `Пара: <code>${info.pair || 'N/A'}</code>\n` +
      `Цена: <code>${info.price}</code>\n` +
      `PnL: <code>${info.pnl !== undefined ? info.pnl + ' USDT' : '?'}</code>\n` +
      `Причина: ${info.reason || ''}`;

    try {
      await this.sendMessage(msg);
    } catch (e) {
      logger.error(`Failed to send close notification: ${e.message}`);
    }
  }

  async notifyError(error) {
    const msg = `⚠️ <b>ОШИБКА</b>\n<code>${String(error).slice(0, 500)}</code>`;
    try {
      await this.sendMessage(msg);
    } catch (e) {
      // don't recurse
    }
  }

  async notifyDailySummary(stats) {
    const winRate = stats.total > 0 ? ((stats.wins / stats.total) * 100).toFixed(1) : '0';
    const msg =
      `📈 <b>Дневной отчёт</b>\n` +
      `Сделок: ${stats.total}\n` +
      `Побед: ${stats.wins} | Поражений: ${stats.losses}\n` +
      `Винрейт: ${winRate}%\n` +
      `Итого PnL: <code>${stats.total_pnl || stats.totalPnl || 0} USDT</code>`;

    try {
      await this.sendMessage(msg);
    } catch (e) {
      logger.error(`Failed to send daily summary: ${e.message}`);
    }
  }

  /**
   * Отправить полный ежедневный финансовый отчёт.
   */
  async sendDailyReport(report) {
    const r = report;
    const sign = (v) => v >= 0 ? `+${v.toFixed(2)}` : v.toFixed(2);
    const pct = (v) => v >= 0 ? `+${v.toFixed(2)}%` : `${v.toFixed(2)}%`;

    const msg =
      `📊 <b>ЕЖЕДНЕВНЫЙ ФИНАНСОВЫЙ ОТЧЁТ</b>\n` +
      `📅 ${r.date}\n` +
      `━━━━━━━━━━━━━━━━━━━━\n\n` +

      `💰 <b>1. Баланс</b>\n` +
      `├ Текущий: <code>${r.balance.current.toFixed(2)} USDT</code>\n` +
      `├ На начало дня: <code>${r.balance.dayStart.toFixed(2)} USDT</code>\n` +
      `└ Изменение: <code>${sign(r.balance.change)} USDT (${pct(r.balance.changePct)})</code>\n\n` +

      `📈 <b>2. Сделки за день</b>\n` +
      `├ Открыто: ${r.trades.opened}\n` +
      `├ Закрыто: ${r.trades.closed}\n` +
      `├ По тейку: ✅ ${r.trades.tp}\n` +
      `├ По стопу: ❌ ${r.trades.sl}\n` +
      `├ В безубыток: ⬜ ${r.trades.be}\n` +
      `└ P&L: <code>${sign(r.trades.pnl)} USDT</code>\n\n` +

      `💸 <b>3. Комиссии</b>\n` +
      `├ Всего: <code>${r.fees.total.toFixed(4)} USDT</code>\n` +
      `├ Maker (лимитки): <code>${r.fees.maker.toFixed(4)} USDT</code>\n` +
      `└ Taker (стопы): <code>${r.fees.taker.toFixed(4)} USDT</code>\n\n` +

      `📋 <b>4. Ордера</b>\n` +
      `├ Выставлено: ${r.orders.placed}\n` +
      `├ Исполнено: ${r.orders.filled}\n` +
      `├ Отменено: ${r.orders.cancelled}\n` +
      `│  ├ Пробой уровня: ${r.orders.cancelReasons.levelBreak}\n` +
      `│  ├ Таймаут 30мин: ${r.orders.cancelReasons.timeout}\n` +
      `│  └ Смена контекста: ${r.orders.cancelReasons.contextChange}\n\n` +

      `🏆 <b>5. Итого за день</b>\n` +
      `├ Чистый P&L: <code>${sign(r.daily.netPnl)} USDT</code>\n` +
      `├ Винрейт: <code>${r.daily.winRate}%</code>\n` +
      `└ Средний R:R: <code>${r.daily.avgRR}</code>\n\n` +

      `📊 <b>6. Накопительная статистика</b>\n` +
      `   (с ${r.cumulative.startDate})\n` +
      `├ Дней тестирования: ${r.cumulative.days}\n` +
      `├ Стартовый баланс: <code>${r.cumulative.startBalance.toFixed(2)} USDT</code>\n` +
      `├ Текущий баланс: <code>${r.cumulative.currentBalance.toFixed(2)} USDT</code>\n` +
      `├ Общий P&L: <code>${sign(r.cumulative.totalPnl)} USDT (${pct(r.cumulative.totalPnlPct)})</code>\n` +
      `├ Всего сделок: ${r.cumulative.totalTrades} (открыто: ${r.cumulative.openPositions})\n` +
      `├ Винрейт: <code>${r.cumulative.winRate}%</code>\n` +
      `├ Средний R:R: <code>${r.cumulative.avgRR}</code>\n` +
      `├ Макс просадка: <code>${r.cumulative.maxDrawdown.toFixed(2)}%</code>\n` +
      `├ Общие комиссии: <code>${r.cumulative.totalFees.toFixed(4)} USDT</code>\n` +
      `├ 🟢 Лучшая: <code>${sign(r.cumulative.bestTrade)} USDT</code>\n` +
      `├ 🔴 Худшая: <code>${sign(r.cumulative.worstTrade)} USDT</code>\n` +
      `└ Сделок/день: <code>${r.cumulative.tradesPerDay.toFixed(1)}</code>`;

    try {
      await this.sendMessage(msg);
    } catch (e) {
      logger.error(`Failed to send daily report: ${e.message}`);
    }
  }
}

module.exports = TelegramNotifier;
