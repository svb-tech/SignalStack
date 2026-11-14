import { z } from 'zod';
import nodemailer from 'nodemailer';
import { CompanyM, SignalM, BriefM, ActionM, SourceM, CompetitorM, InternalDocM, RawItemM } from '../models/index.js';
import { llmJSON } from '../llm.js';
import { compactProfile } from './prompts.js';
import { weekKey, truncate, istDate } from '../util.js';
import { cfg } from '../config.js';

// Groq models often return numbers, single strings, objects or arrays where a string is expected.
// Coerce what can be coerced, and drop only the single bad item instead of failing the whole brief.
const toText = (v) => {
  if (v == null) return '';
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  if (Array.isArray(v)) return v.map(toText).filter(Boolean).join('; ');
  if (typeof v === 'object') return Object.values(v).map(toText).filter(Boolean).join(' - ');
  return '';
};
const TextValue = z.preprocess(toText, z.string());

// "S1", ["S1","S2"], "S1, S2", 3, ["s3"], [{ id: "S4" }] -> ["S1","S2",...]
const toRefs = (v) => {
  const list = Array.isArray(v) ? v : v == null ? [] : [v];
  return list.flatMap((x) => {
    const t = toText(typeof x === 'object' && x ? (x.id ?? x.signal ?? '') : x);
    return t.match(/\d+/g)?.map((n) => `S${+n}`) || [];
  });
};
const Refs = z.preprocess(toRefs, z.array(z.string()));

const section = (shape) => {
  const item = z.object(shape);
  return z.preprocess((v) => (Array.isArray(v) ? v : v && typeof v === 'object' ? [v] : []), z.array(z.any()))
    .transform((arr) => arr.map((x) => item.safeParse(x)).filter((r) => r.success).map((r) => r.data));
};
export const B = z.object({
  executiveSummary: section({ headline: TextValue, whyItMatters: TextValue, signals: Refs }),
  customers: section({ theme: TextValue, interpretation: TextValue, signals: Refs }),
  competitors: section({ competitor: TextValue, whyItMatters: TextValue, implications: TextValue, signals: Refs }),
  market: section({ theme: TextValue, whyItMatters: TextValue, signals: Refs }),
  internal: section({ theme: TextValue, interpretation: TextValue, signals: Refs }),
  opportunities: section({ title: TextValue, impact: TextValue, nextStep: TextValue, priority: TextValue, signals: Refs }),
  risks: section({ title: TextValue, possibleImpact: TextValue, urgency: TextValue, signals: Refs }),
  actions: section({ action: TextValue, reason: TextValue, owner: TextValue, priority: TextValue, signals: Refs }),
  watch: section({ item: TextValue, why: TextValue, signals: Refs }),
});

const NONE = 'No meaningful development detected in this category during the period. Nothing has been manufactured to fill this section.';

export async function generateBrief(companyId, { trigger = 'manual', lookbackDays, log = () => {} } = {}) {
  const company = await CompanyM.findById(companyId);
  const days = lookbackDays || company.settings.brief.lookbackDays || 7;
  const end = new Date(), start = new Date(end.getTime() - days * 864e5);
  const signals = await SignalM.find({ company: companyId, createdAt: { $gte: start } }).sort({ score: -1 }).limit(45).lean();
  const [competitors, srcStats, rawCount, internalDocs] = await Promise.all([
    CompetitorM.find({ company: companyId }).select('name'),
    SourceM.aggregate([{ $match: { company: company._id } }, { $group: { _id: '$status', n: { $sum: 1 } } }]),
    RawItemM.countDocuments({ company: companyId, discoveredAt: { $gte: start } }),
    InternalDocM.countDocuments({ company: companyId }),
  ]);
  const approved = srcStats.find((s) => s._id === 'approved')?.n || 0;
  const limitations = [];
  if (!signals.length) limitations.push(`No analysed signals exist for the last ${days} day(s). Run monitoring and analysis, or widen the look-back window.`);
  if (!internalDocs) limitations.push('No internal documents have been uploaded, so Internal Business Intelligence is empty by design.');
  if (signals.some((s) => s.verification === 'unverified')) limitations.push('Some signals could not be verified verbatim against their source text and are marked "unverified".');
  if (signals.some((s) => s.verification === 'user_generated')) limitations.push('Customer forum/review items are user-generated opinions: they show sentiment and language, not verified fact.');
  const idx = new Map(signals.map((s, i) => [`S${i + 1}`, s]));

  let ai = B.parse({});
  if (signals.length) {
    log(`Writing brief from ${signals.length} ranked signals`);
    try {
      const buildPrompt = (n) => `Write the content of a Monday Morning Intelligence Brief for the founder of this company.
${compactProfile(company)}
Decisions the founder wants help with: ${(company.profile.decisionsToSupport || []).join('; ') || 'n/a'}
Growth priorities: ${(company.profile.growthPriorities || []).join('; ') || 'n/a'}

SIGNALS (ranked; each has facts and a prior analysis). Cite ONLY these ids:
${[...idx].slice(0, n).map(([id, s]) => `${id} [${s.category}${s.competitor ? '/' + s.competitor : ''}] score=${s.score} ${s.impactType} urgency=${s.urgency} verification=${s.verification}\nFACT: ${truncate(s.whatHappened, n > 25 ? 300 : 220)}\nPRIOR INTERPRETATION: ${truncate(s.interpretation || s.whyItMatters, n > 25 ? 240 : 160)}`).join('\n\n')}

RULES
- Every item MUST cite 1+ signal ids in "signals" and may only claim what those signals support. If a category has no supporting signals return [] for it. Never invent developments, numbers or quotes. Never return null; use empty strings or empty arrays for missing values.
- Do not restate the facts (they are inserted automatically beside your text); instead write the BUSINESS IMPLICATION: what it means for this company's segments, competitors, pricing, pipeline or priorities, and the decision it informs. Be specific, no generic advice.
- executiveSummary: up to 5 items, most decision-relevant first (fewer if fewer matter).
- opportunities: up to 5, each with impact and a concrete nextStep, priority high|medium|low. Only evidence-backed ones; if fewer than 3 exist, return fewer.
- risks: negative developments with possibleImpact and urgency.
- actions: prioritised actions for THIS WEEK with reason and a suggested owner role (e.g. Founder, Head of Sales, Product, Marketing, Partnerships).
- watch: early/weak signals worth continued monitoring (cite them).
Return JSON { "executiveSummary": [{ "headline", "whyItMatters", "signals": ["S1"] }], "customers": [{ "theme", "interpretation", "signals" }], "competitors": [{ "competitor", "whyItMatters", "implications", "signals" }], "market": [{ "theme", "whyItMatters", "signals" }], "internal": [{ "theme", "interpretation", "signals" }], "opportunities": [{ "title", "impact", "nextStep", "priority", "signals" }], "risks": [{ "title", "possibleImpact", "urgency", "signals" }], "actions": [{ "action", "reason", "owner", "priority", "signals" }], "watch": [{ "item", "why", "signals" }] }`;
      // Groq's per-minute token cap counts prompt + output budget. If the request is too big, resend with fewer signals.
      let lastErr;
      for (const n of new Set([idx.size, 25, 15, 8])) {
        if (n > idx.size) continue;
        try {
          ai = await llmJSON({ prompt: buildPrompt(n), schema: B, temperature: 0.4, minTokens: 4096 });
          lastErr = null;
          break;
        } catch (e) {
          lastErr = e;
          if (!e.tooLarge) break;
          log(`Brief prompt too large for Groq limits with ${n} signals; retrying with fewer`);
        }
      }
      if (lastErr) throw lastErr;
    } catch (error) {
      limitations.push(`AI brief synthesis was unavailable (${error.message}). The brief uses deterministic summaries of already analysed signals; no new claims were generated.`);
      log(`AI synthesis unavailable; building evidence-grounded fallback brief: ${error.message}`);

      const ref = (signal) => `S${signals.indexOf(signal) + 1}`;
      const priority = (urgency) => urgency === 'critical' || urgency === 'high' ? 'high' : urgency === 'medium' ? 'medium' : 'low';
      const summary = signals.slice(0, 5).map((s) => ({
        headline: s.headline || 'Relevant business signal',
        whyItMatters: s.interpretation || s.whyItMatters || 'Review the linked evidence to determine its business relevance.',
        signals: [ref(s)],
      }));

      ai = {
        executiveSummary: summary,
        customers: signals.filter((s) => s.category === 'customers').slice(0, 8).map((s) => ({ theme: s.headline, interpretation: s.interpretation || s.whyItMatters || '', signals: [ref(s)] })),
        competitors: signals.filter((s) => s.category === 'competitors').slice(0, 8).map((s) => ({ competitor: s.competitor || s.headline, whyItMatters: s.interpretation || s.whyItMatters || '', implications: '', signals: [ref(s)] })),
        market: signals.filter((s) => s.category === 'market').slice(0, 8).map((s) => ({ theme: s.headline, whyItMatters: s.interpretation || s.whyItMatters || '', signals: [ref(s)] })),
        internal: signals.filter((s) => s.category === 'internal').slice(0, 8).map((s) => ({ theme: s.headline, interpretation: s.interpretation || s.whyItMatters || '', signals: [ref(s)] })),
        opportunities: signals.filter((s) => s.impactType === 'opportunity').slice(0, 5).map((s) => ({ title: s.headline, impact: s.interpretation || s.whyItMatters || '', nextStep: 'Review the linked evidence and assess whether this opportunity merits action this week.', priority: priority(s.urgency), signals: [ref(s)] })),
        risks: signals.filter((s) => s.impactType === 'threat').slice(0, 5).map((s) => ({ title: s.headline, possibleImpact: s.interpretation || s.whyItMatters || '', urgency: s.urgency || 'medium', signals: [ref(s)] })),
        actions: signals.filter((s) => ['high', 'critical'].includes(s.urgency)).slice(0, 5).map((s) => ({ action: `Review: ${s.headline}`, reason: s.interpretation || s.whyItMatters || 'Assess the linked evidence and decide whether follow-up is required.', owner: 'Founder', priority: 'high', signals: [ref(s)] })),
        watch: signals.filter((s) => s.impactType === 'neutral' || s.urgency === 'low').slice(0, 5).map((s) => ({ item: s.headline, why: s.interpretation || s.whyItMatters || 'Continue monitoring for corroborating evidence.', signals: [ref(s)] })),
      };
    }
  }

  // Server-side grounding: drop anything without valid signal references; attach facts + evidence deterministically.
  const ground = (arr) => (arr || []).map((x) => ({ ...x, refs: (x.signals || []).filter((r) => idx.has(r)) })).filter((x) => x.refs.length).map((x) => ({ ...x, signalIds: x.refs.map((r) => String(idx.get(r)._id)), facts: x.refs.map((r) => { const s = idx.get(r); return { text: s.whatHappened, headline: s.headline, verification: s.verification, url: s.sourceUrl, source: s.sourceName, date: s.publishedAt || s.eventDate || s.discoveredAt, score: s.score, quotes: s.customerQuotes?.slice(0, 2), sentiment: s.sentiment }; }) }));
  const content = {
    meta: { company: company.name, url: company.url, periodStart: start, periodEnd: end, generatedAt: new Date(), trigger, lookbackDays: days, signalsConsidered: signals.length, recordsCollected: rawCount, approvedSources: approved, competitorsTracked: competitors.length },
    executiveSummary: ground(ai.executiveSummary).slice(0, 5),
    customers: ground(ai.customers), competitors: ground(ai.competitors), market: ground(ai.market), internal: ground(ai.internal),
    opportunities: ground(ai.opportunities), risks: ground(ai.risks), actions: ground(ai.actions), watch: ground(ai.watch),
    notes: {},
  };
  const byCat = (c) => signals.filter((s) => s.category === c).length;
  for (const c of ['customers', 'competitors', 'market', 'internal']) if (!content[c].length) content.notes[c] = byCat(c) ? `${byCat(c)} signal(s) were collected but none rose to a decision-relevant theme this period.` : NONE;
  if (content.opportunities.length < 3) content.notes.opportunities = content.opportunities.length ? `Only ${content.opportunities.length} evidence-backed opportunity(ies) identified; fewer than the usual three rather than inventing weak ones.` : NONE;
  if (!content.risks.length) content.notes.risks = NONE;
  if (!content.watch.length) content.notes.watch = 'Nothing flagged for early-watch this period.';
  if (!content.executiveSummary.length) content.notes.executiveSummary = 'No developments reached the executive threshold this period.';

  const used = new Set();
  ['executiveSummary', 'customers', 'competitors', 'market', 'internal', 'opportunities', 'risks', 'actions', 'watch'].forEach((k) => content[k].forEach((x) => x.signalIds.forEach((i) => used.add(i))));
  const appendix = signals.filter((s) => used.has(String(s._id))).map((s) => ({ id: String(s._id), headline: s.headline, source: s.sourceName, domain: s.sourceDomain, url: s.sourceUrl, published: s.publishedAt || s.eventDate || null, discovered: s.discoveredAt, snippet: s.evidenceSnippet, snippetVerified: !!s.evidenceVerified, verification: s.verification, sourceReliability: s.sourceReliability, evidenceStrength: s.evidenceStrength, strategicRelevance: s.strategicRelevance, score: s.score }));
  content.appendix = appendix;

  const brief = await BriefM.create({ company: companyId, weekKey: weekKey(), periodStart: start, periodEnd: end, trigger, content, limitations, signalIds: [...used] });
  brief.markdown = toMarkdown(content, limitations);
  brief.html = toHtml(content, limitations);
  await brief.save();
  if (content.actions.length) await ActionM.insertMany(content.actions.map((a) => ({ company: companyId, brief: brief._id, title: a.action, reason: a.reason, owner: a.owner, priority: a.priority, signalIds: a.signalIds })));
  log(`Brief saved (${used.size} evidenced signals, ${content.actions.length} actions)`);
  if (company.settings.brief.emailTo) await emailBrief(brief, company).then(() => log('Brief emailed'), (e) => log('Email failed: ' + e.message));
  return brief;
}

export async function emailBrief(brief, company, to) {
  const recipients = String(to || company.settings.brief.emailTo || '').split(/[,;\s]+/).filter(Boolean);
  if (!recipients.length) throw new Error('No recipient email address');
  const subject = `Monday Morning Brief: ${company.name} (${brief.weekKey})`;

  if (cfg.resend.key) {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cfg.resend.key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: cfg.resend.from, to: recipients, subject, html: brief.html, text: brief.markdown }),
      signal: AbortSignal.timeout(30000),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(`Resend error (${res.status}): ${data.message || 'request failed'}`);
  } else if (cfg.smtp.host) {
    const t = nodemailer.createTransport({ host: cfg.smtp.host, port: cfg.smtp.port, auth: cfg.smtp.user ? { user: cfg.smtp.user, pass: cfg.smtp.pass } : undefined });
    await t.sendMail({ from: cfg.smtp.from || cfg.smtp.user, to: recipients, subject, html: brief.html, text: brief.markdown });
  } else {
    throw new Error('Email is not configured: set RESEND_API_KEY (or SMTP_HOST) in server/.env');
  }

  brief.emailedAt = new Date();
  await brief.save();
} 

// ------------------------------------------------------------------ rendering
const fmt = istDate;
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const SECTIONS = [['customers', '2. Customer Signals'], ['competitors', '3. Competitor Intelligence'], ['market', '4. Market Intelligence'], ['internal', '5. Internal Business Intelligence']];

function factLines(x) { return x.facts.map((f) => `${f.text} [${f.source || 'source'}, ${fmt(f.date)}, ${f.verification}](${f.url})`); }

function toMarkdown(c, limitations = []) {
  c = { ...c, notes: c.notes || {} };
  const o = [`# Monday Morning Brief: ${c.meta.company}`, `Period ${fmt(c.meta.periodStart)} to ${fmt(c.meta.periodEnd)} | ${c.meta.signalsConsidered} signals from ${c.meta.recordsCollected} new records | ${c.meta.approvedSources} approved sources | ${c.meta.competitorsTracked} competitors tracked`, ''];
  o.push('## 1. Executive Summary');
  if (!c.executiveSummary.length) o.push(c.notes.executiveSummary);
  c.executiveSummary.forEach((x, i) => { o.push(`${i + 1}. **${x.headline}**`, `   - Verified facts: ${factLines(x).join(' / ')}`, `   - Why it matters (our interpretation): ${x.whyItMatters}`); });
  for (const [k, title] of SECTIONS) {
    o.push('', `## ${title}`);
    if (!c[k].length) o.push(c.notes[k]);
    c[k].forEach((x) => {
      o.push(`### ${x.theme || x.competitor}`, ...x.facts.map((f) => `- **Evidence:** ${f.text} ([${f.source || 'source'}](${f.url}), ${fmt(f.date)}, ${f.verification})` + (f.quotes?.length ? ` Customer words: ${f.quotes.map((q) => `"${q}"`).join(' / ')}` : '')));
      o.push(`- **Interpretation:** ${x.interpretation || x.whyItMatters}${x.implications ? ` Implications: ${x.implications}` : ''}`);
    });
  }
  o.push('', '## 6. Opportunities Identified');
  if (c.notes.opportunities) o.push(c.notes.opportunities);
  c.opportunities.forEach((x, i) => o.push(`${i + 1}. **${x.title}** (priority: ${x.priority})`, `   - Evidence: ${factLines(x).join(' / ')}`, `   - Impact: ${x.impact}`, `   - Next step: ${x.nextStep}`));
  o.push('', '## 7. Risks & Threats');
  if (c.notes.risks) o.push(c.notes.risks);
  c.risks.forEach((x) => o.push(`- **${x.title}** (urgency: ${x.urgency}). Possible impact: ${x.possibleImpact}. Evidence: ${factLines(x).join(' / ')}`));
  o.push('', '## 8. Recommended Actions for This Week');
  if (!c.actions.length) o.push('No actions recommended: no evidence-backed developments this period.');
  c.actions.forEach((x, i) => o.push(`${i + 1}. **${x.action}** (priority ${x.priority}, owner: ${x.owner || 'unassigned'}). Reason: ${x.reason}`));
  o.push('', '## 9. What We Should Watch');
  if (c.notes.watch) o.push(c.notes.watch);
  c.watch.forEach((x) => o.push(`- **${x.item}**: ${x.why}`));
  o.push('', '## 10. Source Appendix', '| Source | Link | Published | Discovered | Evidence snippet | Verification | Reliability / Evidence |', '|---|---|---|---|---|---|---|');
  c.appendix.forEach((a) => o.push(`| ${a.source || a.domain} | ${a.url} | ${fmt(a.published)} | ${fmt(a.discovered)} | ${(a.snippet || '').replace(/\|/g, '/')} ${a.snippetVerified ? '(verbatim-checked)' : '(NOT verbatim-verified)'} | ${a.verification} | ${Math.round((a.sourceReliability || 0) * 100)}% / ${Math.round((a.evidenceStrength || 0) * 100)}% |`));
  if (limitations.length) o.push('', '## Limitations', ...limitations.map((l) => `- ${l}`));
  return o.join('\n');
}

function toHtml(c, limitations = []) {
  c = { ...c, notes: c.notes || {} };
  const f = (x) => x.facts.map((q) => `<li><b>Verified fact:</b> ${esc(q.text)} <a href="${esc(q.url)}">${esc(q.source || 'source')}</a> <small>(${fmt(q.date)}, ${esc(q.verification)})</small>${q.quotes?.length ? `<br><i>${q.quotes.map((t) => `“${esc(t)}”`).join(' / ')}</i>` : ''}</li>`).join('');
  const h = (t) => `<h2 style="border-bottom:2px solid #0f766e;padding-bottom:4px;margin-top:28px">${t}</h2>`;
  let o = `<div style="font-family:Segoe UI,Arial,sans-serif;max-width:760px;margin:auto;color:#14202b;line-height:1.5"><h1>Monday Morning Brief: ${esc(c.meta.company)}</h1><p style="color:#5b6b7a">${fmt(c.meta.periodStart)} to ${fmt(c.meta.periodEnd)} · ${c.meta.signalsConsidered} signals · ${c.meta.approvedSources} approved sources</p>`;
  o += h('1. Executive Summary') + (c.executiveSummary.length ? '<ol>' + c.executiveSummary.map((x) => `<li><b>${esc(x.headline)}</b><ul>${f(x)}<li><b>Our interpretation:</b> ${esc(x.whyItMatters)}</li></ul></li>`).join('') + '</ol>' : `<p>${esc(c.notes.executiveSummary)}</p>`);
  for (const [k, t] of SECTIONS) o += h(t) + (c[k].length ? c[k].map((x) => `<h3>${esc(x.theme || x.competitor)}</h3><ul>${f(x)}<li><b>Our interpretation:</b> ${esc(x.interpretation || x.whyItMatters)} ${esc(x.implications || '')}</li></ul>`).join('') : `<p><i>${esc(c.notes[k])}</i></p>`);
  o += h('6. Opportunities Identified') + (c.notes.opportunities ? `<p><i>${esc(c.notes.opportunities)}</i></p>` : '') + c.opportunities.map((x) => `<h3>${esc(x.title)} <small>(${esc(x.priority)})</small></h3><ul>${f(x)}<li><b>Impact:</b> ${esc(x.impact)}</li><li><b>Next step:</b> ${esc(x.nextStep)}</li></ul>`).join('');
  o += h('7. Risks & Threats') + (c.notes.risks ? `<p><i>${esc(c.notes.risks)}</i></p>` : '') + c.risks.map((x) => `<h3>${esc(x.title)} <small>(urgency: ${esc(x.urgency)})</small></h3><ul>${f(x)}<li><b>Possible impact:</b> ${esc(x.possibleImpact)}</li></ul>`).join('');
  o += h('8. Recommended Actions for This Week') + '<ol>' + c.actions.map((x) => `<li><b>${esc(x.action)}</b> <small>(${esc(x.priority)}, owner: ${esc(x.owner || 'unassigned')})</small><br>${esc(x.reason)}</li>`).join('') + '</ol>';
  o += h('9. What We Should Watch') + (c.notes.watch ? `<p><i>${esc(c.notes.watch)}</i></p>` : '') + '<ul>' + c.watch.map((x) => `<li><b>${esc(x.item)}</b>: ${esc(x.why)}</li>`).join('') + '</ul>';
  o += h('10. Source Appendix') + '<table style="border-collapse:collapse;font-size:12px;width:100%"><tr>' + ['Source', 'Published', 'Discovered', 'Evidence snippet', 'Verification'].map((t) => `<th style="border:1px solid #ccd;padding:4px;text-align:left">${t}</th>`).join('') + '</tr>' +
    c.appendix.map((a) => `<tr><td style="border:1px solid #ccd;padding:4px"><a href="${esc(a.url)}">${esc(a.source || a.domain)}</a></td><td style="border:1px solid #ccd;padding:4px">${fmt(a.published)}</td><td style="border:1px solid #ccd;padding:4px">${fmt(a.discovered)}</td><td style="border:1px solid #ccd;padding:4px">${esc(a.snippet)} <small>${a.snippetVerified ? '✓ verbatim' : '⚠ unverified'}</small></td><td style="border:1px solid #ccd;padding:4px">${esc(a.verification)} · reliability ${Math.round((a.sourceReliability || 0) * 100)}% · evidence ${Math.round((a.evidenceStrength || 0) * 100)}%</td></tr>`).join('') + '</table>';
  if (limitations.length) o += h('Limitations') + '<ul>' + limitations.map((l) => `<li>${esc(l)}</li>`).join('') + '</ul>';
  return o + '</div>';
}