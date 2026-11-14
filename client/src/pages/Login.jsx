import React, { useState } from 'react';
import { api } from '../api.js';
import { Err } from '../components/ui.jsx';

export default function Login({ onAuth }) {
  const [mode, setMode] = useState('login');
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [err, setErr] = useState(null); const [busy, setBusy] = useState(false);
  const reg = mode === 'register';
  const submit = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { const r = await api.post(`/auth/${mode}`, f); onAuth(r.token, r.user); } catch (x) { setErr(x); setBusy(false); }
  };
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <div className="flex min-h-screen items-center justify-center bg-ink-50 px-4">
      <form onSubmit={submit} className="card w-full max-w-sm space-y-3">
        <div><div className="font-serif text-xl font-semibold text-ink-950">Signal Stack</div><div className="text-xs text-ink-500">{reg ? 'Create your account' : 'Log in to continue'}</div></div>
        <Err e={err} />
        {reg && <div><label className="label" htmlFor="nm">Name</label><input id="nm" className="input" value={f.name} onChange={set('name')} autoComplete="name" /></div>}
        <div><label className="label" htmlFor="em">Email</label><input id="em" type="email" required className="input" value={f.email} onChange={set('email')} autoComplete="email" /></div>
        <div><label className="label" htmlFor="pw">Password{reg && ' (min 8 characters)'}</label><input id="pw" type="password" required minLength={reg ? 8 : undefined} className="input" value={f.password} onChange={set('password')} autoComplete={reg ? 'new-password' : 'current-password'} /></div>
        <button className="btn w-full justify-center" disabled={busy}>{busy ? 'Please wait…' : reg ? 'Sign up' : 'Log in'}</button>
        <button type="button" className="w-full text-center text-xs text-signal-dark underline" onClick={() => { setErr(null); setMode(reg ? 'login' : 'register'); }}>{reg ? 'Already have an account? Log in' : 'New here? Create an account'}</button>
      </form>
    </div>
  );
}
