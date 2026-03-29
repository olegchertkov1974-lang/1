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
      // close_BTC/USDT:15m
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
}

module.exports = TelegramNotifier;
