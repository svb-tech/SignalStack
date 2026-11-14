import React, { useEffect, useState } from 'react';
import { api, fmtTime, fmtDate } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Badge, statusTone, Empty, Err, JobPanel, useJob, Tabs } from '../components/ui.jsx';

export default function Operations() {
  const { company } = useCompany();
  const [jobs, setJobs] = useState([]); const [audits, setAudits] = useState([]); const [tab, setTab] = useState('audits'); const [err, setErr] = useState(null); const [sel, setSel] = useState(null);
  const job = useJob();
  const load = async () => { setJobs(await api.get(`/companies/${company._id}/jobs`)); setAudits(await api.get(`/companies/${company._id}/audits`)); };
  useEffect(() => { load().catch(setErr); }, [company._id]);
  const apply = async (a, body) => { await api.post(`/audits/${a._id}/apply`, body); load(); };
  return (
    <div className="max-w-5xl">
      <PageHead title="Jobs & source-health audits" sub="Every scheduled and manual run is logged. Failures are shown here and on the dashboard.">
        <button className="btn" disabled={job.busy} onClick={() => job.start(`/companies/${company._id}/audits/run`)}>Run monthly audit now</button>
      </PageHead>
      <Err e={err || job.err} />
      <JobPanel jobId={job.jobId} onDone={() => { job.finish(); load(); }} />
      <Tabs value={tab} onChange={setTab} tabs={[{ id: 'audits', label: 'Source-health reports', count: audits.length }, { id: 'jobs', label: 'Run log', count: jobs.length }]} />
      {tab === 'jobs' && (!jobs.length ? <Empty>No runs yet.</Empty> : <div className="overflow-x-auto rounded-lg border border-ink-100 bg-white"><table className="w-full text-left text-sm"><thead className="bg-ink-50 text-xs text-ink-500"><tr>{['Started', 'Job', 'Trigger', 'Status', 'Details'].map((h) => <th key={h} className="px-3 py-2 font-medium">{h}</th>)}</tr></thead><tbody>{jobs.map((j) => <tr key={j._id} className="border-t border-ink-100"><td className="px-3 py-2 text-xs">{fmtTime(j.startedAt)}</td><td className="px-3 py-2">{j.type.replace(/_/g, ' ')}</td><td className="px-3 py-2">{j.trigger}</td><td className="px-3 py-2"><Badge tone={statusTone(j.status)}>{j.status}</Badge></td><td className="px-3 py-2 text-xs">{j.error ? <span className="text-risk">{j.error}</span> : j.stats ? Object.entries(j.stats).filter(([, v]) => typeof v === 'number').map(([k, v]) => `${k}: ${v}`).join(' · ') : ''}</td></tr>)}</tbody></table></div>)}
      {tab === 'audits' && (!audits.length ? <Empty>No audit has run yet. The monthly audit checks dead URLs, duplicates, inactive or declining sources and proposes new ones.</Empty> : audits.map((a) => (
        <article key={a._id} className="card mb-4"><div className="flex items-center justify-between"><h2 className="font-semibold">Audit {fmtDate(a.createdAt)}</h2><div className="flex gap-2"><button className="btn-ghost" onClick={() => setSel(sel === a._id ? null : a._id)}>{sel === a._id ? 'Hide findings' : 'Findings'}</button>{a.recommendations.some((r) => r.state === 'pending') && <button className="btn" onClick={() => apply(a, { all: true })}>Apply all</button>}</div></div>
          <p className="my-2 text-sm">{a.summary}</p>
          <ul className="space-y-1 text-sm">{a.recommendations.map((r, i) => <li key={i} className="flex flex-wrap items-center justify-between gap-2 rounded border border-ink-100 p-2"><span><Badge tone={r.action === 'add' ? 'good' : r.action === 'remove' ? 'bad' : 'warn'}>{r.action}</Badge> {r.reason}</span>
            {r.state === 'pending' ? <span className="flex gap-1"><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => apply(a, { index: i })}>Apply</button><button className="btn-ghost !px-2 !py-1 text-xs" onClick={() => apply(a, { dismiss: i })}>Dismiss</button></span> : <Badge>{r.state}</Badge>}</li>)}</ul>
          {sel === a._id && <ul className="mt-3 space-y-1 text-xs text-ink-700">{a.findings.map((f, i) => <li key={i}><Badge>{f.type}</Badge> <b>{f.sourceName}</b> {f.detail}</li>)}</ul>}
        </article>)))}
    </div>
  );
}
