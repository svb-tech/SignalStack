import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api.js';

const TONES = { neutral: 'bg-ink-100 text-ink-700', good: 'bg-gain/10 text-gain', bad: 'bg-risk/10 text-risk', warn: 'bg-amber-100 text-amber2', info: 'bg-signal-soft text-signal-dark' };
export const Badge = ({ tone = 'neutral', children, title }) => <span title={title} className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${TONES[tone]}`}>{children}</span>;
export const statusTone = (s) => ({ approved: 'good', success: 'good', corroborated: 'good', opportunity: 'good', suggested: 'warn', partial: 'warn', single_source: 'warn', running: 'info', failed: 'bad', dead: 'bad', blocked: 'bad', rejected: 'bad', threat: 'bad', unverified: 'bad', deprecated: 'neutral' }[s] || 'neutral');
export const Empty = ({ children }) => <div className="rounded-lg border border-dashed border-ink-300 p-6 text-center text-sm text-ink-500">{children}</div>;
export const Err = ({ e }) => (e ? <div role="alert" className="mb-3 rounded-md border border-risk/30 bg-risk/5 px-3 py-2 text-sm text-risk">{String(e.message || e)}</div> : null);
export const PageHead = ({ title, sub, children }) => (
  <div className="mb-5 flex flex-wrap items-end justify-between gap-3"><div><h1 className="h1">{title}</h1>{sub && <p className="mt-1 max-w-2xl text-sm text-ink-500">{sub}</p>}</div><div className="flex flex-wrap gap-2">{children}</div></div>
);
export const Tabs = ({ tabs, value, onChange }) => (
  <div role="tablist" className="mb-4 flex flex-wrap gap-1 border-b border-ink-100">
    {tabs.map((t) => <button key={t.id} role="tab" aria-selected={value === t.id} onClick={() => onChange(t.id)} className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium ${value === t.id ? 'border-signal text-signal-dark' : 'border-transparent text-ink-500 hover:text-ink-900'}`}>{t.label}{t.count != null && <span className="ml-1.5 text-xs text-ink-500">{t.count}</span>}</button>)}
  </div>
);
export const Meter = ({ label, v }) => (
  <div className="min-w-[88px]"><div className="flex justify-between text-[11px] text-ink-500"><span>{label}</span><span>{Math.round((v || 0) * 100)}%</span></div><div className="h-1.5 rounded bg-ink-100"><div className="h-1.5 rounded bg-signal" style={{ width: `${Math.round((v || 0) * 100)}%` }} /></div></div>
);

/** Polls a background job and shows its live log. Calls onDone when it finishes. */
export function JobPanel({ jobId, onDone }) {
  const [job, setJob] = useState(null);
  const done = useRef(false);
  useEffect(() => {
    done.current = false; if (!jobId) return;
    let stop = false;
    const tick = async () => {
      try { const j = await api.get(`/jobs/${jobId}`); if (stop) return; setJob(j); if (j.status !== 'running') { if (!done.current) { done.current = true; onDone?.(j); } return; } } catch { /* retry */ }
      setTimeout(tick, 1500);
    };
    tick();
    return () => { stop = true; };
  }, [jobId]);
  if (!jobId || !job) return null;
  return (
    <div className="mb-4 rounded-lg border border-ink-100 bg-white">
      <div className="flex items-center justify-between border-b border-ink-100 px-3 py-2 text-sm"><span className="font-medium">{job.type.replace(/_/g, ' ')}</span><Badge tone={statusTone(job.status)}>{job.status}</Badge></div>
      <pre className="max-h-52 overflow-auto whitespace-pre-wrap px-3 py-2 text-xs text-ink-700">{(job.log || []).join('\n') || 'Starting…'}{job.error ? `\nERROR: ${job.error}` : ''}</pre>
      {job.stats?.warnings?.length > 0 && <div className="border-t border-ink-100 px-3 py-2 text-xs text-amber2">{job.stats.warnings.length} warning(s): {job.stats.warnings.slice(0, 3).join(' · ')}</div>}
    </div>
  );
}

/** Button that starts a job endpoint and exposes the job id. */
export function useJob() {
  const [jobId, setJobId] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);
  const start = async (path, body) => { setErr(null); setBusy(true); try { const r = await api.post(path, body); setJobId(r.jobId); } catch (e) { setErr(e); setBusy(false); } };
  return { jobId, busy, err, start, finish: () => setBusy(false) };
}

export const Verification = ({ v }) => <Badge tone={statusTone(v)} title="Verification status is computed from evidence checks, not from AI confidence">{(v || '').replace(/_/g, ' ')}</Badge>;
