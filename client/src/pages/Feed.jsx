import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Badge, Verification, Meter, Empty, Err, statusTone } from '../components/ui.jsx';

export default function Feed() {
  const { company } = useCompany();
  const [sig, setSig] = useState([]); const [comps, setComps] = useState([]); const [err, setErr] = useState(null); const [open, setOpen] = useState(null);
  const [f, setF] = useState({ category: '', competitor: '', from: '', to: '', minRelevance: '', impact: '', verification: '', sort: 'date' });
  useEffect(() => { api.get(`/companies/${company._id}/stack`).then((s) => setComps(s.competitors)).catch(() => {}); }, [company._id]);
  useEffect(() => { const qs = new URLSearchParams(Object.entries(f).filter(([, v]) => v)).toString(); api.get(`/companies/${company._id}/signals?${qs}`).then(setSig).catch(setErr); }, [company._id, f]);
  const S = (k, label, opts) => <div><label className="label" htmlFor={k}>{label}</label><select id={k} className="input" value={f[k]} onChange={(e) => setF({ ...f, [k]: e.target.value })}><option value="">All</option>{opts.map((o) => <option key={o.v ?? o} value={o.v ?? o}>{o.l ?? o}</option>)}</select></div>;
  return (
    <div className="max-w-5xl">
      <PageHead title="Intelligence feed" sub="Analysed developments only, each with its evidence snippet and link. Verified facts and our interpretation are kept apart." />
      <Err e={err} />
      <div className="card mb-4 grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
        {S('category', 'Category', ['customers', 'competitors', 'market', 'internal'])}{S('competitor', 'Competitor', comps.map((c) => c.name))}
        {S('impact', 'Impact', ['opportunity', 'threat', 'neutral'])}{S('verification', 'Verification', ['corroborated', 'single_source', 'unverified', 'user_generated', 'internal_data'])}
        {S('minRelevance', 'Relevance', [{ v: '0.4', l: '≥ 40%' }, { v: '0.6', l: '≥ 60%' }, { v: '0.8', l: '≥ 80%' }])}{S('sort', 'Order', [{ v: 'date', l: 'Newest' }, { v: 'score', l: 'Highest rank' }])}
        <div><label className="label" htmlFor="fr">From</label><input id="fr" type="date" className="input" value={f.from} onChange={(e) => setF({ ...f, from: e.target.value })} /></div>
        <div><label className="label" htmlFor="to">To</label><input id="to" type="date" className="input" value={f.to} onChange={(e) => setF({ ...f, to: e.target.value })} /></div>
      </div>
      {!sig.length ? <Empty>No signals match. Run monitoring from the dashboard; nothing is shown unless it was actually collected and analysed.</Empty> : (
        <ul className="space-y-3">{sig.map((s) => (
          <li key={s._id} className="card">
            <div className="flex flex-wrap items-start justify-between gap-2"><div className="min-w-0"><div className="mb-1 flex flex-wrap gap-1"><Badge tone="info">{s.category}</Badge>{s.competitor && <Badge>{s.competitor}</Badge>}<Badge tone={statusTone(s.impactType)}>{s.impactType}</Badge><Badge tone={s.urgency === 'high' || s.urgency === 'critical' ? 'bad' : 'neutral'}>urgency: {s.urgency}</Badge><Verification v={s.verification} />{s.businessArea && <Badge>{s.businessArea}</Badge>}</div>
              <h3 className="font-medium">{s.headline}</h3></div><div className="text-right"><div className="font-serif text-xl font-semibold text-signal-dark">{Math.round(s.score)}</div><div className="text-[11px] text-ink-500">rank score</div></div></div>
            <div className="mt-2 text-sm"><b>Verified fact:</b> {s.whatHappened}</div>
            <div className="mt-1 text-xs text-ink-500">{s.sourceName} · published {fmtDate(s.publishedAt || s.eventDate)} · discovered {fmtDate(s.discoveredAt)} · <a className="text-signal underline" href={s.sourceUrl} target="_blank" rel="noreferrer">{s.sourceUrl?.startsWith('internal://') ? 'internal document' : 'open source'}</a></div>
            <button className="mt-2 text-xs text-signal-dark underline" onClick={() => setOpen(open === s._id ? null : s._id)}>{open === s._id ? 'Hide' : 'Evidence, interpretation & ranking'}</button>
            {open === s._id && (
              <div className="mt-2 space-y-2 border-t border-ink-100 pt-2 text-sm">
                <div><b>Evidence snippet</b> {s.evidenceVerified ? <Badge tone="good">verbatim match</Badge> : <Badge tone="bad">not verbatim-verified</Badge>}<blockquote className="mt-1 border-l-2 border-ink-300 pl-2 text-ink-700">“{s.evidenceSnippet}”</blockquote></div>
                {s.customerQuotes?.length > 0 && <div><b>Customer language</b> {s.sentiment && <Badge>{s.sentiment}</Badge>}{s.customerQuotes.map((q, i) => <blockquote key={i} className="mt-1 border-l-2 border-signal pl-2 italic">“{q}”</blockquote>)}</div>}
                <div className="rounded bg-amber-50 p-2"><b>Our interpretation (not verified fact):</b> {s.interpretation || s.whyItMatters}{s.considerations?.length > 0 && <ul className="mt-1 list-disc pl-4">{s.considerations.map((c, i) => <li key={i}>{c}</li>)}</ul>}</div>
                <div className="flex flex-wrap gap-4"><Meter label="Source reliability" v={s.sourceReliability} /><Meter label="Evidence strength" v={s.evidenceStrength} /><Meter label="Strategic relevance" v={s.strategicRelevance} /></div>
                <p className="text-xs text-ink-500">{s.rankExplanation}</p>
              </div>)}
          </li>))}</ul>)}
    </div>
  );
}
