import React, { useEffect, useRef, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Tabs, Badge, Meter, Empty, JobPanel, useJob, Err, statusTone } from '../components/ui.jsx';

const CATS = [['customers', 'Customers'], ['competitors', 'Competitors'], ['market', 'Market'], ['internal', 'Internal']];

export default function Stack() {
  const { company, reload } = useCompany();
  const [data, setData] = useState({ sources: [], competitors: [], changes: [] });
  const [tab, setTab] = useState('customers'); const [docs, setDocs] = useState([]); const [err, setErr] = useState(null); const [up, setUp] = useState(false);
  const job = useJob(); const file = useRef();
  const load = async () => { setData(await api.get(`/companies/${company._id}/stack`)); setDocs(await api.get(`/companies/${company._id}/internal`)); };
  useEffect(() => { load().catch(setErr); }, [company._id]);
  const active = data.sources.filter((s) => ['approved', 'suggested'].includes(s.status));
  const by = (c) => active.filter((s) => s.category === c);
  const upload = async (f) => { if (!f) return; setErr(null); setUp(true); try { await api.upload(`/companies/${company._id}/internal`, f); await load(); } catch (e) { setErr(e); } setUp(false); file.current.value = ''; };
  return (
    <div className="max-w-6xl">
      <PageHead title="Signal Stack" sub="Every source has a reason to exist, a validation probe and separate specificity / recency / credibility scores.">
        <button className="btn" disabled={job.busy || company.interview.status === 'not_started'} onClick={() => job.start(`/companies/${company._id}/stack/build`)}>{data.sources.length ? 'Rediscover sources' : 'Build Signal Stack'}</button>
      </PageHead>
      <Err e={err || job.err} />
      {company.interview.status === 'not_started' && <div className="mb-3 text-sm text-amber2">Complete the interview first so sources reflect the founder's priorities.</div>}
      <JobPanel jobId={job.jobId} onDone={() => { job.finish(); reload(); load(); }} />
      <Tabs value={tab} onChange={setTab} tabs={[...CATS.map(([id, label]) => ({ id, label, count: id === 'internal' ? docs.length : by(id).length })), { id: 'changes', label: 'What changed', count: data.changes.length }]} />
      {tab === 'competitors' && (
        <div className="mb-6"><h2 className="mb-2 text-sm font-semibold">Competitor & substitute profiles <Badge>{data.competitors.length}</Badge></h2>
          {!data.competitors.length ? <Empty>No competitors discovered yet.</Empty> : <div className="grid gap-3 md:grid-cols-2">{data.competitors.map((c) => (
            <article key={c._id} className="card"><div className="flex items-start justify-between gap-2"><div><a className="font-semibold text-signal-dark underline" href={c.url} target="_blank" rel="noreferrer">{c.name}</a><div className="text-xs text-ink-500">{c.url}</div></div><div className="flex gap-1"><Badge tone={c.kind === 'direct' ? 'bad' : 'warn'}>{c.kind}</Badge><Badge tone="good" title="Homepage fetched successfully">verified reachable</Badge></div></div>
              <p className="mt-2 text-sm"><b>Why it competes:</b> {c.why}</p>{c.positioning && <p className="mt-1 text-sm text-ink-700"><b>Positioning:</b> {c.positioning}</p>}
              {c.pricingNotes && <p className="mt-1 text-sm text-ink-700"><b>Pricing:</b> {c.pricingNotes}</p>}
              {c.facts?.length > 0 && <details className="mt-2 text-xs"><summary className="cursor-pointer text-ink-500">{c.facts.length} verified fact(s)</summary>{c.facts.map((f, i) => <div key={i} className="mt-1 border-l-2 border-gain pl-2">{f.claim} <i className="text-ink-500">“{f.evidenceSnippet}”</i></div>)}</details>}
              {c.assumptions?.length > 0 && <details className="mt-1 text-xs"><summary className="cursor-pointer text-ink-500">{c.assumptions.length} assumption(s)</summary><ul className="list-disc pl-4">{c.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul></details>}
              <button className="btn-danger mt-2" onClick={async () => { await api.del(`/companies/${company._id}/competitors/${c._id}`); load(); }}>Remove competitor & its sources</button></article>
          ))}</div>}
        </div>
      )}
      {tab === 'internal' && (
        <div className="mb-4 card"><h2 className="mb-1 font-semibold">Internal intelligence</h2><p className="mb-3 text-sm text-ink-500">Upload CRM exports, feedback, call/meeting transcripts, support conversations or reports (CSV, Excel, PDF, text). Recurring objections, lost-deal reasons and product requests become evidence-linked signals.</p>
          <input ref={file} type="file" accept=".csv,.tsv,.xlsx,.xls,.pdf,.txt,.md" className="hidden" onChange={(e) => upload(e.target.files[0])} />
          <button className="btn" disabled={up} onClick={() => file.current.click()}>{up ? 'Analysing file…' : 'Upload file'}</button>
          <ul className="mt-3 space-y-2">{docs.map((d) => <li key={d._id} className="flex items-center justify-between rounded border border-ink-100 p-2 text-sm"><div><b>{d.filename}</b> <Badge>{d.kind}</Badge> <span className="text-xs text-ink-500">{d.rows ? `${d.rows} rows · ` : ''}{d.analysis?.signalsCreated ?? 0} signals · {fmtDate(d.createdAt)}</span><div className="text-xs text-ink-500">{d.analysis?.summary}</div>{d.limitations?.map((l, i) => <div key={i} className="text-xs text-amber2">{l}</div>)}</div><button className="btn-danger" onClick={async () => { await api.del(`/internal/${d._id}`); load(); }}>Delete</button></li>)}</ul>
          {!docs.length && <Empty>No internal files uploaded. This category stays empty rather than showing invented data.</Empty>}
        </div>
      )}
      {tab === 'changes' ? (
        !data.changes.length ? <Empty>No reassessments yet. Edit the profile and reassess to see what changed and why.</Empty> :
        data.changes.map((c) => <div key={c._id} className="card mb-3"><div className="text-xs text-ink-500">{fmtDate(c.createdAt)} · {c.trigger}</div><p className="my-1 text-sm">{c.summary}</p>
          <ul className="text-sm">{c.changes.map((x, i) => <li key={i} className="mt-1"><Badge tone={x.type === 'added' ? 'good' : 'bad'}>{x.type}</Badge> <b>{x.name}</b> <span className="text-xs text-ink-500">[{x.category}]</span> {x.reason}</li>)}</ul></div>)
      ) : tab !== 'internal' && (
        !by(tab).length ? <Empty>No sources in this category yet.</Empty> :
        <div className="grid gap-3 lg:grid-cols-2">{by(tab).map((s) => (
          <article key={s._id} className="card">
            <div className="flex items-start justify-between gap-2"><div className="min-w-0"><div className="font-medium">{s.name}</div><div className="truncate text-xs text-ink-500">{s.competitor && <b>{s.competitor} · </b>}{s.type} · {s.url || s.query}</div></div><Badge tone={statusTone(s.status)}>{s.status}</Badge></div>
            <p className="mt-2 text-sm"><b>Why included:</b> {s.reason}</p>
            <div className="mt-2 flex gap-3"><Meter label="Specific" v={s.scores?.specific} /><Meter label="Recent" v={s.scores?.recent} /><Meter label="Credible" v={s.scores?.credible} /></div>
            <p className="mt-2 text-xs text-ink-500">{s.scoreNotes}</p>
          </article>))}</div>
      )}
    </div>
  );
}
