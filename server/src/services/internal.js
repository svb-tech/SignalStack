import Papa from 'papaparse';
import * as XLSX from 'xlsx';
import { createRequire } from 'node:module';
import { z } from 'zod';
import { CompanyM, SourceM, InternalDocM, SignalM } from '../models/index.js';
import { llmJSON } from '../llm.js';
import { compactProfile } from './prompts.js';
import { containsQuote, truncate, weekKey } from '../util.js';
import { rankSignal, evidenceStrength } from './ranking.js';

const require = createRequire(import.meta.url);

async function toText(file) {
  const name = file.originalname.toLowerCase();
  const limitations = [];
  let text = '', rows = 0, kind = 'text', stats = '';
  if (name.endsWith('.pdf')) {
    kind = 'pdf';
    const pdf = require('pdf-parse/lib/pdf-parse.js');
    text = (await pdf(file.buffer)).text;
  } else if (/\.(xlsx|xls)$/.test(name)) {
    kind = 'excel';
    const wb = XLSX.read(file.buffer, { type: 'buffer' });
    text = wb.SheetNames.map((n) => `## Sheet ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n])).join('\n');
  } else if (name.endsWith('.csv') || name.endsWith('.tsv')) {
    kind = 'csv';
    text = file.buffer.toString('utf8');
  } else { text = file.buffer.toString('utf8'); }
  if (kind === 'csv' || kind === 'excel') {
    const parsed = Papa.parse(text.replace(/^## Sheet.*\n/gm, ''), { header: true, skipEmptyLines: true });
    rows = parsed.data.length;
    // deterministic value counts for categorical-looking columns (lost reason, stage, objection, status…)
    const cols = (parsed.meta.fields || []).filter((f) => /(reason|stage|status|objection|source|segment|type|category|outcome|lost|priority|product|plan|sentiment)/i.test(f));
    for (const c of cols.slice(0, 6)) {
      const counts = {};
      parsed.data.forEach((r) => { const v = String(r[c] || '').trim(); if (v && v.length < 80) counts[v] = (counts[v] || 0) + 1; });
      const top = Object.entries(counts).sort((a, b) => b[1] - a[1]).slice(0, 8);
      if (top.length) stats += `Column "${c}" top values over ${rows} rows: ${top.map(([v, n]) => `${v} (${n})`).join('; ')}\n`;
    }
  }
  if (text.length > 14000) limitations.push(`Only the first 14,000 of ${text.length} characters were sent to the model${stats ? ' (column statistics cover all rows)' : ''}.`);
  return { text, kind, rows, stats, limitations };
}

const A = z.object({
  summary: z.string().default(''),
  findings: z.array(z.object({
    type: z.enum(['objection', 'lost_deal_reason', 'product_request', 'sales_pattern', 'operational_issue', 'risk', 'customer_feedback']).default('customer_feedback'),
    headline: z.string(), detail: z.string().default(''), evidenceQuote: z.string().default(''), frequency: z.string().default(''),
    impactType: z.enum(['opportunity', 'threat', 'neutral']).default('neutral'), urgency: z.enum(['low', 'medium', 'high', 'critical']).default('low'),
    relevance: z.number().default(5), impact: z.number().default(5), interpretation: z.string().default(''), considerations: z.array(z.string()).default([]),
  })).default([]),
});

export async function ingestUpload(companyId, file) {
  const company = await CompanyM.findById(companyId);
  const { text, kind, rows, stats, limitations } = await toText(file);
  if (text.trim().length < 30) throw Object.assign(new Error('File contained no readable text (scanned PDF? try OCR first)'), { status: 400 });
  const doc = await InternalDocM.create({ company: companyId, filename: file.originalname, mime: file.mimetype, kind, chars: text.length, rows, preview: truncate(text, 400), limitations });
  const out = await llmJSON({
    prompt: `Analyse this INTERNAL business document (${kind}, file "${file.originalname}") for a founder.
COMPANY:\n${compactProfile(company)}
${stats ? `DETERMINISTIC COLUMN STATISTICS (exact, over all ${rows} rows):\n${stats}\n` : ''}DOCUMENT TEXT (may be truncated):\n${truncate(text, 14000)}
Identify recurring customer objections, lost-deal reasons, product requests, sales patterns, operational issues and emerging risks. Report only what the document supports. Each finding needs "evidenceQuote": an EXACT verbatim excerpt (12-250 chars) copied from the document text or statistics (copy a statistics line if the finding is count-based), and "frequency" stated only if countable from the data (else ""). "interpretation" is your strategic reading, separate from the facts in "detail". relevance/impact 0-10.
Return JSON { "summary": string, "findings": [{ "type", "headline", "detail", "evidenceQuote", "frequency", "impactType", "urgency", "relevance", "impact", "interpretation", "considerations": string[] }] } (max 10 findings).`,
    schema: A,
  });
  let src = await SourceM.findOne({ company: companyId, type: 'upload' });
  if (!src) src = await SourceM.create({ company: companyId, key: 'upload|internal', category: 'internal', type: 'upload', name: 'Internal uploads (CRM, transcripts, feedback, reports)', reason: 'Founder-supplied internal data reveals objections, lost deals and product requests invisible externally.', status: 'approved', origin: 'manual', scores: { specific: 1, recent: 1, credible: 0.7, overall: 0.9 } });
  const haystack = text + '\n' + stats;
  let created = 0;
  for (const f of out.findings) {
    const verified = containsQuote(haystack, f.evidenceQuote);
    const es = evidenceStrength({ evidenceVerified: verified, corroborationDomains: 0, hasPublishedDate: true, headlineOnly: false, primary: true });
    const rank = rankSignal({ relevance: f.relevance / 10, impact: f.impact / 10, urgency: { low: 0.2, medium: 0.5, high: 0.8, critical: 1 }[f.urgency], sourceReliability: 0.7, evidenceStrength: es, recency: 0.9, novelty: 0.8 });
    await SignalM.create({
      company: companyId, source: src._id, category: 'internal', headline: f.headline, whatHappened: `${f.detail}${f.frequency ? ` (${f.frequency})` : ''}`,
      publishedAt: new Date(), discoveredAt: new Date(), sourceName: file.originalname, sourceUrl: `internal://doc/${doc._id}`, sourceDomain: 'internal', evidenceSnippet: f.evidenceQuote, evidenceVerified: verified,
      businessArea: f.type.replace(/_/g, ' '), impactType: f.impactType, urgency: f.urgency, verification: 'internal_data', whyItMatters: f.interpretation, interpretation: f.interpretation, considerations: f.considerations,
      sourceReliability: 0.7, evidenceStrength: es, strategicRelevance: rank.strategicRelevance, factors: rank.parts, score: rank.score, rankExplanation: rank.explanation, weekKey: weekKey(), tags: [f.type],
    });
    created++;
  }
  doc.analysis = { summary: out.summary, findings: out.findings.length, signalsCreated: created };
  await doc.save();
  return doc;
}
