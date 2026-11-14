import { SourceM, RawItemM, CrawlLogM, CompanyM } from '../models/index.js';
import { collect, enrichItem } from './collectors.js';
import { sha1, normUrl, titleKey, domainOf, pLimit, daysAgo, normText } from '../util.js';
import { cfg } from '../config.js';

/** Crawl one source: collect, de-duplicate, store raw records, update health + history. */
export async function checkSource(source, company, { log = () => {} } = {}) {
  const started = Date.now();
  const h = source.health || {};
  let items = [], status = null, error = null, note = null, newItems = 0, dups = 0, ok = false;
  try {
    const res = await collect(source);
    items = res.items || []; status = res.status; note = res.note; ok = true;
    const firstRun = !h.lastOkAt;
    let enriched = 0;
    for (const it of items) {
      if (!it.url || !it.title) continue;
      if (['rss', 'web_search'].includes(source.type) && (it.content || '').length < 400 && enriched < cfg.crawl.maxArticleFetch) { enriched++; await enrichItem(it); }
      const canonical = normUrl(it.url);
      const tk = titleKey(it.title);
      const hash = sha1(tk + '|' + normText(it.content).slice(0, 1500));
      const or = [{ canonicalUrl: canonical }, { contentHash: hash }];
      if (tk.length > 25) or.push({ titleKey: tk });
      const dup = it.kind === 'baseline' || it.kind === 'page_change' ? null : await RawItemM.findOne({ company: company._id, $or: or }).select('_id source alsoSeenIn');
      if (dup) {
        dups++;
        if (String(dup.source) !== String(source._id) && !dup.alsoSeenIn.some((a) => String(a.source) === String(source._id))) {
          await RawItemM.updateOne({ _id: dup._id }, { $push: { alsoSeenIn: { source: source._id, url: it.url, domain: domainOf(it.url), at: new Date() } } });
        }
        continue;
      }
      const old = it.publishedAt && daysAgo(it.publishedAt) > cfg.crawl.lookbackDays;
      await RawItemM.create({
        company: company._id, source: source._id, category: source.category, competitor: source.competitor || undefined,
        url: it.url, canonicalUrl: canonical, title: it.title, content: it.content, publishedAt: it.publishedAt || undefined,
        contentHash: hash, titleKey: tk, headlineOnly: !!it.headlineOnly, kind: it.kind || 'article',
        status: it.kind === 'baseline' || old ? 'ignored' : 'new',
        analysisNote: it.kind === 'baseline' ? 'Baseline snapshot stored for future change detection' : old ? `Older than ${cfg.crawl.lookbackDays}-day lookback (kept as history)` : undefined,
      });
      newItems++;
    }
    source.health.lastOkAt = new Date();
    source.health.consecutiveFailures = 0;
    source.health.lastError = note && /cosmetic/.test(note) ? undefined : undefined;
    if (newItems) source.health.lastNewContentAt = new Date();
    if (source.status === 'blocked') source.status = 'approved';
  } catch (e) {
    error = e.message;
    if (e.code === 'ROBOTS') { source.status = 'blocked'; }
    else if (e.code !== 'NO_CREDS') source.health.consecutiveFailures = (h.consecutiveFailures || 0) + 1;
    source.health.lastError = error;
    status = e.status || null;
    log(`✗ ${source.name}: ${error}`);
  }
  source.health.lastCheckedAt = new Date();
  source.health.lastStatus = status;
  source.health.totalChecks = (h.totalChecks || 0) + 1;
  source.markModified('health');
  await source.save();
  await CrawlLogM.create({ company: company._id, source: source._id, sourceName: source.name, startedAt: new Date(started), durationMs: Date.now() - started, ok, httpStatus: status, itemsFound: items.length, newItems, duplicates: dups, error, note });
  if (ok) log(`✓ ${source.name}: ${items.length} found, ${newItems} new, ${dups} duplicate`);
  return { ok, newItems, dups };
}

export async function monitorCompany(companyId, { force = false, log = () => {}, sourceIds } = {}) {
  const company = await CompanyM.findById(companyId);
  const refreshMs = (company.settings.monitoring.sourceRefreshHours || 20) * 3600e3;
  const q = { company: companyId, status: { $in: ['approved', 'blocked'] }, type: { $ne: 'upload' } };
  if (sourceIds) q._id = { $in: sourceIds };
  let sources = await SourceM.find(q);
  sources = sources.filter((s) => force || !s.health?.lastCheckedAt || Date.now() - s.health.lastCheckedAt.getTime() >= refreshMs);
  log(`Monitoring ${sources.length} source(s)${force ? ' (forced)' : ''}`);
  const limit = pLimit(4);
  const warnings = [];
  const res = await Promise.all(sources.map((s) => limit(async () => {
    const r = await checkSource(s, company, { log });
    if (!r.ok) warnings.push(`${s.name}: ${s.health.lastError}`);
    return r;
  })));
  const stats = { sourcesChecked: sources.length, ok: res.filter((r) => r.ok).length, newItems: res.reduce((a, r) => a + r.newItems, 0), duplicates: res.reduce((a, r) => a + r.dups, 0), warnings: warnings.slice(0, 20) };
  log(`Monitoring done: ${stats.newItems} new records, ${stats.duplicates} duplicates, ${warnings.length} failing source(s)`);
  return stats;
}
