import React, { useState, useEffect, useCallback } from 'react';
import { getStrategies, saveStrategyConfig, deleteStrategyConfig, runBacktest } from '../services/api';

function Strategies() {
  const [strategies, setStrategies] = useState({ available: [], configured: [] });
  const [selected, setSelected] = useState(null);
  const [configForm, setConfigForm] = useState({});
  const [pairs, setPairs] = useState('');
  const [exchange, setExchange] = useState('');
  const [enabled, setEnabled] = useState(false);
  const [backtestResult, setBacktestResult] = useState(null);
  const [backtestForm, setBacktestForm] = useState({ exchange: '', symbol: '', timeframe: '1h' });
  const [error, setError] = useState(null);

  const fetchStrategies = useCallback(async () => {
    try {
      const res = await getStrategies();
      setStrategies(res.data);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, []);

  useEffect(() => { fetchStrategies(); }, [fetchStrategies]);

  const handleSelect = (strategy) => {
    setSelected(strategy);
    const saved = strategies.configured.find(c => c.name === strategy.name);
    if (saved) {
      setConfigForm(saved.config || {});
      setPairs(Array.isArray(saved.pairs) ? saved.pairs.join(', ') : '');
      setExchange(saved.exchange || '');
      setEnabled(!!saved.enabled);
    } else {
      setConfigForm(strategy.defaultConfig || {});
      setPairs('');
      setExchange('');
      setEnabled(false);
    }
    setBacktestResult(null);
  };

  const handleSave = async () => {
    if (!selected) return;
    try {
      await saveStrategyConfig(selected.name, {
        config: configForm,
        pairs: pairs.split(',').map(p => p.trim()).filter(Boolean),
        exchange,
        enabled
      });
      fetchStrategies();
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleDelete = async (name) => {
    try {
      await deleteStrategyConfig(name);
      fetchStrategies();
      if (selected?.name === name) setSelected(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleBacktest = async () => {
    if (!selected || !backtestForm.exchange || !backtestForm.symbol) return;
    try {
      const res = await runBacktest(selected.name, {
        ...backtestForm,
        config: configForm
      });
      setBacktestResult(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Strategies</h1>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error}</div>}

      <div className="grid-2">
        {/* Strategy list */}
        <div>
          <div className="card">
            <div className="card-header">
              <h2>Available Strategies</h2>
            </div>
            {strategies.available.length > 0 ? (
              <div>
                {strategies.available.map(s => {
                  const isConfigured = strategies.configured.some(c => c.name === s.name);
                  return (
                    <div
                      key={s.name}
                      onClick={() => handleSelect(s)}
                      style={{
                        padding: '12px',
                        cursor: 'pointer',
                        borderBottom: '1px solid var(--border)',
                        background: selected?.name === s.name ? 'var(--bg-hover)' : 'transparent'
                      }}
                    >
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
                        <strong>{s.name}</strong>
                        {isConfigured && <span className="badge running">configured</span>}
                      </div>
                      <div style={{ fontSize: '12px', color: 'var(--text-muted)', marginTop: '4px' }}>{s.description}</div>
                    </div>
                  );
                })}
              </div>
            ) : (
              <div className="empty-state">No strategies loaded</div>
            )}
          </div>

          {/* Configured strategies */}
          {strategies.configured.length > 0 && (
            <div className="card">
              <div className="card-header">
                <h2>Configured</h2>
              </div>
              <table>
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Exchange</th>
                    <th>Pairs</th>
                    <th>Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {strategies.configured.map(c => (
                    <tr key={c.name}>
                      <td>{c.name}</td>
                      <td>{c.exchange || '—'}</td>
                      <td>{Array.isArray(c.pairs) ? c.pairs.join(', ') : '—'}</td>
                      <td>
                        <button className="danger" onClick={() => handleDelete(c.name)} style={{ padding: '4px 8px', fontSize: '11px' }}>
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>

        {/* Strategy config */}
        <div>
          {selected ? (
            <>
              <div className="card">
                <div className="card-header">
                  <h2>{selected.name}</h2>
                  <span style={{ fontSize: '12px', color: 'var(--text-muted)' }}>{selected.description}</span>
                </div>

                <div className="form-group">
                  <label>Exchange</label>
                  <input value={exchange} onChange={e => setExchange(e.target.value)} placeholder="e.g. binance" />
                </div>
                <div className="form-group">
                  <label>Pairs (comma-separated)</label>
                  <input value={pairs} onChange={e => setPairs(e.target.value)} placeholder="BTC/USDT, ETH/USDT" />
                </div>

                <h3 style={{ margin: '16px 0 8px', fontSize: '13px', color: 'var(--text-secondary)' }}>Parameters</h3>
                {Object.entries(selected.defaultConfig || {}).map(([key, defaultVal]) => (
                  <div className="form-group" key={key}>
                    <label>{key} (default: {defaultVal})</label>
                    <input
                      type="number"
                      step="any"
                      value={configForm[key] ?? defaultVal}
                      onChange={e => setConfigForm({ ...configForm, [key]: parseFloat(e.target.value) || e.target.value })}
                    />
                  </div>
                ))}

                <div className="form-group">
                  <label>
                    <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} />
                    {' '}Enabled
                  </label>
                </div>

                <div style={{ display: 'flex', gap: '8px' }}>
                  <button className="primary" onClick={handleSave}>Save Configuration</button>
                </div>
              </div>

              {/* Backtest */}
              <div className="card">
                <div className="card-header">
                  <h2>Backtest</h2>
                </div>
                <div className="form-row">
                  <div className="form-group">
                    <label>Exchange</label>
                    <input value={backtestForm.exchange} onChange={e => setBacktestForm({ ...backtestForm, exchange: e.target.value })} placeholder="binance" />
                  </div>
                  <div className="form-group">
                    <label>Symbol</label>
                    <input value={backtestForm.symbol} onChange={e => setBacktestForm({ ...backtestForm, symbol: e.target.value })} placeholder="BTC/USDT" />
                  </div>
                  <div className="form-group">
                    <label>Timeframe</label>
                    <select value={backtestForm.timeframe} onChange={e => setBacktestForm({ ...backtestForm, timeframe: e.target.value })}>
                      <option value="1h">1 Hour</option>
                      <option value="4h">4 Hours</option>
                      <option value="1d">1 Day</option>
                    </select>
                  </div>
                </div>
                <button onClick={handleBacktest}>Run Backtest</button>

                {backtestResult && (
                  <div style={{ marginTop: '16px' }}>
                    <div className="grid-3" style={{ marginBottom: '12px' }}>
                      <div className="stat-box">
                        <div className="label">Total Trades</div>
                        <div className="value" style={{ fontSize: '18px' }}>{backtestResult.totalTrades}</div>
                      </div>
                      <div className="stat-box">
                        <div className="label">Win Rate</div>
                        <div className="value" style={{ fontSize: '18px' }}>{backtestResult.winRate}%</div>
                      </div>
                      <div className="stat-box">
                        <div className="label">Total PnL</div>
                        <div className={`value ${parseFloat(backtestResult.totalPnlPercent) >= 0 ? 'positive' : 'negative'}`} style={{ fontSize: '18px' }}>
                          {backtestResult.totalPnlPercent}%
                        </div>
                      </div>
                    </div>

                    {backtestResult.signals?.length > 0 && (
                      <table>
                        <thead>
                          <tr>
                            <th>Signal</th>
                            <th>Price</th>
                            <th>Reason</th>
                            <th>PnL</th>
                          </tr>
                        </thead>
                        <tbody>
                          {backtestResult.signals.map((s, i) => (
                            <tr key={i}>
                              <td><span className={`badge ${s.signal}`}>{s.signal}</span></td>
                              <td>${s.price?.toFixed(2)}</td>
                              <td style={{ fontSize: '12px' }}>{s.reason}</td>
                              <td className={s.pnl >= 0 ? 'positive' : 'negative'}>
                                {s.pnl != null ? `${s.pnl.toFixed(2)}%` : '—'}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="card">
              <div className="empty-state">Select a strategy to configure</div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default Strategies;
