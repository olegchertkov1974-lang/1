'use strict';

/**
 * Telegram Notifier
 *
 * Sends trade notifications and error alerts via Telegram Bot API.
 * Requires TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID in .env.
 */

const https = require('https');
const logger = require('./logger');

class TelegramNotifier {
  constructor() {
    this.token = process.env.TELEGRAM_BOT_TOKEN;
    this.chatId = process.env.TELEGRAM_CHAT_ID;
    this.enabled = !!(this.token && this.chatId);

    if (!this.enabled) {
      logger.warn('Telegram notifications disabled: TELEGRAM_BOT_TOKEN or TELEGRAM_CHAT_ID not set');
    }
  }

  async sendMessage(text) {
    if (!this.enabled) return;

    const payload = JSON.stringify({
      chat_id: this.chatId,
      text,
      parse_mode: 'HTML',
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'api.telegram.org',
          path: `/bot${this.token}/sendMessage`,
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
              logger.error(`Telegram API error: ${res.statusCode} — ${data}`);
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

  async notifyTrade(signal) {
    const icon = signal.signal === 'long' ? '🟢' : signal.signal === 'short' ? '🔴' : '⚪';
    const msg =
      `${icon} <b>${signal.signal.toUpperCase()}</b> ${signal.type || ''}\n` +
      `Pair: <code>${signal.pair || 'N/A'}</code>\n` +
      `Entry: <code>${signal.entry}</code>\n` +
      `SL: <code>${signal.stopLoss}</code>\n` +
      `TP: <code>${signal.takeProfit}</code>\n` +
      `Size: <code>${signal.positionSize}</code>\n` +
      `Risk: <code>${signal.riskPct}%</code>\n` +
      `R:R: <code>1:${signal.riskRewardRatio}</code>\n` +
      `Reason: ${signal.reason || ''}`;

    try {
      await this.sendMessage(msg);
    } catch (e) {
      logger.error(`Failed to send trade notification: ${e.message}`);
    }
  }

  async notifyClose(info) {
    const msg =
      `⬜ <b>CLOSE</b>\n` +
      `Pair: <code>${info.pair || 'N/A'}</code>\n` +
      `Price: <code>${info.price}</code>\n` +
      `Reason: ${info.reason || ''}`;

    try {
      await this.sendMessage(msg);
    } catch (e) {
      logger.error(`Failed to send close notification: ${e.message}`);
    }
  }

  async notifyError(error) {
    const msg = `⚠️ <b>ERROR</b>\n<code>${String(error).slice(0, 500)}</code>`;
    try {
      await this.sendMessage(msg);
    } catch (e) {
      // don't recurse
    }
  }
}

module.exports = TelegramNotifier;
