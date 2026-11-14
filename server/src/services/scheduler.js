import cron from 'node-cron';
import { CompanyM, JobRunM, SourceM } from '../models/index.js';
import { startJob } from './jobs.js';
import { weeklyPipeline, monitoringPipeline } from './pipeline.js';
import { runAudit } from './audit.js';

const tasks = new Map(); // companyId -> [cron tasks]

const validTz = (tz) => { try { new Intl.DateTimeFormat('en', { timeZone: tz }); return true; } catch { return false; } };
const hm = (t, d = '08:00') => { const m = /^(\d{1,2}):(\d{2})$/.exec(t || d) || /^(\d{1,2}):(\d{2})$/.exec(d); return [Math.min(23, +m[1]), Math.min(59, +m[2])]; };

export function jobFns(companyId) {
  return {
    weekly: (trigger = 'scheduled') => startJob('weekly_brief', companyId, trigger, (log) => weeklyPipeline(companyId, { trigger: trigger === 'manual' ? 'manual' : 'scheduled', log })),
    monitoring: (trigger = 'scheduled') => startJob('monitoring', companyId, trigger, (log) => monitoringPipeline(companyId, { log })),
    audit: (trigger = 'scheduled') => startJob('monthly_audit', companyId, trigger, (log) => runAudit(companyId, log)),
  };
}

export async function schedule(companyOrId) {
  const c = typeof companyOrId === 'object' && companyOrId.settings ? companyOrId : await CompanyM.findById(companyOrId);
  if (!c) return;
  const id = String(c._id);
  (tasks.get(id) || []).forEach((t) => t.stop());
  tasks.delete(id);
  const s = c.settings, tz = validTz(s.timezone) ? s.timezone : 'Asia/Kolkata', fns = jobFns(c._id), list = [];
  const safe = (fn) => () => fn().catch((e) => console.warn(`[scheduler] ${c.name}: ${e.message}`));
  if (s.brief.enabled) { const [h, m] = hm(s.brief.time); list.push(cron.schedule(`${m} ${h} * * ${s.brief.day}`, safe(() => fns.weekly('scheduled')), { timezone: tz })); }
  if (s.monitoring.enabled) { const n = Math.max(1, Math.min(24, s.monitoring.everyHours)); list.push(cron.schedule(n >= 24 ? '0 5 * * *' : `0 */${n} * * *`, safe(() => fns.monitoring('scheduled')), { timezone: tz })); }
  if (s.audit.enabled) { const [h, m] = hm(s.audit.time, '07:00'); list.push(cron.schedule(`${m} ${h} ${Math.min(28, Math.max(1, s.audit.dayOfMonth))} * *`, safe(() => fns.audit('scheduled')), { timezone: tz })); }
  tasks.set(id, list);
}

export async function startScheduler() {
  const companies = await CompanyM.find({ status: 'stack_built' });
  for (const c of companies) await schedule(c);
  console.log(`[scheduler] ${companies.length} company schedule(s) active`);
  // Catch-up: run a missed weekly brief if none succeeded in the last 8 days (server was down at the scheduled time).
  for (const c of companies.filter((x) => x.settings.brief.enabled)) {
    const last = await JobRunM.findOne({ company: c._id, type: 'weekly_brief', status: { $in: ['success', 'partial'] } }).sort({ startedAt: -1 });
    const approved = await SourceM.countDocuments({ company: c._id, status: 'approved' });
    if (last && approved && Date.now() - last.startedAt.getTime() > 8 * 864e5) jobFns(c._id).weekly('catchup').catch(() => {});
  }
}

export const unschedule = (id) => { (tasks.get(String(id)) || []).forEach((t) => t.stop()); tasks.delete(String(id)); };
export const scheduleInfo = (id) => ({ active: (tasks.get(String(id)) || []).length });
