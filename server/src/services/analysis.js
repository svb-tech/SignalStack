import { z } from 'zod';
import { CompanyM, RawItemM, SignalM, SourceM, CompetitorM } from '../models/index.js';
import { llmJSON } from '../llm.js';
import { compactProfile } from './prompts.js';
import { domainReliability, evidenceStrength, keywordOverlap, noveltyScore, rankSignal, recencyScore, URGENCY } from './ranking.js';
import { containsQuote, domainOf, jaccard, truncate, weekKey, parseDate, clamp } from '../util.js';

// The model sometimes returns null, numbers as strings, etc.: normalise everything so one sloppy field doesn't fail a batch.
const orDefault = (schema, fallback) => schema.nullish().transform((v) => v ?? fallback);
const TextValue = orDefault(z.string(), '');
const StringList = orDefault(z.array(z.string()), []);

// Models send "" (or words like "risk") for items they ignore. Fall back to a default instead of failing, and re-asking, the whole batch.
const lenientEnum = (values, fallback, aliases = {}) => z.preprocess((v) => {
  const s = String(v ?? '').trim().toLowerCase();
  return aliases[s] ?? s;
}, z.enum(values).catch(fallback));
const ImpactType = lenientEnum(['opportunity', 'threat', 'neutral'], 'neutral', { risk: 'threat', negative: 'threat', positive: 'opportunity' });
const Urgency = lenientEnum(['low', 'medium', 'high', 'critical'], 'low');

// true/false or "true"/"false"
const BooleanValue = z.preprocess((v) => {
  const s = typeof v === 'string' ? v.trim().toLowerCase() : '';
  return s === 'true' ? true : s === 'false' ? false : v;
}, orDefault(z.boolean(), false));

// 8, "8", "7.5", null
const Score = z.preprocess((v) => {
  if (typeof v !== 'string') return v;
  const s = v.trim();
  return s === '' ? 0 : Number.isFinite(Number(s)) ? Number(s) : v;
}, orDefault(z.number().finite(), 0));

const ResultItem = z.object({
  id: z.string(),
  significant: BooleanValue,
  ignoreReason: TextValue,
  category: TextValue,
  competitor: TextValue,
  headline: TextValue,
  whatHappened: TextValue,
  eventDate: orDefault(z.string(), null),
  businessArea: TextValue,
  impactType: ImpactType,
  urgency: Urgency,
  relevance: Score,
  impact: Score,
  evidenceSnippet: TextValue,
  customerQuotes: StringList,
  sentiment: TextValue,
  whyItMatters: TextValue,
  interpretation: TextValue,
  considerations: StringList,
});

// Accepts { results: [...] } as well as a bare [...]
const R = z.preprocess(
  (v) => (Array.isArray(v) ? { results: v } : v),
  z.object({ results: orDefault(z.array(ResultItem), []) })
);

const BATCH = 8;
const CATEGORIES = ['customers', 'competitors', 'market', 'internal'];
const DAY = 864e5;

/** Sends new records to the LLM in batches, keeps the significant ones as evidence-checked, ranked Signals. */
export async function analyseNewItems(companyId, { log = () => {}, limit = 80 } = {}) {
  const company = await CompanyM.findById(companyId);
  if (!company) throw new Error('Company not found');

  const competitors = await CompetitorM.find({ company: companyId }).select('name domain');
  const items = await RawItemM.find({ company: companyId, status: 'new' }).sort({ publishedAt: -1, discoveredAt: -1 }).limit(limit);
  if (!items.length) {
    log('No new records to analyse');
    return { analysed: 0, signals: 0, ignored: 0, warnings: [] };
  }
  log(`Analysing ${items.length} new record(s) in batches of ${BATCH}`);

  const recent = await SignalM.find({ company: companyId, createdAt: { $gte: new Date(Date.now() - 60 * DAY) } }).select('headline whatHappened');
  const prevTexts = recent.map((s) => `${s.headline} ${s.whatHappened}`);

  // Recent records used to spot the same story on other domains. Loaded once, only if a significant item needs it.
  let peers;
  const getPeers = async () => (peers ??= await RawItemM.find({ company: companyId, discoveredAt: { $gte: new Date(Date.now() - 21 * DAY) } }).select('title url').limit(400));

  const srcCache = {};
  const keywords = [
    ...(company.profile?.keywords || []),
    ...(company.profile?.competitorsNamed || []),
    ...competitors.map((c) => c.name),
    ...(company.profile?.customerProblems || []),
  ];

  let signals = 0;
  let ignored = 0;
  const warnings = [];

  for (let i = 0; i < items.length; i += BATCH) {
    const batch = items.slice(i, i + BATCH);

    let out;
    try {
      out = await llmJSON({
        prompt: `You analyse collected public information for a founder. Decide which items are SIGNIFICANT developments for this business and analyse them.

COMPANY PROFILE:
${compactProfile(company)}

KNOWN COMPETITORS:
${competitors.map((c) => c.name).join(', ') || 'n/a'}

ITEMS:
${batch.map((it) => `
<item id="${it._id}" category_hint="${it.category}" competitor_hint="${it.competitor || ''}" kind="${it.kind}" published="${it.publishedAt?.toISOString().slice(0, 10) || 'unknown'}" url="${it.url}"${it.headlineOnly ? ' headline_only="true"' : ''}>
TITLE: ${it.title}
TEXT: ${truncate(it.content, 1800)}
</item>
`).join('\n')}

RULES:

- significant=true only if the item is a concrete development, customer pain point/expectation, or fact that could change a decision for THIS company.
- Generic news, SEO fluff, unrelated items, and rehashes of old news are NOT significant.
- If insignificant, provide ignoreReason as a short string.
- Page-change items count only if changed text shows a real change (price, product, policy, hiring, positioning).

- whatHappened: neutral factual statement of what the source says. No opinion. Do not add facts that are not in the item.

- evidenceSnippet: EXACT verbatim excerpt (12-250 chars) copied from TITLE or TEXT that supports whatHappened.

- eventDate: ISO date if the item states one, else null. Do not guess.

- customerQuotes: for customer discussions, verbatim customer phrases (each 12-200 chars) copied from TEXT; else [].

- interpretation / whyItMatters / considerations: YOUR strategic reading, clearly separate from facts. Be specific to this company's segments, competitors and priorities.

- category must be one of: customers, competitors, market, internal.

- businessArea: area of business affected, e.g. pricing, acquisition, product, partnerships, compliance, hiring, brand.

- relevance and impact must be numbers from 0-10.
- impact = size of consequence if true.

- urgency must be one of: low, medium, high, critical.

- sentiment (customer items): negative, neutral, positive, mixed; otherwise "".

STRICT JSON RULES:
- Return a JSON object with a results array.
- Every item must have one entry matching its id.
- significant MUST be a boolean, not a string.
- relevance and impact MUST be numbers, not strings.
- Use "" or [] when empty.
- NEVER return null for text fields.

EXPECTED FORMAT:
{
  "results": [
    {
      "id": "item_id",
      "significant": true,
      "ignoreReason": "",
      "category": "market",
      "competitor": "",
      "headline": "Example headline",
      "whatHappened": "Factual description",
      "eventDate": null,
      "businessArea": "product",
      "impactType": "opportunity",
      "urgency": "medium",
      "relevance": 8,
      "impact": 7,
      "evidenceSnippet": "Exact source excerpt",
      "customerQuotes": [],
      "sentiment": "",
      "whyItMatters": "Business relevance",
      "interpretation": "Strategic interpretation",
      "considerations": []
    }
  ]
}`,
        schema: R,
      });
    } catch (e) {
      warnings.push(`Batch ${i / BATCH + 1} failed: ${e.message}`);
      log(`✗ analysis batch failed: ${e.message}`);
      continue;
    }

    for (const it of batch) {
      const r = out.results.find((x) => x.id === String(it._id));
      if (!r) continue; // model skipped it: stays 'new' and is retried next run

      if (!r.significant) {
        it.status = 'ignored';
        it.analysisNote = r.ignoreReason || 'Not significant for this business';
        await it.save();
        ignored++;
        continue;
      }

      const src = srcCache[it.source] || (srcCache[it.source] = await SourceM.findById(it.source));
      const haystack = `${it.title}\n${it.content}`;
      const evidenceVerified = containsQuote(haystack, r.evidenceSnippet);
      const quotes = r.customerQuotes.filter((q) => containsQuote(haystack, q));
      const myDomain = domainOf(it.url);
      const companyDomain = domainOf(company.url);

      // Other domains carrying the same story = corroboration.
      const doms = new Set((it.alsoSeenIn || []).map((x) => x.domain).filter((d) => d && d !== myDomain));
      for (const peer of await getPeers()) {
        if (String(peer._id) !== String(it._id) && jaccard(peer.title, it.title) >= 0.5 && domainOf(peer.url) !== myDomain) doms.add(domainOf(peer.url));
      }

      const ugc = ['hn', 'reddit', 'stackexchange'].includes(src?.type) || ((r.category || it.category) === 'customers' && domainReliability(it.url, src?.type) <= 0.35);
      const compMatch = competitors.find((c) => c.domain && myDomain.endsWith(c.domain));
      const primary = !!compMatch || domainReliability(it.url, '', companyDomain) >= 0.85;
      const sourceReliability = domainReliability(it.url, src?.type, companyDomain);
      const es = evidenceStrength({ evidenceVerified, corroborationDomains: doms.size, hasPublishedDate: !!it.publishedAt, headlineOnly: it.headlineOnly, primary });
      const verification = ugc ? 'user_generated' : doms.size >= 1 ? 'corroborated' : evidenceVerified ? 'single_source' : 'unverified';

      const text = `${r.headline} ${r.whatHappened}`;
      const published = it.publishedAt || parseDate(r.eventDate);
      const rank = rankSignal({
        relevance: clamp(0.7 * (r.relevance / 10) + 0.3 * keywordOverlap(text, keywords)),
        impact: clamp(r.impact / 10),
        urgency: URGENCY[r.urgency] ?? 0.2,
        sourceReliability,
        evidenceStrength: es,
        recency: recencyScore(published || it.discoveredAt),
        novelty: noveltyScore(text, prevTexts),
      });
      prevTexts.push(text);

      await SignalM.create({
        company: companyId,
        item: it._id,
        source: it.source,
        category: CATEGORIES.includes(r.category) ? r.category : it.category,
        competitor: r.competitor || it.competitor || compMatch?.name || undefined,
        headline: r.headline || it.title,
        whatHappened: r.whatHappened,
        eventDate: parseDate(r.eventDate) || undefined,
        publishedAt: published || undefined,
        discoveredAt: it.discoveredAt,
        sourceName: src?.name,
        sourceUrl: it.url,
        sourceDomain: myDomain,
        evidenceSnippet: r.evidenceSnippet,
        evidenceVerified,
        customerQuotes: quotes,
        sentiment: r.sentiment,
        businessArea: r.businessArea,
        impactType: r.impactType,
        urgency: r.urgency,
        verification,
        whyItMatters: r.whyItMatters,
        interpretation: r.interpretation,
        considerations: r.considerations,
        sourceReliability,
        evidenceStrength: es,
        strategicRelevance: rank.strategicRelevance,
        factors: rank.parts,
        score: rank.score,
        rankExplanation: rank.explanation,
        weekKey: weekKey(),
        tags: it.kind === 'article' ? [] : [it.kind],
      });

      it.status = 'analysed';
      await it.save();
      signals++;
    }

    log(`Batch ${Math.floor(i / BATCH) + 1}/${Math.ceil(items.length / BATCH)} done (${signals} signals so far)`);
  }

  // Refresh per-source health counters.
  const since = new Date(Date.now() - 30 * DAY);
  for (const sid of new Set(items.map((x) => String(x.source)))) {
    const [items30d, signals30d] = await Promise.all([
      RawItemM.countDocuments({ source: sid, discoveredAt: { $gte: since } }),
      SignalM.countDocuments({ source: sid, createdAt: { $gte: since } }),
    ]);
    await SourceM.updateOne({ _id: sid }, { 'health.items30d': items30d, 'health.signals30d': signals30d });
  }

  log(`Analysis complete: ${signals} signals, ${ignored} ignored`);
  return { analysed: items.length, signals, ignored, warnings };
}
