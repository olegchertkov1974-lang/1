import React, { useState, useEffect } from 'react';
import { getExchanges, addExchange, getMarkets, getTicker, getCandles } from '../services/api';

function Pairs() {
  const [exchanges, setExchanges] = useState([]);
  const [selectedExchange, setSelectedExchange] = useState('');
  const [markets, setMarkets] = useState([]);
  const [searchQuery, setSearchQuery] = useState('');
  const [selectedPair, setSelectedPair] = useState(null);
  const [ticker, setTicker] = useState(null);
  const [candles, setCandles] = useState([]);
  const [showAddExchange, setShowAddExchange] = useState(false);
  const [exchangeForm, setExchangeForm] = useState({ id: '', exchangeId: '', apiKey: '', secret: '', sandbox: true });
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    loadExchanges();
  }, []);

  const loadExchanges = async () => {
    try {
      const res = await getExchanges();
      setExchanges(res.data.exchanges || []);
    } catch (err) {
      setError(err.message);
    }
  };

  const handleAddExchange = async (e) => {
    e.preventDefault();
    try {
      await addExchange(exchangeForm);
      setShowAddExchange(false);
      setExchangeForm({ id: '', exchangeId: '', apiKey: '', secret: '', sandbox: true });
      setSelectedExchange(exchangeForm.id);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleLoadMarkets = async () => {
    if (!selectedExchange) return;
    setLoading(true);
    try {
      const res = await getMarkets(selectedExchange);
      setMarkets(res.data.pairs || []);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  };

  const handleSelectPair = async (symbol) => {
    setSelectedPair(symbol);
    try {
      const [tickerRes, candleRes] = await Promise.all([
        getTicker(selectedExchange, symbol),
        getCandles(selectedExchange, symbol, '1h', 50)
      ]);
      setTicker(tickerRes.data);
      setCandles(candleRes.data.candles || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const filteredMarkets = markets.filter(m =>
    m.symbol.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div>
      <div className="page-header">
        <h1>Pairs & Markets</h1>
        <button className="primary" onClick={() => setShowAddExchange(true)}>Add Exchange</button>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error}</div>}

      {/* Add Exchange Modal */}
      {showAddExchange && (
        <div className="modal-overlay" onClick={() => setShowAddExchange(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Add Exchange</h2>
            <form onSubmit={handleAddExchange}>
              <div className="form-row">
                <div className="form-group">
                  <label>ID (your label)</label>
                  <input value={exchangeForm.id} onChange={e => setExchangeForm({ ...exchangeForm, id: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Exchange</label>
                  <select value={exchangeForm.exchangeId} onChange={e => setExchangeForm({ ...exchangeForm, exchangeId: e.target.value })} required>
                    <option value="">Select...</option>
                    {exchanges.slice(0, 30).map(ex => (
                      <option key={ex} value={ex}>{ex}</option>
                    ))}
                  </select>
                </div>
              </div>
              <div className="form-group">
                <label>API Key (optional)</label>
                <input value={exchangeForm.apiKey} onChange={e => setExchangeForm({ ...exchangeForm, apiKey: e.target.value })} />
              </div>
              <div className="form-group">
                <label>Secret (optional)</label>
                <input type="password" value={exchangeForm.secret} onChange={e => setExchangeForm({ ...exchangeForm, secret: e.target.value })} />
              </div>
              <div className="form-group">
                <label>
                  <input type="checkbox" checked={exchangeForm.sandbox} onChange={e => setExchangeForm({ ...exchangeForm, sandbox: e.target.checked })} />
                  {' '}Sandbox mode
                </label>
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowAddExchange(false)}>Cancel</button>
                <button type="submit" className="primary">Add</button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Exchange selector + market loader */}
      <div className="card">
        <div style={{ display: 'flex', gap: '12px', alignItems: 'flex-end' }}>
          <div className="form-group" style={{ flex: 1, marginBottom: 0 }}>
            <label>Exchange</label>
            <input
              value={selectedExchange}
              onChange={e => setSelectedExchange(e.target.value)}
              placeholder="Enter exchange ID (e.g., binance)"
            />
          </div>
          <button className="primary" onClick={handleLoadMarkets} disabled={!selectedExchange || loading}>
            {loading ? 'Loading...' : 'Load Markets'}
          </button>
        </div>
      </div>

      <div className="grid-2">
        {/* Markets list */}
        <div className="card" style={{ maxHeight: '600px', overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
          <div className="card-header">
            <h2>Markets ({filteredMarkets.length})</h2>
          </div>
          <div className="form-group">
            <input
              placeholder="Search pairs..."
              value={searchQuery}
              onChange={e => setSearchQuery(e.target.value)}
            />
          </div>
          <div style={{ overflow: 'auto', flex: 1 }}>
            {filteredMarkets.length > 0 ? (
              <table>
                <thead>
                  <tr>
                    <th>Symbol</th>
                    <th>Base</th>
                    <th>Quote</th>
                  </tr>
                </thead>
                <tbody>
                  {filteredMarkets.slice(0, 100).map(m => (
                    <tr
                      key={m.symbol}
                      onClick={() => handleSelectPair(m.symbol)}
                      style={{ cursor: 'pointer', background: selectedPair === m.symbol ? 'var(--bg-hover)' : 'transparent' }}
                    >
                      <td>{m.symbol}</td>
                      <td>{m.base}</td>
                      <td>{m.quote}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <div className="empty-state">
                {markets.length === 0 ? 'Load markets from an exchange' : 'No pairs match your search'}
              </div>
            )}
          </div>
        </div>

        {/* Pair details */}
        <div>
          {ticker ? (
            <div className="card">
              <div className="card-header">
                <h2>{ticker.symbol}</h2>
                <span className={ticker.changePercent >= 0 ? 'positive' : 'negative'}>
                  {ticker.changePercent?.toFixed(2)}%
                </span>
              </div>
              <div className="grid-2" style={{ marginBottom: '16px' }}>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>PRICE</div>
                  <div style={{ fontSize: '28px', fontWeight: '700' }}>${ticker.price?.toFixed(2)}</div>
                </div>
                <div>
                  <div style={{ color: 'var(--text-muted)', fontSize: '11px' }}>VOLUME</div>
                  <div style={{ fontSize: '28px', fontWeight: '700' }}>{ticker.volume?.toFixed(0)}</div>
                </div>
              </div>
              <div className="grid-2">
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Bid: </span>${ticker.bid?.toFixed(2)}
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Ask: </span>${ticker.ask?.toFixed(2)}
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>High: </span>${ticker.high?.toFixed(2)}
                </div>
                <div>
                  <span style={{ color: 'var(--text-muted)' }}>Low: </span>${ticker.low?.toFixed(2)}
                </div>
              </div>
            </div>
          ) : (
            <div className="card">
              <div className="empty-state">Select a pair to view details</div>
            </div>
          )}

          {/* Simple candle display */}
          {candles.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h3>Recent Candles (1h)</h3>
              </div>
              <div style={{ maxHeight: '300px', overflow: 'auto' }}>
                <table>
                  <thead>
                    <tr>
                      <th>Time</th>
                      <th>O</th>
                      <th>H</th>
                      <th>L</th>
                      <th>C</th>
                      <th>Vol</th>
                    </tr>
                  </thead>
                  <tbody>
                    {candles.slice(-20).reverse().map((c, i) => (
                      <tr key={i}>
                        <td style={{ fontSize: '11px' }}>{c.timestamp?.split('T')[1]?.slice(0, 5)}</td>
                        <td>{c.open?.toFixed(2)}</td>
                        <td>{c.high?.toFixed(2)}</td>
                        <td>{c.low?.toFixed(2)}</td>
                        <td className={c.close >= c.open ? 'positive' : 'negative'}>{c.close?.toFixed(2)}</td>
                        <td>{c.volume?.toFixed(0)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Pairs;
