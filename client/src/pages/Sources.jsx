import React, { useEffect, useState } from 'react';
import { api, fmtTime } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Badge, statusTone, Err, Empty, Tabs } from '../components/ui.jsx';

const TYPES = ['webpage', 'listing', 'rss', 'google_news', 'hn', 'stackexchange', 'reddit', 'web_search'];

export default function Sources() {
  const { company } = useCompany();
  const [src, setSrc] = useState([]); const [dups, setDups] = useState([]); const [logs, setLogs] = useState(null); const [err, setErr] = useState(null);
  const [filter, setFilter] = useState(''); const [status, setStatus] = useState(''); const [view, setView] = useState('list'); const [busy, setBusy] = useState('');
  const [f, setF] = useState({ category: 'market', type: 'webpage', url: '', query: '', name: '', reason: '' });
  const load = async () => { setSrc(await api.get(`/companies/${company._id}/sources`)); setDups(await api.get(`/companies/${company._id}/sources/duplicates`)); };
  useEffect(() => { load().catch(setErr); }, [company._id]);
  const act = async (fn, id) => { setErr(null); setBusy(id || 'x'); try { await fn(); await load(); } catch (e) { setErr(e); } setBusy(''); };
  const add = (e) => { e.preventDefault(); act(async () => { await api.post(`/companies/${company._id}/sources`, { ...f, url: ['google_news', 'hn', 'stackexchange', 'reddit', 'web_search'].includes(f.type) ? undefined : f.url, query: ['webpage', 'listing', 'rss'].includes(f.type) ? undefined : f.query }); setF({ ...f, url: '', query: '', name: '', reason: '' }); }, 'add'); };
  const rows = src.filter((s) => (!filter || s.category === filter) && (!status || s.status === status));
  return (
    <div className="max-w-6xl">
      <PageHead title="Source manager" sub="Approve discovered sources, add your own, and watch source health and crawl history. Only approved sources are crawled; robots.txt is always respected.">
        <button className="btn-ghost" onClick={() => act(async () => { await api.post(`/companies/${company._id}/sources/approve-suggested`); }, 'appr')}>Approve all suggested</button>
      </PageHead>
      <Err e={err} />
      <form onSubmit={add} className="card mb-4 grid gap-2 md:grid-cols-6">
        <div><label className="label" htmlFor="c">Category</label><select id="c" className="input" value={f.category} onChange={(e) => setF({ ...f, category: e.target.value })}>{['customers', 'competitors', 'market'].map((c) => <option key={c}>{c}</option>)}</select></div>
        <div><label className="label" htmlFor="t">Type</label><select id="t" className="input" value={f.type} onChange={(e) => setF({ ...f, type: e.target.value })}>{TYPES.map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="md:col-span-2"><label className="label" htmlFor="uq">{['webpage', 'listing', 'rss'].includes(f.type) ? 'URL' : 'Search query'}</label>
          <input id="uq" className="input" required value={['webpage', 'listing', 'rss'].includes(f.type) ? f.url : f.query} onChange={(e) => setF({ ...f, [['webpage', 'listing', 'rss'].includes(f.type) ? 'url' : 'query']: e.target.value })} /></div>
        <div><label className="label" htmlFor="nm">Name</label><input id="nm" className="input" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} /></div>
        <div><label className="label" htmlFor="rs">Reason</label><input id="rs" className="input" value={f.reason} onChange={(e) => setF({ ...f, reason: e.target.value })} placeholder="Why monitor this?" /></div>
        <div className="md:col-span-6"><button className="btn" disabled={busy === 'add'}>{busy === 'add' ? 'Validating source…' : 'Validate & add source'}</button></div>
      </form>
      <Tabs value={view} onChange={setView} tabs={[{ id: 'list', label: 'Sources', count: src.length }, { id: 'dups', label: 'Duplicates', count: dups.length }]} />
      {view === 'dups' ? (!dups.length ? <Empty>No duplicate items detected yet. When two sources publish the same story, it is stored once and linked here.</Empty> :
        <ul className="space-y-2">{dups.map((d) => <li key={d._id} className="card text-sm"><a className="font-medium text-signal-dark underline" href={d.url} target="_blank" rel="noreferrer">{d.title}</a><div className="text-xs text-ink-500">First seen in {d.source?.name}; also in: {d.alsoSeenIn.map((a) => a.domain).join(', ')}</div></li>)}</ul>) : (<>
        <div className="mb-3 flex gap-2"><select aria-label="Category" className="input max-w-[160px]" value={filter} onChange={(e) => setFilter(e.target.value)}><option value="">All categories</option>{['customers', 'competitors', 'market', 'internal'].map((c) => <option key={c}>{c}</option>)}</select>
          <select aria-label="Status" className="input max-w-[160px]" value={status} onChange={(e) => setStatus(e.target.value)}><option value="">All statuses</option>{['approved', 'suggested', 'rejected', 'blocked', 'deprecated', 'dead'].map((c) => <option key={c}>{c}</option>)}</select></div>
        <div className="overflow-x-auto rounded-lg border border-ink-100 bg-white"><table className="w-full text-left text-sm">
          <thead className="bg-ink-50 text-xs text-ink-500"><tr>{['Source', 'Category', 'Status', 'Health', 'Last check', 'Items 30d / signals', 'Relevance', 'Actions'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead>
          <tbody>{rows.map((s) => (
            <tr key={s._id} className="border-t border-ink-100 align-top">
              <td className="max-w-xs px-3 py-2"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-ink-500">{s.type} · {s.url || s.query}</div>{s.note && <div className="text-xs text-amber2">{s.note}</div>}</td>
              <td className="px-3 py-2">{s.category}</td><td className="px-3 py-2"><Badge tone={statusTone(s.status)}>{s.status}</Badge></td>
              <td className="px-3 py-2 text-xs">{s.health?.consecutiveFailures ? <span className="text-risk">{s.health.consecutiveFailures} failure(s)<br />{s.health.lastError}</span> : s.health?.lastOkAt ? <span className="text-gain">OK</span> : <span className="text-ink-500">not crawled</span>}</td>
              <td className="px-3 py-2 text-xs">{fmtTime(s.health?.lastCheckedAt)}</td>
              <td className="px-3 py-2 text-xs">{s.health?.items30d ?? 0} / {s.health?.signals30d ?? 0}</td>
              <td className="px-3 py-2 text-xs">{s.relevance?.current != null ? `${Math.round(s.relevance.current * 100)}%` : '–'} <Badge tone={s.relevance?.trend === 'down' ? 'bad' : s.relevance?.trend === 'up' ? 'good' : 'neutral'}>{s.relevance?.trend}</Badge></td>
              <td className="px-3 py-2"><div className="flex flex-wrap gap-1">
                {s.status !== 'approved' && s.status !== 'removed' && <button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => act(() => api.patch(`/sources/${s._id}`, { status: 'approved' }), s._id)}>Approve</button>}
                {s.type !== 'upload' && <button disabled={busy === s._id} className="btn-ghost !px-2 !py-1 text-xs" onClick={() => act(() => api.post(`/sources/${s._id}/check`), s._id)}>{busy === s._id ? '…' : 'Check now'}</button>}
                <button className="btn-ghost !px-2 !py-1 text-xs" onClick={async () => setLogs({ s, rows: await api.get(`/sources/${s._id}/logs`) })}>History</button>
                <button className="btn-danger" onClick={() => act(() => api.del(`/sources/${s._id}`), s._id)}>Remove</button></div></td>
            </tr>))}</tbody></table>{!rows.length && <div className="p-6 text-center text-sm text-ink-500">No sources match.</div>}</div></>)}
      {logs && (
        <div className="fixed inset-0 z-20 flex items-center justify-center bg-ink-950/50 p-4" onClick={() => setLogs(null)}><div role="dialog" aria-label="Crawl history" className="max-h-[80vh] w-full max-w-3xl overflow-auto rounded-lg bg-white p-4" onClick={(e) => e.stopPropagation()}>
          <div className="mb-2 flex justify-between"><h2 className="font-semibold">Crawl history: {logs.s.name}</h2><button className="btn-ghost" onClick={() => setLogs(null)}>Close</button></div>
          {!logs.rows.length ? <Empty>No crawls recorded yet.</Empty> : <table className="w-full text-xs"><thead className="text-left text-ink-500"><tr>{['When', 'Result', 'HTTP', 'Found', 'New', 'Dupes', 'ms', 'Error'].map((h) => <th key={h} className="py-1 pr-2">{h}</th>)}</tr></thead><tbody>{logs.rows.map((r) => <tr key={r._id} className="border-t border-ink-100"><td className="py-1 pr-2">{fmtTime(r.startedAt)}</td><td><Badge tone={r.ok ? 'good' : 'bad'}>{r.ok ? 'ok' : 'failed'}</Badge></td><td>{r.httpStatus || '–'}</td><td>{r.itemsFound}</td><td>{r.newItems}</td><td>{r.duplicates}</td><td>{r.durationMs}</td><td className="text-risk">{r.error}</td></tr>)}</tbody></table>}
        </div></div>)}
    </div>
  );
}
