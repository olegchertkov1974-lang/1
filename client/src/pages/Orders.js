import React, { useState, useEffect, useCallback } from 'react';
import { getOrders, getOpenOrders, getPositions, cancelOrder, closePosition, createOrder } from '../services/api';
import { format } from 'date-fns';

function Orders() {
  const [tab, setTab] = useState('orders');
  const [orders, setOrders] = useState([]);
  const [openOrders, setOpenOrders] = useState([]);
  const [positions, setPositions] = useState([]);
  const [showNewOrder, setShowNewOrder] = useState(false);
  const [orderForm, setOrderForm] = useState({
    exchange: '', symbol: '', type: 'market', side: 'buy', amount: '', price: ''
  });
  const [error, setError] = useState(null);

  const fetchData = useCallback(async () => {
    try {
      const [ordersRes, openRes, posRes] = await Promise.all([
        getOrders(),
        getOpenOrders(),
        getPositions('open')
      ]);
      setOrders(ordersRes.data.trades || []);
      setOpenOrders(openRes.data.trades || []);
      setPositions(posRes.data.positions || []);
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  }, []);

  useEffect(() => { fetchData(); }, [fetchData]);

  const handleCancel = async (id) => {
    try {
      await cancelOrder(id);
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleClosePosition = async (id) => {
    const price = prompt('Enter close price:');
    if (!price) return;
    try {
      await closePosition(id, parseFloat(price));
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  const handleCreateOrder = async (e) => {
    e.preventDefault();
    try {
      await createOrder({
        ...orderForm,
        amount: parseFloat(orderForm.amount),
        price: orderForm.price ? parseFloat(orderForm.price) : undefined
      });
      setShowNewOrder(false);
      setOrderForm({ exchange: '', symbol: '', type: 'market', side: 'buy', amount: '', price: '' });
      fetchData();
    } catch (err) {
      setError(err.response?.data?.error || err.message);
    }
  };

  return (
    <div>
      <div className="page-header">
        <h1>Orders & Positions</h1>
        <button className="primary" onClick={() => setShowNewOrder(true)}>New Order</button>
      </div>

      {error && <div className="card" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>{error}</div>}

      {/* New Order Modal */}
      {showNewOrder && (
        <div className="modal-overlay" onClick={() => setShowNewOrder(false)}>
          <div className="modal" onClick={e => e.stopPropagation()}>
            <h2>Create Order</h2>
            <form onSubmit={handleCreateOrder}>
              <div className="form-row">
                <div className="form-group">
                  <label>Exchange</label>
                  <input value={orderForm.exchange} onChange={e => setOrderForm({ ...orderForm, exchange: e.target.value })} required placeholder="e.g. binance" />
                </div>
                <div className="form-group">
                  <label>Symbol</label>
                  <input value={orderForm.symbol} onChange={e => setOrderForm({ ...orderForm, symbol: e.target.value })} required placeholder="e.g. BTC/USDT" />
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Side</label>
                  <select value={orderForm.side} onChange={e => setOrderForm({ ...orderForm, side: e.target.value })}>
                    <option value="buy">Buy</option>
                    <option value="sell">Sell</option>
                  </select>
                </div>
                <div className="form-group">
                  <label>Type</label>
                  <select value={orderForm.type} onChange={e => setOrderForm({ ...orderForm, type: e.target.value })}>
                    <option value="market">Market</option>
                    <option value="limit">Limit</option>
                    <option value="stop">Stop</option>
                  </select>
                </div>
              </div>
              <div className="form-row">
                <div className="form-group">
                  <label>Amount</label>
                  <input type="number" step="any" value={orderForm.amount} onChange={e => setOrderForm({ ...orderForm, amount: e.target.value })} required />
                </div>
                <div className="form-group">
                  <label>Price {orderForm.type === 'market' ? '(optional)' : ''}</label>
                  <input type="number" step="any" value={orderForm.price} onChange={e => setOrderForm({ ...orderForm, price: e.target.value })} />
                </div>
              </div>
              <div className="modal-actions">
                <button type="button" onClick={() => setShowNewOrder(false)}>Cancel</button>
                <button type="submit" className={orderForm.side === 'buy' ? 'success' : 'danger'}>
                  {orderForm.side === 'buy' ? 'Buy' : 'Sell'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tabs */}
      <div style={{ display: 'flex', gap: '4px', marginBottom: '16px' }}>
        {['orders', 'open', 'positions'].map(t => (
          <button
            key={t}
            onClick={() => setTab(t)}
            style={{
              background: tab === t ? 'var(--accent)' : 'var(--bg-card)',
              color: tab === t ? '#000' : 'var(--text-secondary)',
              borderColor: tab === t ? 'var(--accent)' : 'var(--border)'
            }}
          >
            {t === 'orders' ? 'All Orders' : t === 'open' ? `Open (${openOrders.length})` : `Positions (${positions.length})`}
          </button>
        ))}
      </div>

      {/* Orders table */}
      {tab === 'orders' && (
        <div className="card">
          {orders.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Price</th>
                  <th>Status</th>
                  <th>PnL</th>
                </tr>
              </thead>
              <tbody>
                {orders.map(o => (
                  <tr key={o.id}>
                    <td>{o.created_at ? format(new Date(o.created_at), 'MMM d, HH:mm') : ''}</td>
                    <td>{o.symbol}</td>
                    <td><span className={`badge ${o.side}`}>{o.side}</span></td>
                    <td>{o.type}</td>
                    <td>{o.amount}</td>
                    <td>{o.price ? `$${o.price.toFixed(2)}` : '—'}</td>
                    <td><span className={`badge ${o.status}`}>{o.status}</span></td>
                    <td className={o.pnl >= 0 ? 'positive' : 'negative'}>
                      {o.pnl != null ? `$${o.pnl.toFixed(2)}` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">No orders yet</div>
          )}
        </div>
      )}

      {/* Open orders */}
      {tab === 'open' && (
        <div className="card">
          {openOrders.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Time</th>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Type</th>
                  <th>Amount</th>
                  <th>Price</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {openOrders.map(o => (
                  <tr key={o.id}>
                    <td>{o.created_at ? format(new Date(o.created_at), 'MMM d, HH:mm') : ''}</td>
                    <td>{o.symbol}</td>
                    <td><span className={`badge ${o.side}`}>{o.side}</span></td>
                    <td>{o.type}</td>
                    <td>{o.amount}</td>
                    <td>{o.price ? `$${o.price.toFixed(2)}` : '—'}</td>
                    <td><button className="danger" onClick={() => handleCancel(o.id)}>Cancel</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">No open orders</div>
          )}
        </div>
      )}

      {/* Positions */}
      {tab === 'positions' && (
        <div className="card">
          {positions.length > 0 ? (
            <table>
              <thead>
                <tr>
                  <th>Pair</th>
                  <th>Side</th>
                  <th>Entry</th>
                  <th>Amount</th>
                  <th>Current</th>
                  <th>PnL</th>
                  <th>Strategy</th>
                  <th>Action</th>
                </tr>
              </thead>
              <tbody>
                {positions.map(p => (
                  <tr key={p.id}>
                    <td>{p.symbol}</td>
                    <td><span className={`badge ${p.side}`}>{p.side}</span></td>
                    <td>${p.entry_price?.toFixed(2)}</td>
                    <td>{p.amount}</td>
                    <td>${p.current_price?.toFixed(2)}</td>
                    <td className={p.pnl >= 0 ? 'positive' : 'negative'}>
                      ${p.pnl?.toFixed(2)} ({p.pnl_percent?.toFixed(1)}%)
                    </td>
                    <td>{p.strategy || '—'}</td>
                    <td><button className="danger" onClick={() => handleClosePosition(p.id)}>Close</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : (
            <div className="empty-state">No open positions</div>
          )}
        </div>
      )}
    </div>
  );
}

export default Orders;
