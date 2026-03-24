const https = require('https');
const http = require('http');

class NotificationService {
  constructor(config = {}) {
    this.telegram = config.telegram || {};
    this.slack = config.slack || {};
  }

  async send(message) {
    const promises = [];

    if (this.telegram.token && this.telegram.chatId) {
      promises.push(this.sendTelegram(message));
    }
    if (this.slack.webhookUrl) {
      promises.push(this.sendSlack(message));
    }

    if (promises.length === 0) {
      console.log('[Notification]', message);
      return;
    }

    const results = await Promise.allSettled(promises);
    for (const result of results) {
      if (result.status === 'rejected') {
        console.error('Notification failed:', result.reason);
      }
    }
  }

  sendTelegram(message) {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({
        chat_id: this.telegram.chatId,
        text: message,
        parse_mode: 'HTML'
      });

      const options = {
        hostname: 'api.telegram.org',
        path: `/bot${this.telegram.token}/sendMessage`,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = https.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Telegram API error: ${res.statusCode} ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }

  sendSlack(message) {
    return new Promise((resolve, reject) => {
      const url = new URL(this.slack.webhookUrl);
      const data = JSON.stringify({ text: message });
      const transport = url.protocol === 'https:' ? https : http;

      const options = {
        hostname: url.hostname,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      };

      const req = transport.request(options, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve(body);
          } else {
            reject(new Error(`Slack webhook error: ${res.statusCode} ${body}`));
          }
        });
      });

      req.on('error', reject);
      req.write(data);
      req.end();
    });
  }
}

module.exports = { NotificationService };
