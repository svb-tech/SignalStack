import React, { useEffect, useState } from 'react';
import { api, fmtDate } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Err, Badge, JobPanel, useJob } from '../components/ui.jsx';

const FIELDS = [
  ['oneLiner', 'One-line description', 's'], ['industry', 'Industry', 's'], ['positioning', 'Positioning', 's'], ['geographies', 'Geographies', 's'],
  ['businessLines', 'Business lines', 'a'], ['revenueStreams', 'Revenue streams', 'a'], ['customerSegments', 'Customer segments', 'a'], ['highValueSegments', 'Highest-value segments', 'a'],
  ['customerProblems', 'Customer problems', 'a'], ['unmetNeeds', 'Unmet needs', 'a'], ['whyCustomersChoose', 'Why customers choose us', 'a'], ['competitorsNamed', 'Competitors / substitutes named', 'a'],
  ['marketChanges', 'Major market changes', 'a'], ['materialRisks', 'Developments that could hurt us', 'a'], ['growthPriorities', 'Growth priorities (6-12 months)', 'a'], ['internalInfo', 'Internal info that should influence decisions', 'a'],
  ['decisionsToSupport', 'Decisions this system should support', 'a'], ['keywords', 'Monitoring keywords', 'a'], ['notes', 'Notes', 's'],
];

export default function Profile() {
  const { company, reload } = useCompany();
  const [p, setP] = useState({}); const [msg, setMsg] = useState(''); const [err, setErr] = useState(null);
  const job = useJob();
  useEffect(() => setP(company.profile || {}), [company._id, company.updatedAt]);
  const r = company.research || {};
  const set = (k, v, arr) => setP({ ...p, [k]: arr ? v.split('\n').map((x) => x.trim()).filter(Boolean) : v });
  const save = async () => { setErr(null); try { await api.put(`/companies/${company._id}/profile`, { profile: p }); await reload(); setMsg('Saved. Sources may need reassessment.'); } catch (e) { setErr(e); } };
  return (
    <div className="max-w-5xl">
      <PageHead title="Company intelligence profile" sub="Built from public research and the founder interview. Edit anything; changes flag the Signal Stack for reassessment.">
        <button className="btn-ghost" onClick={() => api.post(`/companies/${company._id}/research`).then(() => setMsg('Research re-run started; reload in a minute.')).catch(setErr)}>Re-run research</button>
        <button className="btn" onClick={save}>Save profile</button>
      </PageHead>
      <Err e={err || job.err} />
      {msg && <div className="mb-3 text-sm text-gain">{msg}</div>}
      {company.profileDirty && (
        <div className="card mb-4 flex flex-wrap items-center justify-between gap-2 border-amber-300 bg-amber-50">
          <div className="text-sm"><b>Business context changed.</b> Reassess sources to deprecate no-longer-useful ones, add new ones and see an explanation of what changed.</div>
          <button className="btn" disabled={job.busy} onClick={() => job.start(`/companies/${company._id}/stack/reassess`)}>Reassess Signal Stack</button>
        </div>
      )}
      <JobPanel jobId={job.jobId} onDone={() => { job.finish(); reload(); }} />
      <div className="grid gap-4 lg:grid-cols-[1.1fr_1fr]">
        <div className="space-y-3">
          {FIELDS.map(([k, label, t]) => (
            <div key={k}><label className="label" htmlFor={k}>{label}{t === 'a' && <span className="font-normal"> (one per line)</span>}</label>
              <textarea id={k} className="input" rows={t === 'a' ? Math.min(6, Math.max(2, (p[k] || []).length)) : 2} value={t === 'a' ? (p[k] || []).join('\n') : p[k] || ''} onChange={(e) => set(k, e.target.value, t === 'a')} /></div>
          ))}
        </div>
        <div className="space-y-4">
          <section className="card"><h2 className="mb-2 font-semibold">Verified facts <Badge tone="good">{(r.facts || []).length}</Badge></h2>
            <p className="mb-2 text-xs text-ink-500">Each fact has a quote that was checked verbatim against the fetched source.</p>
            {(r.facts || []).map((f, i) => <div key={i} className="mb-2 border-l-2 border-gain pl-2 text-sm">{f.claim}<div className="text-xs text-ink-500">“{f.evidenceSnippet}” <a className="text-signal underline" href={f.sourceUrl} target="_blank" rel="noreferrer">source</a></div></div>)}
            {!(r.facts || []).length && <div className="text-sm text-ink-500">No verified facts yet.</div>}</section>
          <section className="card"><h2 className="mb-2 font-semibold">Assumptions <Badge tone="warn">{(r.assumptions || []).length}</Badge></h2>
            {(r.assumptions || []).map((a, i) => <div key={i} className="mb-2 border-l-2 border-amber-400 pl-2 text-sm">{a.claim}<div className="text-xs text-ink-500">{a.rationale}</div></div>)}</section>
          {(r.unknowns?.length > 0 || r.limitations?.length > 0) && <section className="card text-sm"><h2 className="mb-1 font-semibold">Unknowns & limitations</h2><ul className="list-disc pl-4 text-ink-700">{[...(r.unknowns || []), ...(r.limitations || [])].map((u, i) => <li key={i}>{u}</li>)}</ul></section>}
          <section className="card text-xs text-ink-500">Researched {fmtDate(r.researchedAt)} · {(r.pages || []).length} pages read · {company.profileHistory?.length || 0} earlier profile version(s) kept</section>
        </div>
      </div>
    </div>
  );
}
