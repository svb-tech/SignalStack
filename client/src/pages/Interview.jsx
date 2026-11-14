import React, { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { api } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Err, Badge } from '../components/ui.jsx';

export default function Interview() {
  const { company, reload } = useCompany();
  const nav = useNavigate();
  const [ans, setAns] = useState(''); const [busy, setBusy] = useState(false); const [err, setErr] = useState(null); const [edit, setEdit] = useState(null);
  const qa = company.interview.qa;
  const open = qa.find((q) => !q.answer && !q.skipped);
  const mainDone = qa.filter((q) => q.followUpOf == null && (q.answer || q.skipped)).length;
  const run = async (fn) => { setErr(null); setBusy(true); try { await fn(); await reload(); } catch (e) { setErr(e); } setBusy(false); };
  const send = (skip) => run(async () => { await api.post(`/companies/${company._id}/interview/answer`, skip ? { skip: true } : { answer: ans }); setAns(''); });
  return (
    <div className="max-w-3xl">
      <PageHead title="Founder interview" sub="One question at a time, generated from this company's research and your earlier answers. Skip anything confidential." />
      <Err e={err} />
      <div className="mb-4 flex items-center gap-3 text-sm"><div className="h-2 flex-1 rounded bg-ink-100"><div className="h-2 rounded bg-signal" style={{ width: `${(mainDone / company.interview.maxQuestions) * 100}%` }} /></div><span className="text-ink-500">{mainDone}/{company.interview.maxQuestions} questions</span></div>
      {company.interview.status === 'not_started' && <div className="card"><p className="mb-3 text-sm">Ready to start? The first question is tailored to {company.name}.</p><button className="btn" disabled={busy} onClick={() => run(() => api.post(`/companies/${company._id}/interview/start`))}>{busy ? 'Preparing question…' : 'Start interview'}</button></div>}
      {open && (
        <div className="card mb-5 border-signal">
          <div className="mb-1 flex items-center gap-2 text-xs text-ink-500"><Badge tone="info">{open.followUpOf != null ? 'Follow-up' : `Question ${mainDone + 1}`}</Badge>{open.area}</div>
          <p className="mb-1 font-serif text-lg font-medium">{open.question}</p>
          <p className="mb-3 text-xs text-ink-500">Why we ask: {open.why}</p>
          <textarea className="input" rows={4} value={ans} onChange={(e) => setAns(e.target.value)} placeholder="Your answer…" aria-label="Your answer" />
          <div className="mt-3 flex gap-2"><button className="btn" disabled={busy || !ans.trim()} onClick={() => send(false)}>{busy ? 'Thinking…' : 'Submit answer'}</button><button className="btn-ghost" disabled={busy} onClick={() => send(true)}>Skip (confidential)</button></div>
        </div>
      )}
      {company.interview.status === 'complete' && (
        <div className="card mb-5 flex items-center justify-between border-gain"><div className="text-sm"><b>Interview complete.</b> Your profile is updated. {company.status !== 'stack_built' ? 'Next: build the Signal Stack.' : ''}</div><button className="btn" onClick={() => nav(company.status === 'stack_built' ? '/profile' : '/stack')}>{company.status === 'stack_built' ? 'View profile' : 'Build Signal Stack'}</button></div>
      )}
      <h2 className="mb-2 text-sm font-semibold text-ink-700">Answers so far</h2>
      <ul className="space-y-2">
        {qa.filter((q) => q.answer || q.skipped).map((q) => (
          <li key={q._id} className={`card ${q.followUpOf != null ? 'ml-6' : ''}`}>
            <div className="text-xs text-ink-500">{q.followUpOf != null ? 'Follow-up' : `Q${q.n}`} · {q.area}</div>
            <div className="text-sm font-medium">{q.question}</div>
            {edit?.id === q._id ? (
              <div className="mt-2"><textarea className="input" rows={3} value={edit.text} onChange={(e) => setEdit({ ...edit, text: e.target.value })} aria-label="Edit answer" />
                <div className="mt-2 flex gap-2"><button className="btn" disabled={busy} onClick={() => run(async () => { await api.put(`/companies/${company._id}/interview/qa/${q._id}`, { answer: edit.text }); setEdit(null); })}>Save & rebuild profile</button><button className="btn-ghost" onClick={() => setEdit(null)}>Cancel</button></div></div>
            ) : (
              <div className="mt-1 flex items-start justify-between gap-3"><p className="text-sm text-ink-700">{q.skipped ? <i>Skipped (confidential)</i> : q.answer}</p><button className="btn-ghost shrink-0" onClick={() => setEdit({ id: q._id, text: q.answer })}>Edit</button></div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
