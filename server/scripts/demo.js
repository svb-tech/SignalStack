// Headless end-to-end run of the full workflow for one company.
// Usage: node scripts/demo.js "MeetUniversity" https://www.meetuniversity.com [demo/answers.json] [--skip-interview]
// Without an answers file the interview is asked interactively in the terminal (answer for real, or press Enter to skip).
import mongoose from 'mongoose';
import readline from 'node:readline/promises';
import fs from 'node:fs';
import { cfg } from '../src/config.js';
import { CompanyM, SourceM, SignalM, RawItemM, CompetitorM } from '../src/models/index.js';
import { ensureUrl, domainOf } from '../src/util.js';
import { researchCompany } from '../src/services/research.js';
import { startInterview, answerQuestion } from '../src/services/interview.js';
import { buildSignalStack } from '../src/services/stack.js';
import { weeklyPipeline } from '../src/services/pipeline.js';
import { schedule } from '../src/services/scheduler.js';

const [name, url, answersFile] = process.argv.slice(2).filter((a) => !a.startsWith('--'));
if (!name || !url) { console.error('Usage: node scripts/demo.js "<Company>" <url> [answers.json]'); process.exit(1); }
const log = (m) => console.log('  ' + m);
const step = (m) => console.log(`\n=== ${m}`);

await mongoose.connect(cfg.mongo);
let c = await CompanyM.findOne({ name, domain: domainOf(ensureUrl(url)) });
if (!c) c = await CompanyM.create({ name, url: ensureUrl(url), domain: domainOf(ensureUrl(url)) });
console.log(`Company ${c.name} (${c._id})`);

step('1-3. Research website & public information → initial profile');
await researchCompany(c._id, log);

if (!process.argv.includes('--skip-interview')) {
  step('4. Adaptive 10-question interview');
  const answers = answersFile && fs.existsSync(answersFile) ? JSON.parse(fs.readFileSync(answersFile, 'utf8')) : null;
  const rl = answers ? null : readline.createInterface({ input: process.stdin, output: process.stdout });
  c = await startInterview(c._id);
  while (c.interview.status !== 'complete') {
    const q = c.interview.qa.find((x) => !x.answer && !x.skipped);
    console.log(`\nQ${q.n} [${q.area}] ${q.question}\n   (why: ${q.why})`);
    let a = answers ? answers[String(q.n)] ?? answers[q.area] ?? '' : await rl.question('> ');
    if (answers) console.log('> ' + (a || '(skipped)'));
    c = await answerQuestion(c._id, a.trim() ? { answer: a } : { skip: true });
  }
  rl?.close();
}

step('5-8. Build Signal Stack (competitors, customer/market sources, justification)');
await buildSignalStack(c._id, log);
await SourceM.updateMany({ company: c._id, status: 'suggested' }, { status: 'approved' });
await schedule(c._id);

step('9-12. Crawl → extract/classify → rank → Monday brief');
const res = await weeklyPipeline(c._id, { trigger: 'manual', force: true, lookbackDays: 45, log });
const [src, comp, raw, sig] = await Promise.all([SourceM.countDocuments({ company: c._id, status: 'approved' }), CompetitorM.countDocuments({ company: c._id }), RawItemM.countDocuments({ company: c._id }), SignalM.countDocuments({ company: c._id })]);
console.log(`\nDONE: ${src} approved sources, ${comp} competitors, ${raw} collected records, ${sig} signals, brief ${res.briefId}`);
await mongoose.disconnect();
