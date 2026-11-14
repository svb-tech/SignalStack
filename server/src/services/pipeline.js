import { monitorCompany } from './monitor.js';
import { analyseNewItems } from './analysis.js';
import { generateBrief } from './brief.js';

/** Weekly intelligence brief: source checks → change/duplicate handling → analysis → ranking → brief. */
export async function weeklyPipeline(companyId, { trigger = 'scheduled', force = false, lookbackDays, log = () => {} } = {}) {
  const m = await monitorCompany(companyId, { force: force || trigger === 'manual', log });
  const a = await analyseNewItems(companyId, { log });
  const brief = await generateBrief(companyId, { trigger, lookbackDays, log });
  return { ...m, ...a, briefId: String(brief._id), warnings: [...(m.warnings || []), ...(a.warnings || [])] };
}

export async function monitoringPipeline(companyId, { log = () => {}, force = false } = {}) {
  const m = await monitorCompany(companyId, { log, force });
  const a = await analyseNewItems(companyId, { log });
  return { ...m, ...a, warnings: [...(m.warnings || []), ...(a.warnings || [])] };
}
