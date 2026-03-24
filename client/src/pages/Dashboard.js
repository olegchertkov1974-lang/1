import React, { useState, useEffect, useCallback } from 'react';
import { getDashboard, startBot, stopBot } from '../services/api';
import socket from '../services/socket';
import { format } from 'date-fns';

function Dashboard() {
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);

  const fetchDashboard = useCallback(async () => {
    try {
      const res = await getDashboard();
      setData(res.data);
      setError(null);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchDashboard();
    const interval = setInterval(fetchDashboard, 30000);

    socket.on('signal:new', () => fetchDashboard());
    socket.on('ticker:update', () => fetchDashboard());

    return () => {
      clearInterval(interval);
      socket.off('signal:new');
      socket.off('ticker:update');
    };
  }, [fetchDashboard]);

  const handleStartBot = async () => {
    try {
      await startBot([]);
      fetchDashboard();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleStopBot = async () => {
    try {
      await stopBot();
      fetchDashboard();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  if (loading) return <div className="loading">Loading dashboard...</div>;

  return (
    <div>
      <div className="page-header">
        <h1>Dashboard</h1>
        <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
          <span className={`badge ${data?.botStatus?.running ? 'running' : 'stopped'}`}>
            {data?.botStatus?.running ? 'Running' : 'Stopped'}
          </span>
          {data?.botStatus?.running ? (
            <button className="danger" onClick={handleStopBot}>Stop Bot</button>
          ) : (
            <button className="success" onClick={handleStartBot}>Start Bot</button>
          )}
        </div>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error}</div>}

      {/* Stats */}
      <div className="grid-4" style={{ marginBottom: '16px' }}>
        <div className="stat-box">
          <div className="label">Total Trades</div>
          <div className="value">{data?.stats?.total_trades || 0}</div>
        </div>
        <div className="stat-box">
          <div className="label">Open Trades</div>
          <div className="value">{data?.stats?.open_trades || 0}</div>
        </div>
        <div className="stat-box">
          <div className="label">Win Rate</div>
          <div className="value">
            {data?.stats?.winning_trades && data?.stats?.total_trades
              ? ((data.stats.winning_trades / (data.stats.winning_trades + data.stats.losing_trades)) * 100).toFixed(1) + '%'
              : '—'}
          </div>
        </div>
        <div className="stat-box">
          <div className="label">Total PnL</div>
          <div className={`value ${(data?.stats?.total_pnl || 0) >= 0 ? 'positive' : 'negative'}`}>
            {data?.stats?.total_pnl != null ? `$${data.stats.total_pnl.toFixed(2)}` : '—'}
          </div>
        </div>
      </div>

      <div className="grid-2">
        {/* Open Positions */}
        <div className="card">
          <div className="card-header">
            <h2>Open Positions</h2>
            <span className="badge">{data?.positions?.length || 0}</span>
          </div>
          {data?.positions?.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {data.positions.map(pos => (
                  <tr key={pos.id}>
                    <td>{pos.symbol}</td>
                    <td><span className={`badge ${pos.side}`}>{pos.side}</span></td>
                    <td>${pos.entry_price?.toFixed(2)}</td>
                    <td className={pos.pnl >= 0 ? 'positive' : 'negative'}>
                      ${pos.pnl?.toFixed(2)} ({pos.pnl_percent?.toFixed(1)}%)
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">No open positions</div>
          )}
        </div>

        {/* Recent Signals */}
        <div className="card">
          <div className="card-header">
            <h2>Recent Signals</h2>
          </div>
          {data?.recentSignals?.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Signal</th>
                  <th>Strategy</th>
                  <th>Time</th>
                </tr>
              </thead>
              <tbody>
                {data.recentSignals.map(sig => (
                  <tr key={sig.id}>
                    <td>{sig.symbol}</td>
                    <td><span className={`badge ${sig.signal}`}>{sig.signal}</span></td>
                    <td>{sig.strategy}</td>
                    <td>{sig.created_at ? format(new Date(sig.created_at), 'MMM d, HH:mm') : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">No signals yet</div>
          )}
        </div>
      </div>

      {/* Active Pairs */}
      <div className="card">
        <div className="card-header">
          <h2>Active Trading Pairs</h2>
        </div>
        {data?.botStatus?.activePairs?.length > 0 ? (
          <table>
            <thead>
              <tr>
                <th>Pair</th>
                <th>Strategy</th>
              </tr>
            </thead>
            <tbody>
              {data.botStatus.activePairs.map((p, i) => (
                <tr key={i}>
                  <td>{p.pair}</td>
                  <td>{p.strategy}</td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div className="empty-state">No active pairs. Configure strategies and add pairs to start trading.</div>
        )}
      </div>

      {/* Tickers */}
      {data?.tickers?.length > 0 && (
        <div className="card">
          <div className="card-header">
            <h2>Latest Tickers</h2>
          </div>
          <table>
            <thead>
              <tr>
                <th>Exchange</th>
                <th>Symbol</th>
                <th>Price</th>
                <th>Volume</th>
                <th>Change</th>
              </tr>
            </thead>
            <tbody>
              {data.tickers.map((t, i) => (
                <tr key={i}>
                  <td>{t.exchange}</td>
                  <td>{t.symbol}</td>
                  <td>${t.price?.toFixed(2)}</td>
                  <td>{t.volume?.toFixed(0)}</td>
                  <td className={t.change_percent >= 0 ? 'positive' : 'negative'}>
                    {t.change_percent?.toFixed(2)}%
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

export default Dashboard;
