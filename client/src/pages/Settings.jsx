import React, { useEffect, useState } from 'react';
import { api } from '../api.js';
import { useCompany } from '../App.jsx';
import { PageHead, Err } from '../components/ui.jsx';

const DAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const zones = typeof Intl.supportedValuesOf === 'function' ? Intl.supportedValuesOf('timeZone') : ['Asia/Kolkata', 'UTC'];

export default function Settings() {
  const { company, reload } = useCompany();
  const [s, setS] = useState(company.settings); const [msg, setMsg] = useState(''); const [err, setErr] = useState(null);
  useEffect(() => setS(company.settings), [company._id]);
  const up = (grp, k, v) => setS({ ...s, [grp]: { ...s[grp], [k]: v } });
  const save = async (e) => { e.preventDefault(); setErr(null); try { await api.put(`/companies/${company._id}/settings`, s); await reload(); setMsg('Settings saved and schedules re-applied.'); } catch (x) { setErr(x); } };
  const F = ({ id, label, children }) => <div><label className="label" htmlFor={id}>{label}</label>{children}</div>;
  return (
    <form onSubmit={save} className="max-w-3xl">
      <PageHead title="Settings" sub="Scheduling runs on the server (node-cron) and defaults to Indian Standard Time. Changes re-apply immediately."><button className="btn">Save settings</button></PageHead>
      <Err e={err} />{msg && <div className="mb-3 text-sm text-gain">{msg}</div>}
      <section className="card mb-4 grid gap-3 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Weekly Monday brief</h2>
        <F id="tz" label="Schedule time zone (IST = Asia/Kolkata)"><select id="tz" className="input" value={s.timezone} onChange={(e) => setS({ ...s, timezone: e.target.value })}>{[...new Set(['Asia/Kolkata', s.timezone, ...zones])].map((z) => <option key={z}>{z}</option>)}</select></F>
        <F id="be" label="Enabled"><select id="be" className="input" value={String(s.brief.enabled)} onChange={(e) => up('brief', 'enabled', e.target.value === 'true')}><option value="true">On</option><option value="false">Off</option></select></F>
        <F id="bd" label="Briefing day"><select id="bd" className="input" value={s.brief.day} onChange={(e) => up('brief', 'day', +e.target.value)}>{DAYS.map((d, i) => <option key={d} value={i}>{d}</option>)}</select></F>
        <F id="bt" label="Briefing time"><input id="bt" type="time" className="input" value={s.brief.time} onChange={(e) => up('brief', 'time', e.target.value)} /></F>
        <F id="bl" label="Look-back window (days)"><input id="bl" type="number" min="1" max="60" className="input" value={s.brief.lookbackDays} onChange={(e) => up('brief', 'lookbackDays', +e.target.value)} /></F>
        <F id="em" label="Email brief to (needs SMTP in .env)"><input id="em" type="email" className="input" value={s.brief.emailTo} onChange={(e) => up('brief', 'emailTo', e.target.value)} /></F>
      </section>
      <section className="card mb-4 grid gap-3 sm:grid-cols-2">
        <h2 className="font-semibold sm:col-span-2">Monitoring</h2>
        <F id="me" label="Background monitoring"><select id="me" className="input" value={String(s.monitoring.enabled)} onChange={(e) => up('monitoring', 'enabled', e.target.value === 'true')}><option value="true">On</option><option value="false">Off</option></select></F>
        <F id="mf" label="Monitoring frequency"><select id="mf" className="input" value={s.monitoring.everyHours} onChange={(e) => up('monitoring', 'everyHours', +e.target.value)}>{[[6, 'Every 6 hours'], [12, 'Every 12 hours'], [24, 'Daily']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}</select></F>
        <F id="sr" label="Source refresh (minimum hours between checks of one source)"><input id="sr" type="number" min="1" max="168" className="input" value={s.monitoring.sourceRefreshHours} onChange={(e) => up('monitoring', 'sourceRefreshHours', +e.target.value)} /></F>
        <F id="aa" label="Auto-approve discovered sources scoring ≥ 45%"><select id="aa" className="input" value={String(s.autoApproveDiscovered)} onChange={(e) => setS({ ...s, autoApproveDiscovered: e.target.value === 'true' })}><option value="true">Yes</option><option value="false">No, I approve each</option></select></F>
      </section>
      <section className="card mb-4 grid gap-3 sm:grid-cols-3">
        <h2 className="font-semibold sm:col-span-3">Monthly Signal Stack audit</h2>
        <F id="ae" label="Enabled"><select id="ae" className="input" value={String(s.audit.enabled)} onChange={(e) => up('audit', 'enabled', e.target.value === 'true')}><option value="true">On</option><option value="false">Off</option></select></F>
        <F id="ad" label="Day of month (1-28)"><input id="ad" type="number" min="1" max="28" className="input" value={s.audit.dayOfMonth} onChange={(e) => up('audit', 'dayOfMonth', +e.target.value)} /></F>
        <F id="at" label="Time"><input id="at" type="time" className="input" value={s.audit.time} onChange={(e) => up('audit', 'time', e.target.value)} /></F>
      </section>
      <p className="text-xs text-ink-500">Company profile updates are made on the Company profile page; saving there flags the stack for reassessment.</p>
    </form>
  );
}
