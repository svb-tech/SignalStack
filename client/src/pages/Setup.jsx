import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, fmtDate } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, JobPanel, Err, Badge, Empty } from '../components/ui.jsx';

export default function Setup() {
  const { list, loadList, select, reload } = useCompany();
  const nav = useNavigate();
  const [name, setName] = useState(''); const [url, setUrl] = useState('');
  const [jobId, setJobId] = useState(null); const [err, setErr] = useState(null); const [busy, setBusy] = useState(false); const [newId, setNewId] = useState(null);
  const create = async (e) => {
    e.preventDefault(); setErr(null); setBusy(true);
    try { const r = await api.post('/companies', { name, url }); setJobId(r.jobId); setNewId(r.company._id); await loadList(); select(r.company._id); } catch (x) { setErr(x); setBusy(false); }
  };
  const remove = async (c) => { if (confirm(`Delete ${c.name} and all its data?`)) { await api.del(`/companies/${c._id}`); const l = await loadList(); select(l[0]?._id || ''); } };
  return (
    <div className="max-w-3xl">
      <PageHead title="Company setup" sub="Enter a company name and website. The system researches the public web, separates verified facts from assumptions, and then interviews the founder." />
      <Err e={err} />
      <form onSubmit={create} className="card mb-5 grid gap-3 sm:grid-cols-[1fr_1.4fr_auto] sm:items-end">
        <div><label className="label" htmlFor="n">Company name</label><input id="n" className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. MeetUniversity" required /></div>
        <div><label className="label" htmlFor="u">Website</label><input id="u" className="input" value={url} onChange={(e) => setUrl(e.target.value)} placeholder="https://www.meetuniversity.com" required /></div>
        <button className="btn" disabled={busy}>Research company</button>
      </form>
      <JobPanel jobId={jobId} onDone={async (j) => { setBusy(false); await reload(); if (j.status !== 'failed') nav('/profile'); }} />
      <h2 className="mb-2 text-sm font-semibold text-ink-700">Configured companies</h2>
      {!list.length ? <Empty>No companies yet. Add one above to start.</Empty> : (
        <ul className="space-y-2">{list.map((c) => (
          <li key={c._id} className="card flex items-center justify-between"><div><div className="font-medium">{c.name}</div><div className="text-xs text-ink-500">{c.url} · added {fmtDate(c.createdAt)}</div></div>
            <div className="flex items-center gap-2"><Badge tone={c.status === 'stack_built' ? 'good' : 'warn'}>{c.status.replace(/_/g, ' ')}</Badge><button className="btn-ghost" onClick={() => { select(c._id); nav('/'); }}>Open</button><button className="btn-danger" onClick={() => remove(c)}>Delete</button></div></li>
        ))}</ul>
      )}
    </div>
  );
}
