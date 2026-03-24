import React from 'react';
import { BrowserRouter as Router, Routes, Route, NavLink } from 'react-router-dom';
import Dashboard from './pages/Dashboard';
import Pairs from './pages/Pairs';
import Orders from './pages/Orders';
import Strategies from './pages/Strategies';
import './App.css';

function App() {
  return (
    <Router>
      <div className="app">
        <nav className="sidebar">
          <div className="sidebar-header">
            <h1 className="logo">CTB</h1>
            <span className="logo-text">Crypto Trading Bot</span>
          </div>
          <ul className="nav-links">
            <li>
              <NavLink to="/" end className={({ isActive }) => isActive ? 'active' : ''}>
                Dashboard
              </NavLink>
            </li>
            <li>
              <NavLink to="/pairs" className={({ isActive }) => isActive ? 'active' : ''}>
                Pairs
              </NavLink>
            </li>
            <li>
              <NavLink to="/orders" className={({ isActive }) => isActive ? 'active' : ''}>
                Orders
              </NavLink>
            </li>
            <li>
              <NavLink to="/strategies" className={({ isActive }) => isActive ? 'active' : ''}>
                Strategies
              </NavLink>
            </li>
          </ul>
          <div className="sidebar-footer">
            <span className="version">v0.1.0</span>
          </div>
        </nav>
        <main className="main-content">
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/pairs" element={<Pairs />} />
            <Route path="/orders" element={<Orders />} />
            <Route path="/strategies" element={<Strategies />} />
          </Routes>
        </main>
      </div>
    </Router>
  );
}

export default App;
