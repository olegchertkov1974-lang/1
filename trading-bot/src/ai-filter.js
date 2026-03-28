'use strict';

/**
 * OpenRouter AI Filter
 *
 * Sends trading signals to OpenRouter (Claude/GPT/Llama) for AI validation.
 * Also provides post-trade analysis and market regime detection.
 */

const https = require('https');
const logger = require('./logger');

class AIFilter {
  constructor() {
    this.apiKey = process.env.OPENROUTER_API_KEY;
    this.model = process.env.OPENROUTER_MODEL || 'anthropic/claude-3.5-sonnet';
    this.enabled = !!this.apiKey;

    if (!this.enabled) {
      logger.warn('AI Filter disabled: OPENROUTER_API_KEY not set');
    }
  }

  /**
   * Ask OpenRouter to validate a trading signal before execution.
   * Returns { approved: boolean, confidence: number, reason: string }
   */
  async validateSignal(signal, candles, levels) {
    if (!this.enabled) return { approved: true, confidence: 0, reason: 'AI filter disabled' };

    const last10 = candles.slice(-10).map((c) => ({
      o: c.open.toFixed(2),
      h: c.high.toFixed(2),
      l: c.low.toFixed(2),
      c: c.close.toFixed(2),
      v: Math.round(c.volume),
    }));

    const topLevels = levels.slice(0, 5).map((l) => ({
      price: l.price.toFixed(2),
      type: l.type,
      touches: l.touches,
    }));

    const prompt = `You are a crypto trading analyst. Evaluate this signal and respond ONLY with valid JSON: {"approved": true/false, "confidence": 0-100, "reason": "brief explanation"}

Signal: ${signal.signal.toUpperCase()} ${signal.type} on ${signal.pair || 'unknown'}
Entry: ${signal.entry}, SL: ${signal.stopLoss}, TP: ${signal.takeProfit}
R:R: 1:${signal.riskRewardRatio}
Reason: ${signal.reason}

Last 10 candles (OHLCV):
${JSON.stringify(last10)}

Key levels:
${JSON.stringify(topLevels)}

Evaluate:
1. Is the level strong enough (touches, recency)?
2. Does price action confirm the signal (candle patterns, momentum)?
3. Is R:R favorable given current volatility?
4. Any red flags (divergence, overextension, low volume)?`;

    try {
      const response = await this._request(prompt);
      const parsed = JSON.parse(response);
      logger.info(`AI filter: ${parsed.approved ? 'APPROVED' : 'REJECTED'} (${parsed.confidence}%) — ${parsed.reason}`);
      return parsed;
    } catch (err) {
      logger.error(`AI filter error: ${err.message}`);
      return { approved: true, confidence: 0, reason: `AI error: ${err.message}` };
    }
  }

  /**
   * Detect market regime: trending / ranging / volatile.
   */
  async detectMarketRegime(pair, candles) {
    if (!this.enabled) return { regime: 'unknown', suggestion: 'AI disabled' };

    const last20 = candles.slice(-20).map((c) => ({
      o: c.open.toFixed(2),
      h: c.high.toFixed(2),
      l: c.low.toFixed(2),
      c: c.close.toFixed(2),
      v: Math.round(c.volume),
    }));

    const prompt = `Analyze the market regime for ${pair}. Respond ONLY with valid JSON: {"regime": "trending_up"|"trending_down"|"ranging"|"volatile", "strength": 0-100, "suggestion": "brief advice for level-based strategy"}

Last 20 candles (OHLCV):
${JSON.stringify(last20)}`;

    try {
      const response = await this._request(prompt);
      return JSON.parse(response);
    } catch (err) {
      logger.error(`Market regime detection error: ${err.message}`);
      return { regime: 'unknown', suggestion: `Error: ${err.message}` };
    }
  }

  /**
   * Post-trade analysis — analyze a completed trade.
   */
  async analyzeTrade(trade) {
    if (!this.enabled) return null;

    const prompt = `Analyze this completed crypto trade. Respond ONLY with valid JSON: {"grade": "A/B/C/D/F", "lessons": ["lesson1", "lesson2"], "improvement": "one key improvement for next time"}

Trade:
- Pair: ${trade.pair}
- Side: ${trade.side}
- Entry: ${trade.entry}, Exit: ${trade.exitPrice}
- SL: ${trade.stopLoss}, TP: ${trade.takeProfit}
- Result: ${trade.pnl > 0 ? 'PROFIT' : 'LOSS'} ${trade.pnl}
- Reason for entry: ${trade.entryReason}
- Reason for exit: ${trade.exitReason}
- Duration: ${trade.duration}`;

    try {
      const response = await this._request(prompt);
      return JSON.parse(response);
    } catch (err) {
      logger.error(`Trade analysis error: ${err.message}`);
      return null;
    }
  }

  /**
   * Send request to OpenRouter API.
   */
  async _request(prompt) {
    const payload = JSON.stringify({
      model: this.model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: 500,
      temperature: 0.1,
    });

    return new Promise((resolve, reject) => {
      const req = https.request(
        {
          hostname: 'openrouter.ai',
          path: '/api/v1/chat/completions',
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `Bearer ${this.apiKey}`,
            'Content-Length': Buffer.byteLength(payload),
          },
          timeout: 30000,
        },
        (res) => {
          let data = '';
          res.on('data', (chunk) => (data += chunk));
          res.on('end', () => {
            if (res.statusCode !== 200) {
              return reject(new Error(`OpenRouter ${res.statusCode}: ${data.slice(0, 200)}`));
            }
            try {
              const json = JSON.parse(data);
              const content = json.choices && json.choices[0] && json.choices[0].message
                ? json.choices[0].message.content
                : '';
              // Extract JSON from response (may be wrapped in markdown)
              const jsonMatch = content.match(/\{[\s\S]*\}/);
              if (jsonMatch) {
                resolve(jsonMatch[0]);
              } else {
                reject(new Error('No JSON in AI response'));
              }
            } catch (e) {
              reject(new Error(`Parse error: ${e.message}`));
            }
          });
        }
      );

      req.on('error', reject);
      req.on('timeout', () => {
        req.destroy();
        reject(new Error('OpenRouter request timeout'));
      });

      req.write(payload);
      req.end();
    });
  }
}

module.exports = AIFilter;
