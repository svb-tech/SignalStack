import { JobRunM } from '../models/index.js';
import { istTime } from '../util.js';

const active = new Set();

export async function markStaleJobs() {
  await JobRunM.updateMany({ status: 'running' }, { status: 'failed', error: 'Interrupted (server restarted)', finishedAt: new Date() });
}

/** Runs fn in the background, persisting a JobRun (visible in the dashboard, failures included). */
export async function startJob(type, companyId, trigger, fn, { wait = false } = {}) {
  const lock = `${companyId}:${type}`;
  if (active.has(lock)) { const e = new Error(`A "${type}" job is already running for this company`); e.status = 409; throw e; }
  active.add(lock);
  const run = await JobRunM.create({ company: companyId, type, trigger });
  const log = (msg) => { JobRunM.updateOne({ _id: run._id }, { $push: { log: { $each: [`${istTime()} ${msg}`], $slice: -400 } } }).catch(() => {}); };
  const exec = (async () => {
    try {
      const stats = (await fn(log)) || {};
      const warn = stats.warnings?.length;
      await JobRunM.updateOne({ _id: run._id }, { status: warn ? 'partial' : 'success', finishedAt: new Date(), stats });
    } catch (e) {
      console.error(`[job ${type}]`, e);
      await JobRunM.updateOne({ _id: run._id }, { status: 'failed', finishedAt: new Date(), error: e.message });
    } finally { active.delete(lock); }
  })();
  if (wait) await exec;
  return run;
}
