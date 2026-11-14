import React, { useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import { Bar, BarChart, CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { api, fmtTime } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Badge, statusTone, JobPanel, useJob, Err, Empty } from '../components/ui.jsx';

const Stat = ({ label, v, sub }) => <div className="card"><div className="text-xs text-ink-500">{label}</div><div className="font-serif text-3xl font-semibold text-ink-950">{v}</div>{sub && <div className="text-xs text-ink-500">{sub}</div>}</div>;

export default function Dashboard() {
  const { company, reload } = useCompany();
  const [s, setS] = useState(null); const [err, setErr] = useState(null);
  const job = useJob();
  const load = () => api.get(`/companies/${company._id}/stats`).then(setS).catch(setErr);
  useEffect(() => { load(); }, [company._id]);
  const run = (path) => job.start(`/companies/${company._id}/${path}`, {});
  const cats = ['customers', 'competitors', 'market', 'internal'];
  const cat = (arr, c) => arr?.find((x) => x._id === c)?.n || 0;
  const steps = [['Research', company.research?.researchedAt], ['Interview', company.interview.status === 'complete'], ['Signal Stack', company.status === 'stack_built'], ['Collected records', s?.records > 0], ['Brief', s?.briefs > 0]];
  return (
    <div className="max-w-6xl">
      <PageHead title={company.name} sub={`${company.url} · ${company.research?.summary || 'No summary yet'}`}>
        <button className="btn-ghost" disabled={job.busy} onClick={() => run('monitor')}>Monitor sources now</button>
        <button className="btn" disabled={job.busy} onClick={() => run('briefs/generate')}>Generate brief</button>
        <button className="btn-ghost" disabled={job.busy} onClick={() => run('audits/run')}>Run source audit</button>
      </PageHead>
      <Err e={err || job.err} />
      <JobPanel jobId={job.jobId} onDone={() => { job.finish(); load(); reload(); }} />
      <ol className="mb-5 flex flex-wrap gap-2 text-xs">{steps.map(([l, ok]) => <li key={l} className={`rounded-full px-3 py-1 ${ok ? 'bg-gain/10 text-gain' : 'bg-ink-100 text-ink-500'}`}>{ok ? '✓' : '○'} {l}</li>)}</ol>
      {!s ? <Empty>Loading…</Empty> : (<>
        <div className="mb-5 grid grid-cols-2 gap-3 md:grid-cols-5"><Stat label="Approved sources" v={cats.reduce((a, c) => a + cat(s.sourcesByCat, c), 0)} sub={cats.map((c) => `${c[0].toUpperCase()}${cat(s.sourcesByCat, c)}`).join(' ')} /><Stat label="Competitors" v={s.competitors} /><Stat label="Collected records" v={s.records} /><Stat label="Analysed signals" v={s.signals} /><Stat label="Briefs" v={s.briefs} /></div>
        {s.failedJobs.length > 0 && <div className="mb-5 rounded-lg border border-risk/30 bg-risk/5 p-3"><h2 className="mb-1 text-sm font-semibold text-risk">Failed runs</h2>{s.failedJobs.map((j) => <div key={j._id} className="text-sm"><Badge tone="bad">{j.type}</Badge> {fmtTime(j.startedAt)}: {j.error}</div>)}<Link to="/operations" className="text-xs underline">See all jobs</Link></div>}
        <div className="grid gap-4 lg:grid-cols-2">
          <section className="card"><h2 className="mb-2 text-sm font-semibold">Signals by category</h2><div className="h-52"><ResponsiveContainer><BarChart data={cats.map((c) => ({ c, signals: cat(s.signalsByCat, c), sources: cat(s.sourcesByCat, c) }))}><CartesianGrid strokeDasharray="3 3" stroke="#e6ecef" /><XAxis dataKey="c" fontSize={12} /><YAxis allowDecimals={false} fontSize={12} /><Tooltip /><Bar dataKey="sources" fill="#a9b7c1" name="approved sources" /><Bar dataKey="signals" fill="#0e7c7b" name="signals" /></BarChart></ResponsiveContainer></div></section>
          <section className="card"><h2 className="mb-2 text-sm font-semibold">Signals discovered per day</h2><div className="h-52">{s.byDay.length ? <ResponsiveContainer><LineChart data={s.byDay.map((d) => ({ d: d._id.slice(5), n: d.n }))}><CartesianGrid strokeDasharray="3 3" stroke="#e6ecef" /><XAxis dataKey="d" fontSize={12} /><YAxis allowDecimals={false} fontSize={12} /><Tooltip /><Line dataKey="n" stroke="#0e7c7b" strokeWidth={2} dot name="signals" /></LineChart></ResponsiveContainer> : <Empty>No signals yet.</Empty>}</div></section>
          <section className="card"><h2 className="mb-2 text-sm font-semibold">Source health</h2><div className="flex gap-2">{['healthy', 'degraded', 'failing'].map((h) => <Badge key={h} tone={h === 'healthy' ? 'good' : h === 'degraded' ? 'warn' : 'bad'}>{h}: {s.health.find((x) => x._id === h)?.n || 0}</Badge>)}</div></section>
          <section className="card"><h2 className="mb-2 text-sm font-semibold">Automation</h2><div className="text-sm text-ink-700">Scheduler: {s.schedule.active ? <Badge tone="good">{s.schedule.active} schedule(s) active</Badge> : <Badge tone="warn">inactive (build the Signal Stack)</Badge>}</div>
            <ul className="mt-2 space-y-1 text-xs">{s.lastJobs.map((j) => <li key={j.type}><Badge tone={statusTone(j.status)}>{j.status}</Badge> {j.type.replace(/_/g, ' ')} · {fmtTime(j.at)}</li>)}</ul></section>
        </div></>)}
    </div>
  );
}
