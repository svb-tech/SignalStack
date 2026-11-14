// Monthly Signal Stack audit: dead URLs, duplicates, inactivity, declining relevance, new sources.
import { CompanyM, SourceM, RawItemM, SignalM, AuditReportM, CompetitorM } from '../models/index.js';
import { probe, planSources, validatePlan } from './stack.js';
import { normUrl, daysAgo, pLimit } from '../util.js';

export async function runAudit(companyId, log = () => {}) {
  const company = await CompanyM.findById(companyId);
  const sources = await SourceM.find({ company: companyId, status: { $in: ['approved', 'suggested', 'blocked', 'dead'] }, type: { $ne: 'upload' } });
  log(`Auditing ${sources.length} source(s)`);
  const findings = [], recs = [];
  const add = (type, s, detail) => findings.push({ type, sourceId: s._id, sourceName: s.name, url: s.url || s.query, detail });

  // 1) dead URLs: re-probe URL-based sources that failed recently, and re-check everything flagged failing
  const limit = pLimit(3);
  await Promise.all(sources.filter((s) => s.url && (s.health?.consecutiveFailures > 0 || s.status === 'dead' || s.status === 'blocked' || !s.health?.lastOkAt)).map((s) => limit(async () => {
    const pr = await probe({ type: s.type, url: s.url, query: s.query, meta: s.meta }, []);
    if (!pr.ok) {
      s.health.consecutiveFailures = (s.health.consecutiveFailures || 0) + 1; s.health.lastError = pr.error; s.markModified('health');
      if (s.health.consecutiveFailures >= 3 || /HTTP (404|410)/.test(pr.error || '')) {
        add('dead_url', s, pr.error); recs.push({ action: 'remove', sourceId: s._id, reason: `URL failing (${pr.error}); ${s.health.consecutiveFailures} consecutive failures` });
      } else add('failing', s, pr.error);
    } else { s.health.consecutiveFailures = 0; s.health.lastOkAt = new Date(); s.health.lastError = undefined; s.markModified('health'); }
    await s.save();
  })));

  // 2) duplicates: same normalized URL, or same domain+path, or heavy overlap in collected items
  const byUrl = new Map();
  for (const s of sources) { if (!s.url) continue; const k = normUrl(s.url); (byUrl.get(k) || byUrl.set(k, []).get(k)).push(s); }
  for (const [, arr] of byUrl) if (arr.length > 1) arr.slice(1).forEach((s) => { add('duplicate', s, `Same URL as "${arr[0].name}"`); recs.push({ action: 'remove', sourceId: s._id, reason: `Duplicate of "${arr[0].name}"` }); });
  const overlap = await RawItemM.aggregate([{ $match: { company: company._id, 'alsoSeenIn.0': { $exists: true } } }, { $unwind: '$alsoSeenIn' }, { $group: { _id: { a: '$source', b: '$alsoSeenIn.source' }, n: { $sum: 1 } } }, { $match: { n: { $gte: 5 } } }]);
  for (const o of overlap) {
    const b = sources.find((s) => String(s._id) === String(o._id.b));
    const a = sources.find((s) => String(s._id) === String(o._id.a));
    if (a && b) { add('overlap', b, `${o.n} items also found in "${a.name}"`); recs.push({ action: 'review', sourceId: b._id, reason: `${o.n} items duplicate "${a.name}"; consider removing the lower-scoring source` }); }
  }

  // 3) inactive + declining relevance
  const d60 = new Date(Date.now() - 60 * 864e5), d30 = new Date(Date.now() - 30 * 864e5);
  for (const s of sources.filter((x) => x.status === 'approved')) {
    const [items30, sig30, items60, sig60] = await Promise.all([
      RawItemM.countDocuments({ source: s._id, discoveredAt: { $gte: d30 }, kind: { $ne: 'baseline' } }), SignalM.countDocuments({ source: s._id, createdAt: { $gte: d30 } }),
      RawItemM.countDocuments({ source: s._id, discoveredAt: { $gte: d60, $lt: d30 }, kind: { $ne: 'baseline' } }), SignalM.countDocuments({ source: s._id, createdAt: { $gte: d60, $lt: d30 } }),
    ]);
    const cur = items30 ? sig30 / items30 : 0, prev = items60 ? sig60 / items60 : null;
    s.relevance = { current: cur, previous: s.relevance?.current ?? null, trend: prev == null ? 'new' : cur < prev * 0.5 ? 'down' : cur > prev * 1.5 ? 'up' : 'flat' };
    s.health.items30d = items30; s.health.signals30d = sig30; s.markModified('health');
    const age = daysAgo(s.createdAt);
    if (s.health?.lastOkAt && !items30 && daysAgo(s.health.lastNewContentAt || s.createdAt) > 60 && age > 60) { add('inactive', s, 'No new content in 60+ days'); recs.push({ action: 'remove', sourceId: s._id, reason: 'Inactive: nothing new collected in 60+ days' }); }
    else if (age > 45 && items30 >= 5 && sig30 === 0) { add('low_relevance', s, `${items30} items in 30 days, none significant`); recs.push({ action: 'remove', sourceId: s._id, reason: `Collected ${items30} items in 30 days but none were significant: declining relevance` }); }
    else if (s.relevance.trend === 'down') { add('declining', s, `Significant-item rate fell from ${Math.round(prev * 100)}% to ${Math.round(cur * 100)}%`); recs.push({ action: 'review', sourceId: s._id, reason: 'Relevance trend is declining' }); }
    await s.save();
  }

  // 4) newly discovered sources (profile + recent signal themes + entities)
  const competitors = await CompetitorM.find({ company: companyId });
  const recent = await SignalM.find({ company: companyId, createdAt: { $gte: d30 } }).sort({ score: -1 }).limit(12).select('headline competitor category');
  let newCands = [];
  try {
    const plan = await planSources(company, competitors, { focus: `Monthly audit. Recent significant themes: ${recent.map((r) => r.headline).join(' | ') || 'none'}. Propose only NEW sources not in this list: ${sources.slice(0, 50).map((s) => s.name).join('; ')}` });
    const res = await validatePlan(company, plan, log);
    newCands = res.saved;
    for (const s of newCands.filter((x) => x.status !== 'rejected')) { add('new_source', s, 'Newly discovered'); recs.push({ action: 'add', sourceId: s._id, reason: `New candidate: ${s.reason}` }); }
  } catch (e) { log('New-source discovery failed: ' + e.message); findings.push({ type: 'audit_warning', detail: 'New source discovery failed: ' + e.message }); }

  const stats = { sources: sources.length, dead: findings.filter((f) => f.type === 'dead_url').length, duplicates: findings.filter((f) => f.type === 'duplicate' || f.type === 'overlap').length, inactive: findings.filter((f) => f.type === 'inactive' || f.type === 'low_relevance').length, declining: findings.filter((f) => f.type === 'declining').length, newSources: findings.filter((f) => f.type === 'new_source').length };
  const summary = `Audited ${stats.sources} sources: ${stats.dead} dead, ${stats.duplicates} duplicate/overlapping, ${stats.inactive} inactive or low-value, ${stats.declining} with declining relevance. ${stats.newSources} new source(s) proposed. ${recs.length} recommendation(s) await review.`;
  const rep = await AuditReportM.create({ company: companyId, summary, stats, findings, recommendations: recs.filter((r, i, a) => a.findIndex((x) => String(x.sourceId) === String(r.sourceId) && x.action === r.action) === i) });
  log(summary);
  return { reportId: String(rep._id), ...stats };
}

export async function applyRecommendation(report, index) {
  const r = report.recommendations[index];
  if (!r || r.state !== 'pending') return;
  if (r.action === 'remove') await SourceM.updateOne({ _id: r.sourceId }, { status: 'removed', note: `Removed after audit: ${r.reason}` });
  if (r.action === 'add') await SourceM.updateOne({ _id: r.sourceId }, { status: 'approved' });
  r.state = 'applied';
}
