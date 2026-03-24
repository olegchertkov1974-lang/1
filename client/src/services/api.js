import axios from 'axios';

const API_URL = process.env.REACT_APP_API_URL || '';

const api = axios.create({
  baseURL: `${API_URL}/api`,
  headers: { 'Content-Type': 'application/json' }
});

// Dashboard
export const getDashboard = () => api.get('/dashboard');
export const getStats = () => api.get('/dashboard/stats');
export const startBot = (configs) => api.post('/dashboard/bot/start', { configs });
export const stopBot = () => api.post('/dashboard/bot/stop');
export const addBotPair = (data) => api.post('/dashboard/bot/pair', data);
export const removeBotPair = (exchange, symbol) => api.delete('/dashboard/bot/pair', { data: { exchange, symbol } });

// Pairs
export const getExchanges = () => api.get('/pairs/exchanges');
export const addExchange = (data) => api.post('/pairs/exchange', data);
export const getMarkets = (exchangeId) => api.get(`/pairs/markets/${exchangeId}`);
export const getTicker = (exchangeId, symbol) => api.get(`/pairs/ticker/${exchangeId}/${encodeURIComponent(symbol)}`);
export const getCandles = (exchangeId, symbol, timeframe = '1h', limit = 100) =>
  api.get(`/pairs/candles/${exchangeId}/${encodeURIComponent(symbol)}`, { params: { timeframe, limit } });
export const getOrderBook = (exchangeId, symbol, limit = 20) =>
  api.get(`/pairs/orderbook/${exchangeId}/${encodeURIComponent(symbol)}`, { params: { limit } });
export const getPairSignals = (exchangeId, symbol) =>
  api.get(`/pairs/signals/${exchangeId}/${encodeURIComponent(symbol)}`);

// Orders
export const getOrders = (limit = 50, offset = 0) => api.get('/orders', { params: { limit, offset } });
export const getOpenOrders = () => api.get('/orders/open');
export const createOrder = (data) => api.post('/orders', data);
export const cancelOrder = (id) => api.delete(`/orders/${id}`);
export const getPositions = (status) => api.get('/orders/positions', { params: { status } });
export const openPosition = (data) => api.post('/orders/positions', data);
export const closePosition = (id, closePrice) => api.put(`/orders/positions/${id}/close`, { closePrice });
export const getSignals = (limit = 50) => api.get('/orders/signals', { params: { limit } });

// Strategies
export const getStrategies = () => api.get('/strategies');
export const getStrategy = (name) => api.get(`/strategies/${name}`);
export const saveStrategyConfig = (name, data) => api.post(`/strategies/${name}/config`, data);
export const deleteStrategyConfig = (name) => api.delete(`/strategies/${name}/config`);
export const runBacktest = (name, data) => api.post(`/strategies/${name}/backtest`, data);

export default api;
