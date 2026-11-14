import React, { useEffect, useState } from 'react';
import { api, fmtDate, fmtTime } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Badge, Verification, Empty, Err, JobPanel, useJob, Tabs } from '../components/ui.jsx';

const Facts = ({ x }) => (
  <ul className="mt-1 space-y-1 text-sm">{x.facts.map((f, i) => (
    <li key={i} className="border-l-2 border-gain pl-2"><b>Verified fact:</b> {f.text} <a className="text-signal underline" href={f.url} target="_blank" rel="noreferrer">{f.source || 'source'}</a> <span className="text-xs text-ink-500">{fmtDate(f.date)}</span> <Verification v={f.verification} />
      {f.quotes?.length > 0 && <div className="italic text-ink-700">{f.quotes.map((q, j) => <div key={j}>“{q}”</div>)}</div>}</li>))}</ul>
);
const Interp = ({ children }) => <div className="mt-1 rounded bg-amber-50 p-2 text-sm"><b>Our interpretation:</b> {children}</div>;
const Sec = ({ n, title, children }) => <section className="card mb-4"><h2 className="mb-2 font-serif text-lg font-semibold">{n}. {title}</h2>{children}</section>;
const None = ({ t }) => <p className="text-sm italic text-ink-500">{t}</p>;

function BriefView({ b }) {
  // Older or partly-saved briefs may lack some sections: default everything so the page can never crash.
  const raw = b.content || {};
  const c = { meta: {}, executiveSummary: [], customers: [], competitors: [], market: [], internal: [], opportunities: [], risks: [], actions: [], watch: [], appendix: [], ...raw, notes: raw.notes || {} };
  const n = c.notes;
  const cat = (k, items, note) => items.length ? items.map((x, i) => <div key={i} className="mb-3"><h3 className="font-medium">{x.theme || x.competitor}</h3><Facts x={x} /><Interp>{x.interpretation || x.whyItMatters}{x.implications && <> Implications: {x.implications}</>}</Interp></div>) : <None t={note} />;
  return (
    <div>
      <div className="mb-3 text-xs text-ink-500">Period {fmtDate(c.meta.periodStart)} – {fmtDate(c.meta.periodEnd)} · {c.meta.signalsConsidered} signals from {c.meta.recordsCollected} new records · {c.meta.approvedSources} approved sources · {c.meta.competitorsTracked} competitors · generated {fmtTime(c.meta.generatedAt)} ({b.trigger})</div>
      {b.limitations?.length > 0 && <div className="mb-4 rounded border border-amber-300 bg-amber-50 p-3 text-sm"><b>Limitations</b><ul className="list-disc pl-4">{b.limitations.map((l, i) => <li key={i}>{l}</li>)}</ul></div>}
      <Sec n={1} title="Executive summary">{c.executiveSummary.length ? <ol className="list-decimal space-y-3 pl-5">{c.executiveSummary.map((x, i) => <li key={i}><b>{x.headline}</b><Facts x={x} /><Interp>{x.whyItMatters}</Interp></li>)}</ol> : <None t={n.executiveSummary} />}</Sec>
      <Sec n={2} title="Customer signals">{cat('customers', c.customers, n.customers)}</Sec>
      <Sec n={3} title="Competitor intelligence">{cat('competitors', c.competitors, n.competitors)}</Sec>
      <Sec n={4} title="Market intelligence">{cat('market', c.market, n.market)}</Sec>
      <Sec n={5} title="Internal business intelligence">{cat('internal', c.internal, n.internal)}</Sec>
      <Sec n={6} title="Opportunities identified">{n.opportunities && <None t={n.opportunities} />}{c.opportunities.map((x, i) => <div key={i} className="mb-3"><h3 className="font-medium">{x.title} <Badge tone={x.priority === 'high' ? 'good' : 'neutral'}>{x.priority}</Badge></h3><Facts x={x} /><Interp>Impact: {x.impact}<br /><b>Next step:</b> {x.nextStep}</Interp></div>)}</Sec>
      <Sec n={7} title="Risks & threats">{n.risks && <None t={n.risks} />}{c.risks.map((x, i) => <div key={i} className="mb-3"><h3 className="font-medium">{x.title} <Badge tone={x.urgency === 'high' || x.urgency === 'critical' ? 'bad' : 'warn'}>urgency: {x.urgency}</Badge></h3><Facts x={x} /><Interp>Possible impact: {x.possibleImpact}</Interp></div>)}</Sec>
      <Sec n={8} title="Recommended actions for this week">{c.actions.length ? <ol className="list-decimal space-y-2 pl-5 text-sm">{c.actions.map((x, i) => <li key={i}><b>{x.action}</b> <Badge>{x.priority}</Badge> <Badge tone="info">owner: {x.owner || 'unassigned'}</Badge><div className="text-ink-700">{x.reason}</div></li>)}</ol> : <None t="No actions recommended: no evidence-backed developments this period." />}</Sec>
      <Sec n={9} title="What we should watch">{n.watch && <None t={n.watch} />}<ul className="list-disc pl-5 text-sm">{c.watch.map((x, i) => <li key={i}><b>{x.item}</b>: {x.why}</li>)}</ul></Sec>
      <Sec n={10} title="Source appendix"><div className="overflow-x-auto"><table className="w-full text-left text-xs"><thead className="text-ink-500"><tr>{['Source', 'Published', 'Discovered', 'Evidence snippet', 'Verification', 'Reliability', 'Evidence'].map((h) => <th key={h} className="py-1 pr-3 font-medium">{h}</th>)}</tr></thead>
        <tbody>{c.appendix.map((a) => <tr key={a.id} className="border-t border-ink-100 align-top"><td className="py-1 pr-3"><a className="text-signal underline" href={a.url} target="_blank" rel="noreferrer">{a.source || a.domain}</a><div className="max-w-[220px] truncate text-ink-500">{a.url}</div></td><td className="pr-3">{fmtDate(a.published)}</td><td className="pr-3">{fmtDate(a.discovered)}</td><td className="max-w-xs pr-3">“{a.snippet}” {a.snippetVerified ? <Badge tone="good">verbatim</Badge> : <Badge tone="bad">unverified</Badge>}</td><td className="pr-3"><Verification v={a.verification} /></td><td className="pr-3">{Math.round((a.sourceReliability || 0) * 100)}%</td><td>{Math.round((a.evidenceStrength || 0) * 100)}%</td></tr>)}</tbody></table>
        {!c.appendix.length && <None t="No evidenced signals this period." />}</div></Sec>
    </div>
  );
}

export default function Briefs() {
  const { company } = useCompany();
  const [list, setList] = useState([]); const [cur, setCur] = useState(null); const [actions, setActions] = useState([]); const [tab, setTab] = useState('brief'); const [err, setErr] = useState(null); const [mail, setMail] = useState(''); const [msg, setMsg] = useState('');
  const job = useJob();
  const load = async (open) => { const l = await api.get(`/companies/${company._id}/briefs`); setList(l); setActions(await api.get(`/companies/${company._id}/actions`)); const id = open || cur?._id || l[0]?._id; if (id) setCur(await api.get(`/briefs/${id}`)); else setCur(null); };
  useEffect(() => { load().catch(setErr); }, [company._id]);
  const setAct = async (a, patch) => { await api.patch(`/actions/${a._id}`, patch); setActions(await api.get(`/companies/${company._id}/actions`)); };
  return (
    <div className="max-w-5xl">
      <PageHead title="Monday morning brief" sub="Decision-relevant intelligence only. Each claim cites collected evidence; empty sections say so instead of filling space.">
        <button className="btn" disabled={job.busy} onClick={() => job.start(`/companies/${company._id}/briefs/generate`, {})}>{job.busy ? 'Generating…' : 'Generate brief now'}</button>
      </PageHead>
      <Err e={err || job.err} />
      <JobPanel jobId={job.jobId} onDone={(j) => { job.finish(); load(j.stats?.briefId); }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'brief', label: 'Brief' }, { id: 'history', label: 'History', count: list.length }, { id: 'actions', label: 'Action tracker', count: actions.filter((a) => a.status !== 'done').length }]} />
      {tab === 'history' && (!list.length ? <Empty>No briefs generated yet.</Empty> : <ul className="space-y-2">{list.map((b) => <li key={b._id} className="card flex items-center justify-between"><div><div className="font-medium">{b.weekKey} · {fmtDate(b.createdAt)}</div><div className="text-xs text-ink-500">{b.trigger} · {b.signalIds?.length || 0} evidenced signals{b.emailedAt ? ` · emailed ${fmtDate(b.emailedAt)}` : ''}</div></div><button className="btn-ghost" onClick={async () => { setCur(await api.get(`/briefs/${b._id}`)); setTab('brief'); }}>Open</button></li>)}</ul>)}
      {tab === 'actions' && (!actions.length ? <Empty>Actions from briefs will appear here for tracking.</Empty> : <ul className="space-y-2">{actions.map((a) => <li key={a._id} className="card flex flex-wrap items-center justify-between gap-2"><div className="min-w-0 flex-1"><div className={`font-medium ${a.status === 'done' ? 'text-ink-500 line-through' : ''}`}>{a.title}</div><div className="text-xs text-ink-500">{a.reason}</div><div className="mt-1 flex gap-1"><Badge>{a.priority}</Badge><Badge tone="info">{a.owner || 'unassigned'}</Badge></div></div>
        <select aria-label="Action status" className="input max-w-[140px]" value={a.status} onChange={(e) => setAct(a, { status: e.target.value })}><option value="todo">To do</option><option value="doing">In progress</option><option value="done">Done</option></select></li>)}</ul>)}
      {tab === 'brief' && (!cur ? <Empty>No brief yet. Generate one after sources have been crawled.</Empty> : (<>
        <div className="mb-4 flex flex-wrap items-center gap-2"><button className="btn-ghost" onClick={() => api.download(`/briefs/${cur._id}/export.md`, `brief-${cur.weekKey}.md`).catch(setErr)}>Download Markdown</button><button className="btn-ghost" onClick={() => api.download(`/briefs/${cur._id}/export.html`, `brief-${cur.weekKey}.html`).catch(setErr)}>Download email-ready HTML</button>
          <input aria-label="Email address" className="input max-w-[220px]" placeholder="email@company.com" value={mail} onChange={(e) => setMail(e.target.value)} /><button className="btn-ghost" onClick={() => api.post(`/briefs/${cur._id}/email`, { to: mail || company.settings.brief.emailTo }).then(() => setMsg('Sent.')).catch(setErr)}>Email brief</button>{msg && <span className="text-sm text-gain">{msg}</span>}</div>
        <BriefView b={cur} /></>))}
    </div>
  );
}