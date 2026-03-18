// ============================================
// Bybit V5 API Helper Functions for n8n
// ============================================
// Copy these into n8n Code nodes as needed.
// All functions use n8n environment variables.

/**
 * Generate Bybit V5 API signature
 */
function bybitSign(apiKey, apiSecret, timestamp, recvWindow, payload) {
  const crypto = require('crypto');
  const preSign = timestamp + apiKey + recvWindow + payload;
  return crypto.createHmac('sha256', apiSecret).update(preSign).digest('hex');
}

/**
 * Get Bybit base URL based on BYBIT_TESTNET env var
 */
function getBaseUrl() {
  const isTestnet = ($env.BYBIT_TESTNET || 'true').toLowerCase() === 'true';
  return isTestnet
    ? 'https://api-testnet.bybit.com'
    : 'https://api.bybit.com';
}

/**
 * Make authenticated GET request to Bybit V5 API
 * @param {object} helpers - n8n this.helpers
 * @param {string} endpoint - e.g. '/v5/account/wallet-balance'
 * @param {object} params - query parameters
 * @param {number} retries - retry count (default 3)
 */
async function bybitGet(helpers, endpoint, params = {}, retries = 3) {
  const baseUrl = getBaseUrl();
  const apiKey = $env.BYBIT_API_KEY;
  const apiSecret = $env.BYBIT_API_SECRET;
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  const signature = bybitSign(apiKey, apiSecret, timestamp, recvWindow, queryString);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = queryString
        ? `${baseUrl}${endpoint}?${queryString}`
        : `${baseUrl}${endpoint}`;

      const response = await helpers.httpRequest({
        method: 'GET',
        url,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json'
        }
      });

      if (response.retCode === 0) return response;
      if (response.retCode === 10006) {
        // Rate limit - wait and retry
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw new Error(`Bybit API error: ${response.retCode} - ${response.retMsg}`);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

/**
 * Make authenticated POST request to Bybit V5 API
 */
async function bybitPost(helpers, endpoint, body = {}, retries = 3) {
  const baseUrl = getBaseUrl();
  const apiKey = $env.BYBIT_API_KEY;
  const apiSecret = $env.BYBIT_API_SECRET;
  const timestamp = Date.now().toString();
  const recvWindow = '5000';

  const bodyStr = JSON.stringify(body);
  const signature = bybitSign(apiKey, apiSecret, timestamp, recvWindow, bodyStr);

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const response = await helpers.httpRequest({
        method: 'POST',
        url: `${baseUrl}${endpoint}`,
        headers: {
          'X-BAPI-API-KEY': apiKey,
          'X-BAPI-SIGN': signature,
          'X-BAPI-TIMESTAMP': timestamp,
          'X-BAPI-RECV-WINDOW': recvWindow,
          'Content-Type': 'application/json'
        },
        body
      });

      if (response.retCode === 0) return response;
      if (response.retCode === 10006) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw new Error(`Bybit API error: ${response.retCode} - ${response.retMsg}`);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

/**
 * Make public (unauthenticated) GET request
 */
async function bybitPublicGet(helpers, endpoint, params = {}, retries = 3) {
  const baseUrl = getBaseUrl();
  const queryString = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join('&');

  for (let attempt = 1; attempt <= retries; attempt++) {
    try {
      const url = queryString
        ? `${baseUrl}${endpoint}?${queryString}`
        : `${baseUrl}${endpoint}`;

      const response = await helpers.httpRequest({ method: 'GET', url });
      if (response.retCode === 0) return response;
      if (response.retCode === 10006) {
        await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
        continue;
      }
      throw new Error(`Bybit API error: ${response.retCode} - ${response.retMsg}`);
    } catch (e) {
      if (attempt === retries) throw e;
      await new Promise(r => setTimeout(r, Math.pow(2, attempt) * 1000));
    }
  }
}

/**
 * Calculate position size based on risk percentage
 * @param {number} balance - account balance in USDT
 * @param {number} entryPrice - entry price
 * @param {number} stopLoss - stop loss price
 * @param {number} riskPercent - risk per trade (default from env)
 * @returns {number} position size in base currency
 */
function calculatePositionSize(balance, entryPrice, stopLoss, riskPercent) {
  const risk = riskPercent || parseFloat($env.MAX_RISK_PER_TRADE || '1');
  const riskAmount = balance * (risk / 100);
  const stopDistance = Math.abs(entryPrice - stopLoss);
  if (stopDistance === 0) return 0;
  return riskAmount / stopDistance;
}

module.exports = {
  bybitSign, getBaseUrl, bybitGet, bybitPost, bybitPublicGet, calculatePositionSize
};
