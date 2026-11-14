import { PROFILE_ARRAYS, PROFILE_STRINGS } from '../models/index.js';

export const compactProfile = (company) => {
  const p = company.profile || {};
  const lines = [`Company: ${company.name} (${company.url})`];
  if (company.research?.summary) lines.push(`Research summary: ${company.research.summary}`);
  for (const k of [...PROFILE_STRINGS, ...PROFILE_ARRAYS]) {
    const v = p[k];
    if (Array.isArray(v) ? v.length : v) lines.push(`${k}: ${Array.isArray(v) ? v.join('; ') : v}`);
  }
  return lines.join('\n');
};

export const PROFILE_SHAPE = `{ "oneLiner": string, "positioning": string, "industry": string, "geographies": string, "businessLines": string[], "revenueStreams": string[], "customerSegments": string[], "highValueSegments": string[], "customerProblems": string[], "unmetNeeds": string[], "whyCustomersChoose": string[], "competitorsNamed": string[], "marketChanges": string[], "materialRisks": string[], "growthPriorities": string[], "internalInfo": string[], "decisionsToSupport": string[], "keywords": string[] }`;

export function mergeProfile(base = {}, patch = {}) {
  const out = { ...base };
  for (const k of PROFILE_STRINGS) if (typeof patch[k] === 'string' && patch[k].trim()) out[k] = patch[k].trim();
  for (const k of PROFILE_ARRAYS) {
    if (!Array.isArray(patch[k]) || !patch[k].length) continue;
    const seen = new Set();
    out[k] = [...(out[k] || []), ...patch[k]].map((s) => String(s).trim()).filter((s) => s && !seen.has(s.toLowerCase()) && seen.add(s.toLowerCase()));
  }
  return out;
}
