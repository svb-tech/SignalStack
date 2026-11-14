// Produces test evidence (counts, sample records with links) and exports every brief to ../reports.
import mongoose from 'mongoose';
import fs from 'node:fs';
import path from 'node:path';
import { cfg } from '../src/config.js';
import { CompanyM, SourceM, SignalM, RawItemM, CompetitorM, BriefM, CrawlLogM, JobRunM, AuditReportM, StackChangeM } from '../src/models/index.js';

await mongoose.connect(cfg.mongo);
const out = ['# Test evidence (generated from the live database)', `Generated ${new Date().toISOString()}`, ''];
const reports = path.resolve('../reports');
fs.mkdirSync(reports, { recursive: true });
let totalRecords = 0;
for (const c of await CompanyM.find()) {
  const q = { company: c._id };
  const [approved, byCat, comps, raw, sigs, crawls, briefs, audits, changes, jobs] = await Promise.all([
    SourceM.countDocuments({ ...q, status: 'approved' }),
    SourceM.aggregate([{ $match: { ...q, status: 'approved' } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    CompetitorM.find(q).select('name url kind'), RawItemM.countDocuments(q), SignalM.find(q).sort({ score: -1 }).limit(8),
    CrawlLogM.countDocuments(q), BriefM.find(q).sort({ createdAt: -1 }), AuditReportM.countDocuments(q), StackChangeM.countDocuments(q), JobRunM.find(q).sort({ startedAt: -1 }).limit(10).select('type status trigger error startedAt'),
  ]);
  totalRecords += raw;
  out.push(`## ${c.name} (${c.url})`, `- Approved sources: **${approved}** (${byCat.map((x) => `${x._id}: ${x.n}`).join(', ')})`, `- Competitors: **${comps.length}** (${comps.map((x) => x.name).join(', ')})`,
    `- Collected intelligence records: **${raw}**, signals: **${await SignalM.countDocuments(q)}**, crawl log entries: **${crawls}**`, `- Briefs: **${briefs.length}**, audits: **${audits}**, stack-change reassessments: **${changes}**`, '', '### Top signals (with evidence links)');
  sigs.forEach((s) => out.push(`- [${s.category}] **${s.headline}** (score ${s.score}, ${s.verification}) <${s.sourceUrl}>  \n  evidence: "${s.evidenceSnippet}" ${s.evidenceVerified ? '✓ verbatim' : '⚠ unverified'}`));
  out.push('', '### Recent jobs', ...jobs.map((j) => `- ${j.startedAt.toISOString()} ${j.type} (${j.trigger}) → ${j.status}${j.error ? ': ' + j.error : ''}`), '');
  const slug = c.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
  briefs.forEach((b, i) => fs.writeFileSync(path.join(reports, `${slug}-${b.weekKey}${i ? '-' + (briefs.length - i) : ''}.md`), b.markdown || ''));
}
out.push(`**Total collected intelligence records across companies: ${totalRecords}** (target ≥ 30)`);
fs.writeFileSync(path.resolve('../docs/TEST_EVIDENCE_GENERATED.md'), out.join('\n'));
console.log(out.join('\n'));
await mongoose.disconnect();
