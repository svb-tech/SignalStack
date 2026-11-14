// Source discovery: competitors, customer/market sources, validation, scoring, reassessment.
import { z } from 'zod';
import { CompanyM, SourceM, CompetitorM, StackChangeM } from '../models/index.js';
import { llmJSON } from '../llm.js';
import { politeFetch, parseHtml, looksLikeFeed, parseFeed } from './crawler.js';
import { webSearch } from './search.js';
import { collect } from './collectors.js';
import { compactProfile } from './prompts.js';
import { domainReliability, keywordOverlap, recencyScore } from './ranking.js';
import { domainOf, normUrl, ensureUrl, clamp, pLimit, truncate, containsQuote, daysAgo } from '../util.js';

export const sourceKey = (s) => `${s.type}|${s.url ? normUrl(s.url) : String(s.query || '').toLowerCase()}${s.meta?.subreddit ? '|r/' + s.meta.subreddit : ''}${s.meta?.site ? '|' + s.meta.site : ''}`;

// ---------------------------------------------------------------- probing + scoring
const newest = (items) => items.map((i) => i.publishedAt).filter(Boolean).sort((a, b) => b - a)[0] || null;
const feedInfo = (items) => ({ items: items.length, sampleTitles: items.slice(0, 4).map((i) => i.title), sampleText: items.slice(0, 15).map((i) => i.title + ' ' + i.content).join(' '), latestAt: newest(items) });

export async function probe(cand, keywords) {
  const out = { ok: false, error: null, items: 0, sampleTitles: [], sampleText: '', latestAt: null, type: cand.type, url: cand.url };
  try {
    if (['webpage', 'listing', 'rss'].includes(cand.type)) {
      const r = await politeFetch(cand.url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      out.url = r.url;
      if (looksLikeFeed(r)) {
        const it = parseFeed(r.body);
        Object.assign(out, { ok: it.length > 0, type: 'rss', ...feedInfo(it) });
        if (!it.length) out.error = 'Feed is empty';
        return out;
      }
      const p = parseHtml(r.body, r.url);
      if (cand.type === 'listing' && p.feeds.length) { // prefer a real feed over scraping a listing
        try {
          const f = await politeFetch(p.feeds[0]);
          if (f.ok && looksLikeFeed(f)) {
            const it = parseFeed(f.body);
            if (it.length) return { ok: true, error: null, type: 'rss', url: p.feeds[0], ...feedInfo(it) };
          }
        } catch { /* fall back to listing */ }
      }
      out.ok = p.text.length > 150;
      out.items = cand.type === 'listing' ? p.links.length : 1;
      out.sampleTitles = [p.title].filter(Boolean);
      out.sampleText = p.text.slice(0, 5000);
      out.latestAt = p.publishedAt;
      if (!out.ok) out.error = 'Page has little readable text (may be JavaScript-rendered)';
      return out;
    }
    const res = await collect({ ...cand, health: {}, seenLinks: [] });
    out.items = res.items.length;
    out.ok = out.items > 0;
    out.sampleTitles = res.items.slice(0, 4).map((i) => i.title);
    out.sampleText = res.items.map((i) => i.title + ' ' + (i.content || '')).join(' ').slice(0, 6000);
    out.latestAt = newest(res.items);
    if (!out.ok) out.error = 'Query returned no results';
  } catch (e) { out.error = e.code === 'ROBOTS' ? 'Blocked by robots.txt' : e.code === 'NO_CREDS' ? 'Needs credentials' : e.message; out.robots = e.code === 'ROBOTS'; }
  return out;
}

function scoreCandidate(cand, pr, keywords, companyDomain) {
  const specific = clamp(0.25 + 0.75 * keywordOverlap(pr.sampleText + ' ' + (cand.query || '') + ' ' + (cand.name || ''), keywords));
  const isPage = ['webpage', 'listing'].includes(pr.type) && !pr.latestAt;
  const recent = isPage ? (pr.ok ? 0.6 : 0) : recencyScore(pr.latestAt, 45);
  const credible = domainReliability(pr.url || cand.url || (cand.type === 'google_news' ? 'https://news.google.com' : ''), cand.type, companyDomain);
  const overall = clamp(0.4 * specific + 0.3 * recent + 0.3 * credible);
  return { specific, recent, credible, overall, notes: `Probe: ${pr.items} item(s)${pr.latestAt ? `, newest ${Math.round(daysAgo(pr.latestAt))}d ago` : ', date n/a'}; ${Math.round(specific * 100)}% keyword match to company problem-space; domain reliability ${Math.round(credible * 100)}%.` };
}

function sourceDoc(companyId, cand, pr, sc) {
  const doc = {
    company: companyId, category: cand.category, type: pr.type || cand.type, name: cand.name, url: pr.url || cand.url, query: cand.query, meta: cand.meta || {},
    competitor: cand.competitor, topic: cand.topic, reason: cand.reason, scoreNotes: sc.notes,
    scores: { specific: sc.specific, recent: sc.recent, credible: sc.credible, overall: sc.overall },
    relevance: { current: sc.overall, previous: null, trend: 'new' },
  };
  doc.key = sourceKey(doc);
  return doc;
}

async function saveCandidate(company, cand, pr, sc, { origin = 'discovered', autoApprove = true } = {}) {
  const doc = { ...sourceDoc(company._id, cand, pr, sc), origin };
  const exists = await SourceM.findOne({ company: company._id, key: doc.key });
  if (exists) return { dup: true, source: exists };
  doc.status = !pr.ok ? 'rejected' : autoApprove && sc.overall >= 0.45 ? 'approved' : 'suggested';
  if (!pr.ok) doc.note = `Rejected at validation: ${pr.error}`;
  return { dup: false, source: await SourceM.create(doc) };
}

// ---------------------------------------------------------------- competitors
const CompS = z.object({ competitors: z.array(z.object({ name: z.string(), url: z.string(), kind: z.string().default('direct'), why: z.string().default(''), basis: z.string().default('model_knowledge') })).default([]) });
const CompProfS = z.object({ profiles: z.array(z.object({
  name: z.string(), positioning: z.string().default(''), products: z.array(z.string()).default([]), pricingNotes: z.string().default(''), targetCustomers: z.string().default(''),
  facts: z.array(z.object({ claim: z.string(), sourceUrl: z.string().default(''), evidenceSnippet: z.string() })).default([]), assumptions: z.array(z.string()).default([]),
})).default([]) });

const findLink = (links, rx, host) => links.find((l) => { try { return new URL(l.href).host.replace(/^www\./, '') === host && rx.test(new URL(l.href).pathname + ' ' + l.text); } catch { return false; } });

async function discoverCompetitors(company, log = () => {}) {
  const p = company.profile || {};
  const queries = [`${company.name} competitors alternatives`, `alternatives to ${company.name}`, `${(p.keywords || []).slice(0, 3).join(' ')} platforms providers`];
  const found = [];
  for (const q of queries) (await webSearch(q, { max: 6, log })).forEach((r) => found.push(`- ${r.title} | ${r.url} | ${truncate(r.snippet, 200)}`));
  const named = (p.competitorsNamed || []).join(', ');
  const out = await llmJSON({
    prompt: `Identify 6-10 competitors or substitutes for the company below, relevant to its REAL problem space (direct competitors AND substitutes customers use instead, e.g. manual processes, adjacent platforms, aggregators).
${compactProfile(company)}
Founder-named competitors (include these): ${named || 'none'}
Web search results for grounding:\n${found.join('\n') || '(search unavailable)'}
Rules: give the official homepage URL (https://...) for each; "kind" is "direct" or "substitute"; "why" explains in one sentence why they compete for the same customer/budget; "basis" is "search_result" if it appears above, "founder" if named by the founder, else "model_knowledge" (will be verified). Do not include ${company.name} itself.
Return JSON { "competitors": [{ "name", "url", "kind", "why", "basis" }] }`,
    schema: CompS,
  });
  const limit = pLimit(3);
  const checked = await Promise.all(out.competitors.slice(0, 12).map((c) => limit(async () => {
    try {
      const url = ensureUrl(c.url);
      if (domainOf(url) === domainOf(company.url)) return null;
      const r = await politeFetch(url);
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const page = parseHtml(r.body, r.url);
      return { ...c, url: r.url, domain: domainOf(r.url), page, verified: true };
    } catch (e) { log(`Competitor "${c.name}" dropped (${e.code === 'ROBOTS' ? 'robots.txt' : e.message})`); return null; }
  })));
  const good = checked.filter(Boolean).filter((c, i, a) => a.findIndex((x) => x.domain === c.domain) === i).slice(0, 10);
  if (!good.length) return [];
  log(`${good.length} competitors verified reachable; profiling`);
  const prof = await llmJSON({
    prompt: `Profile each competitor using ONLY its homepage text below. facts need a verbatim evidenceSnippet (12-200 chars) copied from the text; anything else is an assumption.
${good.map((c) => `### ${c.name} (${c.url})\n${truncate(c.page.text, 2200)}`).join('\n\n')}
Return JSON { "profiles": [{ "name", "positioning", "products": string[], "pricingNotes": string, "targetCustomers": string, "facts": [{ "claim", "sourceUrl", "evidenceSnippet" }], "assumptions": string[] }] }`,
    schema: CompProfS,
  });
  await CompetitorM.deleteMany({ company: company._id });
  const docs = [];
  for (const c of good) {
    const pf = prof.profiles.find((x) => x.name.toLowerCase() === c.name.toLowerCase()) || {};
    const facts = (pf.facts || []).filter((f) => containsQuote(c.page.text, f.evidenceSnippet)).map((f) => ({ ...f, sourceUrl: c.url }));
    docs.push(await CompetitorM.create({
      company: company._id, name: c.name, url: c.url, domain: c.domain, kind: c.kind, why: c.why, basis: c.basis, verified: true,
      positioning: pf.positioning, products: pf.products, pricingNotes: pf.pricingNotes, targetCustomers: pf.targetCustomers, facts,
      assumptions: [...(pf.assumptions || []), ...(pf.facts || []).filter((f) => !facts.some((x) => x.claim === f.claim)).map((f) => `${f.claim} (unverified)`)],
      pages: { feeds: c.page.feeds.slice(0, 2), blog: findLink(c.page.links, /blog|news|press|updates|insights|resources/i, c.domain)?.href, pricing: findLink(c.page.links, /pricing|plans/i, c.domain)?.href, careers: findLink(c.page.links, /careers|jobs|hiring|join-us/i, c.domain)?.href },
    }));
  }
  return docs;
}

function competitorCandidates(comp) {
  const mk = (extra) => ({ category: 'competitors', competitor: comp.name, ...extra });
  const c = [];
  const pg = comp.pages || {};
  if (pg.feeds?.[0]) c.push(mk({ type: 'rss', name: `${comp.name} blog/news feed`, url: pg.feeds[0], reason: `Official feed from ${comp.name} (${comp.kind} competitor): product launches, positioning and announcements straight from the source.` }));
  else if (pg.blog) c.push(mk({ type: 'listing', name: `${comp.name} blog/news`, url: pg.blog, reason: `Official announcements and content strategy of ${comp.name}; new posts reveal launches and positioning shifts.` }));
  if (pg.pricing) c.push(mk({ type: 'webpage', name: `${comp.name} pricing page`, url: pg.pricing, reason: `Change detection on ${comp.name}'s pricing/plans: price moves directly affect how customers compare us.` }));
  if (pg.careers) c.push(mk({ type: 'webpage', name: `${comp.name} careers page`, url: pg.careers, reason: `Hiring is a leading indicator of ${comp.name}'s expansion, new geographies and technology bets.` }));
  c.push(mk({ type: 'google_news', name: `News: ${comp.name}`, query: `"${comp.name}" (launch OR pricing OR partnership OR funding OR acquisition OR expansion)`, reason: `Third-party coverage of ${comp.name}: launches, partnerships, funding, expansion — ${comp.why || 'competes for our customers'}.` }));
  c.push(mk({ type: 'web_search', name: `Reviews & complaints: ${comp.name}`, query: `"${comp.name}" reviews complaints problems`, reason: `Customer reviews of ${comp.name} expose its weaknesses (our opportunities) and its strengths (our threats).` }));
  return c;
}

// ---------------------------------------------------------------- source plan
const CUSTOMER_TYPES = ['hn', 'stackexchange', 'reddit', 'web_search', 'google_news'];
const MARKET_TYPES = ['google_news', 'rss', 'webpage', 'listing'];

const PlanS = z.object({
  customerSources: z.array(z.object({
    type: z.string().catch('web_search'),
    query: z.string().optional().catch(''),
    subreddit: z.string().optional(),
    site: z.string().optional(),
    name: z.string().optional().catch(''),
    reason: z.string().optional().catch(''),
  })).default([]),
  marketSources: z.array(z.object({
    type: z.string().catch('google_news'),
    name: z.string().optional().catch(''),
    url: z.string().optional(),
    query: z.string().optional().catch(''),
    topic: z.string().optional().catch('industry'),
    reason: z.string().optional().catch(''),
  })).default([]),
});

const safeUrl = (u) => { try { return u ? ensureUrl(u) : undefined; } catch { return undefined; } };
const customerType = (t) => (CUSTOMER_TYPES.includes(t) ? t : 'web_search');
const marketType = (s) => (MARKET_TYPES.includes(s.type) ? s.type : s.url ? 'webpage' : 'google_news');
const hasTarget = (s) => (s.type === 'google_news' ? Boolean(s.query) : Boolean(s.url)); // news needs a query, pages need a URL

// Generic queries from the company's own profile, used only when the model gives nothing usable.
function fallbackQueries(company) {
  const p = company.profile || {};
  const topics = [...(p.keywords || []), ...(p.customerProblems || [])].slice(0, 8);
  const seed = topics.length ? topics : [company.name];
  return {
    customers: [`${company.name} reviews complaints`, ...seed.map((t) => `${t} problems complaints experiences`)].slice(0, 8),
    market: seed.map((t) => `"${t}" industry trends regulation news`),
  };
}

export async function planSources(company, competitors, { focus = '' } = {}) {
  const profile = company.profile || {};
  const context = [company.name, ...(profile.customerProblems || []), ...(profile.keywords || [])].filter(Boolean).join(' ');
  const fallback = fallbackQueries(company);

  const result = await llmJSON({
    prompt: `Design monitoring sources for this company's intelligence Signal Stack.

${compactProfile(company)}

Competitors:
${competitors.map((c) => c.name).join(', ') || 'unknown'}

Business context:
${context}

${focus ? `FOCUS / WHAT CHANGED: ${focus}` : ''}

A) customerSources: Generate 8-12 sources where customers discuss their real problems.

Rules:
- Queries must describe customer problems, not just the company name.
- Use types: hn, stackexchange, reddit, web_search, google_news.
- Every source MUST have a meaningful non-empty query.
- For reddit, provide subreddit without r/.
- For stackexchange, provide site.
- Include name and a specific reason.

B) marketSources: Generate 8-14 sources about regulatory, policy, industry, economic, technology and country-level changes.

Rules:
- Use types: google_news, rss, webpage, listing.
- google_news sources MUST have a meaningful query.
- rss/webpage/listing sources MUST have a valid official URL.
- Use topics: regulatory, industry, economic, technology, country.
- Include name and a company-specific reason.

Do not return empty queries.
Do not invent official URLs.
Return valid JSON matching this structure:
{
  "customerSources": [
    {
      "type": "web_search",
      "query": "customer problem search query",
      "name": "Source name",
      "subreddit": "",
      "site": "",
      "reason": "Why this source matters"
    }
  ],
  "marketSources": [
    {
      "type": "google_news",
      "name": "Source name",
      "query": "specific market search query",
      "topic": "industry",
      "reason": "Why this source matters"
    }
  ]
}`,
    schema: PlanS,
    temperature: 0.3,
  });

  const customerSources = result.customerSources.map((s, i) => {
    const query = (s.query || s.name || fallback.customers[i % fallback.customers.length]).trim();
    return { ...s, type: customerType(s.type), query, name: s.name || `Customer discussion: ${query}`, reason: s.reason || 'Monitors customer problems and unmet needs relevant to the business.' };
  });

  const marketSources = result.marketSources.map((s, i) => {
    const type = marketType(s);
    const query = (s.query || s.name || fallback.market[i % fallback.market.length]).trim();
    return { ...s, type, url: safeUrl(s.url), query: type === 'google_news' ? query : undefined, name: s.name || `Market intelligence: ${query}`, topic: s.topic || 'industry', reason: s.reason || 'Monitors market developments that may affect the company.' };
  }).filter(hasTarget);

  if (!customerSources.length) {
    fallback.customers.forEach((query, i) => customerSources.push({ type: 'web_search', query, name: `Customer problems ${i + 1}`, reason: 'Monitors customer pain points and unmet needs.' }));
  }
  if (!marketSources.length) {
    fallback.market.forEach((query, i) => marketSources.push({ type: 'google_news', query, name: `Market developments ${i + 1}`, topic: 'industry', reason: 'Monitors regulatory and industry developments affecting the business.' }));
  }
  return { customerSources, marketSources };
}

function planCandidates(plan) {
  const customers = (plan.customerSources || []).filter((s) => s.query?.trim()).map((s) => ({
    category: 'customers',
    type: customerType(s.type),
    query: s.query.trim(),
    name: s.name || `${s.type}: ${truncate(s.query, 50)}`,
    meta: { subreddit: s.subreddit, site: s.site },
    reason: s.reason,
  }));

  const market = (plan.marketSources || []).map((s) => {
    const type = marketType(s);
    const url = safeUrl(s.url);
    const query = type === 'google_news' ? (s.query || s.name || '').trim() : undefined;
    return { category: 'market', type, url, query, name: s.name || `Market source: ${query || url || 'unknown'}`, topic: s.topic || 'industry', reason: s.reason };
  }).filter(hasTarget);

  return [...customers, ...market];
}

async function validateAndSave(company, cands, log, { origin = 'discovered', autoApprove } = {}) {
  const keywords = [...(company.profile?.keywords || []), ...(company.profile?.customerProblems || []), ...(company.profile?.competitorsNamed || [])];
  const limit = pLimit(3);
  const res = { approved: 0, suggested: 0, rejected: 0, dup: 0, saved: [] };
  await Promise.all(cands.map((c) => limit(async () => {
    const pr = await probe(c, keywords);
    const sc = scoreCandidate(c, pr, keywords, domainOf(company.url));
    const { dup, source } = await saveCandidate(company, c, pr, sc, { origin, autoApprove: autoApprove ?? company.settings.autoApproveDiscovered });
    if (dup) { res.dup++; return; }
    res[source.status === 'approved' ? 'approved' : source.status === 'suggested' ? 'suggested' : 'rejected']++;
    res.saved.push(source);
    log(`${source.status === 'rejected' ? '✗' : '✓'} [${c.category}] ${c.name} → ${source.status}${pr.error ? ' (' + pr.error + ')' : ''}`);
  })));
  return res;
}

export async function buildSignalStack(companyId, log = () => {}) {
  const company = await CompanyM.findById(companyId);
  if (!Object.keys(company.profile || {}).length) throw new Error('Company profile is empty; run research/interview first');
  log('Discovering competitors…');
  const competitors = await discoverCompetitors(company, log);
  log(`Competitors: ${competitors.map((c) => c.name).join(', ') || 'none verified'}`);
  log('Planning customer & market sources…');
  const plan = await planSources(company, competitors);
  const cands = [...competitors.flatMap(competitorCandidates), ...planCandidates(plan)];
  log(`Validating ${cands.length} candidate sources (robots.txt, reachability, relevance, recency)…`);
  const res = await validateAndSave(company, cands, log);
  company.status = 'stack_built';
  await company.save();
  const warnings = [];
  if (competitors.length < 5) warnings.push(`Only ${competitors.length} competitors could be verified (target 5-10)`);
  if (res.approved < 20) warnings.push(`Only ${res.approved} sources approved automatically; review "suggested" sources in Source Manager`);
  return { competitors: competitors.length, candidates: cands.length, ...res, saved: undefined, warnings };
}

// ---------------------------------------------------------------- reassess when business context changes
const ReS = z.object({
  summary: z.string().default(''),
  sources: z.array(z.object({ id: z.string(), verdict: z.enum(['keep', 'deprecate']), reason: z.string().default(''), relevance: z.number().min(0).max(1).default(0.5) })).default([]),
});

export async function reassessStack(companyId, { previousProfile, log = () => {} } = {}) {
  const company = await CompanyM.findById(companyId);
  const sources = await SourceM.find({ company: companyId, status: { $in: ['approved', 'suggested'] }, type: { $ne: 'upload' } });
  log(`Re-scoring ${sources.length} source(s) against the updated business context`);
  const list = sources.map((s) => `${s._id} | ${s.category} | ${s.type} | ${s.name} | ${s.query || s.url} | reason: ${truncate(s.reason, 140)}`).join('\n');
  const prev = previousProfile ? Object.entries(previousProfile).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join('; ') : v}`).join('\n') : '(not stored)';
  const out = await llmJSON({
    prompt: `The company's business context changed. Decide which monitoring sources are still useful.
PREVIOUS PROFILE:\n${truncate(prev, 3500)}\n\nNEW PROFILE:\n${compactProfile(company)}\n
SOURCES (id | category | type | name | query/url | reason):\n${list}\n
For EVERY source id return verdict "keep" or "deprecate" (deprecate only if it no longer serves the new priorities), a relevance 0..1 for the NEW context, and a reason that names the specific change. Also write "summary": 2-4 sentences explaining what changed in the business and how the stack should shift.
Return JSON { "summary": string, "sources": [{ "id", "verdict", "reason", "relevance" }] }`,
    schema: ReS,
  });
  const changes = [];
  for (const v of out.sources) {
    const s = sources.find((x) => String(x._id) === v.id);
    if (!s) continue;
    s.relevance = { current: v.relevance, previous: s.relevance?.current ?? null, trend: v.relevance > (s.relevance?.current ?? 0.5) + 0.1 ? 'up' : v.relevance < (s.relevance?.current ?? 0.5) - 0.1 ? 'down' : 'flat' };
    if (v.verdict === 'deprecate') { s.status = 'deprecated'; s.note = `Deprecated after business change: ${v.reason}`; changes.push({ type: 'deprecated', sourceId: s._id, name: s.name, category: s.category, reason: v.reason }); }
    await s.save();
  }
  log(`${changes.length} source(s) deprecated`);
  const competitors = await CompetitorM.find({ company: companyId });
  const plan = await planSources(company, competitors, { focus: `Business context changed. ${out.summary} Propose NEW sources that serve the new priorities; avoid duplicating existing ones: ${sources.slice(0, 40).map((s) => s.name).join('; ')}` });
  const res = await validateAndSave(company, planCandidates(plan), log, { origin: 'reassess' });
  for (const s of res.saved) changes.push({ type: s.status === 'rejected' ? 'rejected_candidate' : 'added', sourceId: s._id, name: s.name, category: s.category, reason: s.reason });
  company.profileDirty = false;
  await company.save();
  const rec = await StackChangeM.create({ company: companyId, trigger: 'profile_change', summary: out.summary, changes: changes.filter((c) => c.type !== 'rejected_candidate') });
  return { deprecated: changes.filter((c) => c.type === 'deprecated').length, added: changes.filter((c) => c.type === 'added').length, changeId: String(rec._id) };
}

/** Add a user-provided source: validates, auto-detects feeds, stores as approved. */
export async function addManualSource(companyId, { category, type, url, query, name, reason, meta }) {
  const company = await CompanyM.findById(companyId);
  const cand = { category, type: type || (url ? 'webpage' : 'google_news'), url: url ? ensureUrl(url) : undefined, query, name: name || url || query, reason: reason || 'Added manually by the founder', meta: meta || {} };
  const keywords = [...(company.profile?.keywords || [])];
  const pr = await probe(cand, keywords);
  const sc = scoreCandidate(cand, pr, keywords, domainOf(company.url));
  const doc = { ...sourceDoc(companyId, cand, pr, sc), status: 'approved', origin: 'manual' };
  if (pr.error) doc.scoreNotes += ` Validation warning: ${pr.error}`;
  if (await SourceM.findOne({ company: companyId, key: doc.key })) throw Object.assign(new Error('This source already exists'), { status: 409 });
  return SourceM.create(doc);
}

export async function validatePlan(company, plan, log = () => {}) {
  return validateAndSave(company, planCandidates(plan), log, { origin: 'audit', autoApprove: false });
}
