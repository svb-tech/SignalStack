import { z } from 'zod';
import { CompanyM } from '../models/index.js';
import { politeFetch, parseHtml } from './crawler.js';
import { webSearch, googleNews, tavilyExtract } from './search.js';
import { llmJSON } from '../llm.js';
import { containsQuote, truncate, normUrl, domainOf } from '../util.js';
import { mergeProfile } from './prompts.js';

const S = z.object({
  oneLiner: z.string().default(''), industry: z.string().default(''), positioning: z.string().default(''),
  products: z.array(z.string()).default([]), customerSegments: z.array(z.string()).default([]), geographies: z.array(z.string()).default([]),
  facts: z.array(z.object({ claim: z.string(), sourceUrl: z.string(), evidenceSnippet: z.string() })).default([]),
  assumptions: z.array(z.object({ claim: z.string(), rationale: z.string().default('') })).default([]),
  unknowns: z.array(z.string()).default([]), keywords: z.array(z.string()).default([]),
});

const LINK_RX = /(about|product|solution|service|pricing|plans|customer|student|university|universities|partner|blog|news|press|how-it-works|features)/i;


const pickLinks = (links, baseUrl) => {
  const base = new URL(baseUrl); const picks = [];
  for (const l of links) {
    try {
      const u = new URL(l.href);
      if (u.host.replace(/^www\./, '') !== base.host.replace(/^www\./, '') || normUrl(l.href) === normUrl(baseUrl)) continue;
      if (LINK_RX.test(u.pathname + ' ' + (l.text || '')) && !picks.some((p) => normUrl(p) === normUrl(l.href))) picks.push(l.href);
    } catch { /* ignore */ }
  }
  return picks;
};

/** Public sitemap URLs (listed by the site itself). Fetched politely; may be blocked too, which is fine. */
async function sitemapLinks(origin) {
  try {
    const r = await politeFetch(origin + '/sitemap.xml');
    if (!r.ok) return [];
    return [...r.body.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/g)].map((m) => ({ href: m[1], text: '' })).filter((l) => !/\.xml(\.gz)?$/i.test(l.href));
  } catch { return []; }
}

/**
 * Website reading with a fallback ladder. We never spoof a browser or evade bot protection:
 *   1. direct polite fetch (robots.txt respected)
 *   2. on 403/429/5xx/timeout only -> sitemap + Tavily (domain-restricted search w/ raw content, then Extract)
 *   robots.txt disallow is final: no fallback route is used for it.
 * Each page records HOW it was obtained (`via`) so evidence provenance stays visible.
 */
async function readWebsite(c, limitations, log) {
  const pages = [];
  let home;
  try {
    home = await politeFetch(c.url);
    if (!home.ok) throw Object.assign(new Error(`HTTP ${home.status}`), { status: home.status });
  } catch (e) {
    if (e.code === 'ROBOTS') {
      limitations.push('Website disallowed by robots.txt; not fetched by any route.');
      log('robots.txt disallows the site; skipping all website fallbacks');
      return [];
    }
    const why = e.status ? `HTTP ${e.status}` : e.message;
    limitations.push(`Direct fetch of ${c.url} failed (${why}); used fallback sources.`);
    log(`Direct fetch failed (${why}); trying sitemap + Tavily fallback`);
    return fallbackPages(c, log, limitations);
  }

  const hp = parseHtml(home.body, home.url);
  pages.push({ url: home.url, title: hp.title, text: hp.text.slice(0, 4500), via: 'direct' });
  for (const u of pickLinks(hp.links, home.url).slice(0, 5)) {
    try {
      const r = await politeFetch(u);
      if (!r.ok) { limitations.push(`Could not read ${u}: HTTP ${r.status}`); continue; }
      const p = parseHtml(r.body, r.url);
      pages.push({ url: r.url, title: p.title, text: p.text.slice(0, 3000), via: 'direct' });
      log(`Read ${r.url}`);
    } catch (e) { limitations.push(`Could not read ${u}: ${e.code === 'ROBOTS' ? 'blocked by robots.txt' : e.message}`); }
  }
  return pages;
}

async function fallbackPages(c, log, limitations) {
  const origin = new URL(c.url).origin;
  const host = new URL(c.url).host.replace(/^www\./, '');
  const pages = []; const seen = new Set();
  const add = (url, text, via) => {
    if (!text || seen.has(normUrl(url))) return;
    seen.add(normUrl(url));
    pages.push({ url, title: text.split('\n')[0].slice(0, 120), text: text.slice(0, 4000), via });
  };

  // (a) Tavily search restricted to the company's own domain; raw content = page text indexed by Tavily
  const hits = await webSearch(`${c.name} about products solutions customers`, { max: 8, log, includeDomains: [host], rawContent: true });
  hits.filter((h) => h.rawContent && h.rawContent.length > 300).slice(0, 5).forEach((h) => add(h.url, h.rawContent, 'tavily-search'));

  // (b) Extract for the homepage + likely pages (sitemap if readable, else domain search URLs)
  const sm = pickLinks(await sitemapLinks(origin), c.url);
  const wanted = [c.url, ...sm, ...hits.map((h) => h.url)].filter((u) => !seen.has(normUrl(u))).slice(0, 5);
  for (const x of await tavilyExtract(wanted, { log })) add(x.url, x.text, 'tavily-extract');

  if (!pages.length) limitations.push('No page text could be obtained from the company domain; facts rely on third-party search snippets only.');
  log(`Fallback collected ${pages.length} page(s) from the company domain`);
  return pages;
}

export async function researchCompany(companyId, log = () => {}) {
  const c = await CompanyM.findById(companyId);
  const limitations = [];
  const pages = [];
  log(`Fetching ${c.url}`);
  pages.push(...(await readWebsite(c, limitations, log)));

  const snippets = [];
  const q = `${c.name} ${domainOf(c.url)}`;
  for (const query of [q, `${c.name} reviews customers`, `${c.name} competitors alternatives`]) {
    const res = await webSearch(query, { max: 6, log });
    res.forEach((r) => snippets.push({ url: r.url, text: `${r.title}. ${r.snippet}` }));
  }
  try { (await googleNews(`"${c.name}"`, 90)).slice(0, 6).forEach((r) => snippets.push({ url: r.url, text: r.title })); } catch (e) { limitations.push('Google News lookup failed: ' + e.message); }
  if (!pages.length && !snippets.length) throw new Error('No public information could be retrieved for this company (site unreachable and search returned nothing).');
  log(`Collected ${pages.length} page(s) and ${snippets.length} search snippet(s)`);

  const material = [
    ...pages.map((p) => `[PAGE ${p.url}] ${p.title}\n${p.text}`),
    ...snippets.map((s) => `[SNIPPET ${s.url}] ${truncate(s.text, 400)}`),
  ].join('\n\n').slice(0, 24000);

  const out = await llmJSON({
    prompt: `Research the company "${c.name}" (${c.url}) using ONLY the material below.
Return JSON: { "oneLiner": string, "industry": string, "positioning": string, "products": string[], "customerSegments": string[], "geographies": string[],
"facts": [{ "claim": string, "sourceUrl": string (must be one of the [PAGE]/[SNIPPET] URLs), "evidenceSnippet": string (an EXACT verbatim excerpt, 12-200 chars, copied from that source) }],
"assumptions": [{ "claim": string, "rationale": string }] (inferences NOT directly stated in the material),
"unknowns": string[] (important things the material does not reveal), "keywords": string[] (8-15 specific search keywords/phrases describing the company's problem space, customers and market) }
Give 6-14 facts. Anything you cannot quote belongs in assumptions.\n\nMATERIAL:\n${material}`,
    schema: S,
  });

  const corpus = Object.fromEntries([...pages.map((p) => [normUrl(p.url), p.text + ' ' + p.title]), ...snippets.map((s) => [normUrl(s.url), s.text])]);
  const facts = [], assumptions = [...out.assumptions];
  for (const f of out.facts) {
    const src = corpus[normUrl(f.sourceUrl)];
    if (src && containsQuote(src, f.evidenceSnippet)) facts.push(f);
    else assumptions.push({ claim: f.claim, rationale: 'Downgraded: quoted evidence could not be verified in the fetched source.' });
  }
  log(`${facts.length} verified facts, ${assumptions.length} assumptions`);

  c.research = {
    summary: out.oneLiner, industry: out.industry, products: out.products, customerSegments: out.customerSegments, positioning: out.positioning, geographies: out.geographies,
    facts, assumptions, unknowns: out.unknowns, pages: pages.map((p) => ({ url: p.url, title: p.title, via: p.via })), limitations, researchedAt: new Date(),
  };
  c.profile = mergeProfile(c.profile, {
    oneLiner: out.oneLiner, industry: out.industry, positioning: out.positioning, geographies: out.geographies.join(', '),
    businessLines: out.products, customerSegments: out.customerSegments, keywords: out.keywords,
  });
  c.markModified('profile');
  if (c.status === 'created') c.status = 'researched';
  await c.save();
  return { facts: facts.length, assumptions: assumptions.length, pages: pages.length, warnings: limitations };
}
