import React, { createContext, useContext, useEffect, useState, useCallback } from 'react';
import { NavLink, Route, Routes, Navigate } from 'react-router-dom';
import { api, getToken, setToken } from './api.js';
import Login from './pages/Login.jsx';
import Setup from './pages/Setup.jsx';
import Dashboard from './pages/Dashboard.jsx';
import Profile from './pages/Profile.jsx';
import Interview from './pages/Interview.jsx';
import Stack from './pages/Stack.jsx';
import Sources from './pages/Sources.jsx';
import Feed from './pages/Feed.jsx';
import Briefs from './pages/Briefs.jsx';
import Operations from './pages/Operations.jsx';
import Settings from './pages/Settings.jsx';

const Ctx = createContext(null);
export const useCompany = () => useContext(Ctx);

const NAV = [['/', 'Dashboard'], ['/profile', 'Company profile'], ['/interview', 'AI interview'], ['/stack', 'Signal Stack'], ['/sources', 'Source manager'], ['/feed', 'Intelligence feed'], ['/briefs', 'Monday brief'], ['/operations', 'Jobs & audits'], ['/settings', 'Settings']];

export default function App() {
  const [user, setUser] = useState(null);
  const [ready, setReady] = useState(!getToken());
  useEffect(() => {
    if (getToken()) api.get('/auth/me').then((r) => setUser(r.user)).catch(() => setToken(null)).finally(() => setReady(true));
    const expired = () => setUser(null);
    window.addEventListener('auth:expired', expired);
    return () => window.removeEventListener('auth:expired', expired);
  }, []);
  const logout = () => { setToken(null); localStorage.removeItem('companyId'); setUser(null); };
  if (!ready) return <div className="p-8 text-sm text-ink-500">Loading…</div>;
  if (!user) return <Login onAuth={(token, u) => { setToken(token); setUser(u); }} />;
  return <Shell user={user} logout={logout} />;
}

function Shell({ user, logout }) {
  const [list, setList] = useState([]);
  const [id, setId] = useState(localStorage.getItem('companyId') || '');
  const [company, setCompany] = useState(null);
  const loadList = useCallback(async () => { const l = await api.get('/companies'); setList(l); return l; }, []);
  const reload = useCallback(async () => { if (!id) return setCompany(null); try { setCompany(await api.get(`/companies/${id}`)); } catch { setCompany(null); } }, [id]);
  useEffect(() => { loadList().then((l) => { if (!l.some((c) => c._id === id)) select(l[0]?._id || ''); }).catch(() => {}); }, []);
  useEffect(() => { reload(); }, [reload]);
  const select = (v) => { localStorage.setItem('companyId', v); setId(v); };

  return (
    <Ctx.Provider value={{ company, id, reload, select, list, loadList }}>
      <div className="flex min-h-screen flex-col md:flex-row">
        <aside className="bg-ink-950 text-ink-100 md:sticky md:top-0 md:h-screen md:w-60 md:shrink-0">
          <div className="px-4 pb-2 pt-5"><div className="font-serif text-lg font-semibold tracking-tight">Signal Stack</div><div className="text-xs text-ink-300">Company intelligence engine</div></div>
          <div className="px-4 pb-3">
            <label className="mb-1 block text-xs text-ink-300" htmlFor="co">Company</label>
            <select id="co" value={id} onChange={(e) => select(e.target.value)} className="w-full rounded-md border border-ink-700 bg-ink-900 px-2 py-1.5 text-sm text-white">
              <option value="">— select —</option>{list.map((c) => <option key={c._id} value={c._id}>{c.name}</option>)}
            </select>
            <NavLink to="/setup" className="mt-2 block text-xs text-signal-soft underline">+ Add a company</NavLink>
            <div className="mt-3 flex items-center justify-between text-xs text-ink-300"><span className="truncate" title={user.email}>{user.name || user.email}</span><button onClick={logout} className="shrink-0 pl-2 underline hover:text-white">Log out</button></div>
          </div>
          <nav className="flex gap-1 overflow-x-auto px-2 pb-3 md:flex-col md:overflow-visible">
            {NAV.map(([to, label]) => <NavLink key={to} to={to} end={to === '/'} className={({ isActive }) => `whitespace-nowrap rounded-md px-3 py-1.5 text-sm ${isActive ? 'bg-signal text-white' : 'text-ink-300 hover:bg-ink-900 hover:text-white'}`}>{label}</NavLink>)}
          </nav>
        </aside>
        <main className="min-w-0 flex-1 px-4 py-6 md:px-8">
          <Routes>
            <Route path="/setup" element={<Setup />} />
            <Route path="/" element={company ? <Dashboard /> : <Navigate to="/setup" />} />
            {company && <>
              <Route path="/profile" element={<Profile />} /><Route path="/interview" element={<Interview />} /><Route path="/stack" element={<Stack />} />
              <Route path="/sources" element={<Sources />} /><Route path="/feed" element={<Feed />} /><Route path="/briefs" element={<Briefs />} />
              <Route path="/operations" element={<Operations />} /><Route path="/settings" element={<Settings />} />
            </>}
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </main>
      </div>
    </Ctx.Provider>
  );
}
