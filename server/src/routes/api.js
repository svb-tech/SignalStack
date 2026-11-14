import express from 'express';
import mongoose from 'mongoose';
import multer from 'multer';
import {
  CompanyM, SourceM, RawItemM, SignalM, CrawlLogM, CompetitorM, BriefM, ActionM, JobRunM, AuditReportM, InternalDocM, StackChangeM,
} from '../models/index.js';
import { ensureUrl, domainOf, istDayStart, istDayEnd, IST } from '../util.js';
import { authRouter, requireAuth } from '../auth.js';
import { startJob } from '../services/jobs.js';
import { researchCompany } from '../services/research.js';
import { startInterview, answerQuestion, editAnswer, rebuildProfile } from '../services/interview.js';
import { buildSignalStack, reassessStack, addManualSource } from '../services/stack.js';
import { checkSource } from '../services/monitor.js';
import { analyseNewItems } from '../services/analysis.js';
import { ingestUpload } from '../services/internal.js';
import { emailBrief } from '../services/brief.js';
import { weeklyPipeline, monitoringPipeline } from '../services/pipeline.js';
import { applyRecommendation } from '../services/audit.js';
import { schedule, jobFns, scheduleInfo, unschedule } from '../services/scheduler.js';

const r = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024 } });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const notFound = (x) => { if (!x) throw Object.assign(new Error('Not found'), { status: 404 }); return x; };

r.get('/health', (_q, res) => res.json({ ok: true, time: new Date() }));
r.use('/auth', authRouter);
r.use(requireAuth); // everything below needs a valid JWT

// Ownership: a company, and anything that belongs to one, is reachable only by its owner (404 otherwise, so ids don't leak).
const guard = (check) => async (q, _res, next, val) => { try { await check(q, val); next(); } catch (e) { next(e); } };
const owns = (q, companyId) => CompanyM.exists({ _id: companyId, owner: q.userId });
const deny = () => Object.assign(new Error('Not found'), { status: 404 });
r.param('id', guard(async (q, id) => { if (!(await owns(q, id))) throw deny(); }));
const viaCompany = (Model) => guard(async (q, id) => { const d = await Model.findById(id).select('company'); if (!d || !(await owns(q, d.company))) throw deny(); });
[['sid', SourceM], ['bid', BriefM], ['aid', ActionM], ['jid', JobRunM], ['did', InternalDocM], ['audId', AuditReportM]].forEach(([p, M]) => r.param(p, viaCompany(M)));

// ---------------------------------------------------------------- companies
r.get('/companies', h(async (q, res) => res.json(await CompanyM.find({ owner: q.userId }).sort({ createdAt: -1 }).select('name url status createdAt'))));
r.post('/companies', h(async (q, res) => {
  const { name, url } = q.body;
  if (!name?.trim() || !url?.trim()) throw Object.assign(new Error('name and url are required'), { status: 400 });
  const u = ensureUrl(url);
  const c = await CompanyM.create({ owner: q.userId, name: name.trim(), url: u, domain: domainOf(u) });
  const run = await startJob('research', c._id, 'manual', (log) => researchCompany(c._id, log));
  res.status(201).json({ company: c, jobId: run._id });
}));
r.get('/companies/:id', h(async (q, res) => res.json(notFound(await CompanyM.findById(q.params.id)))));
r.delete('/companies/:id', h(async (q, res) => {
  const id = q.params.id; unschedule(id);
  await Promise.all([SourceM, RawItemM, SignalM, CrawlLogM, CompetitorM, BriefM, ActionM, JobRunM, AuditReportM, InternalDocM, StackChangeM].map((M) => M.deleteMany({ company: id })));
  await CompanyM.deleteOne({ _id: id });
  res.json({ ok: true });
}));
r.post('/companies/:id/research', h(async (q, res) => { const run = await startJob('research', q.params.id, 'manual', (log) => researchCompany(q.params.id, log)); res.json({ jobId: run._id }); }));

// profile (view/edit); changing it flags the stack for reassessment
r.put('/companies/:id/profile', h(async (q, res) => {
  const c = notFound(await CompanyM.findById(q.params.id));
  c.profileHistory.push({ at: new Date(), by: 'manual-edit', profile: c.profile });
  c.profile = q.body.profile || {};
  c.markModified('profile');
  c.profileDirty = true;
  await c.save();
  res.json(c);
}));
r.post('/companies/:id/profile/rebuild', h(async (q, res) => res.json(await rebuildProfile(q.params.id, 'rebuild'))));
r.put('/companies/:id/settings', h(async (q, res) => {
  const c = notFound(await CompanyM.findById(q.params.id));
  const s = q.body;
  const merge = (k) => s[k] && Object.assign(c.settings[k], s[k]);
  ['brief', 'monitoring', 'audit'].forEach(merge);
  if (s.timezone) c.settings.timezone = s.timezone;
  if (typeof s.autoApproveDiscovered === 'boolean') c.settings.autoApproveDiscovered = s.autoApproveDiscovered;
  await c.save();
  if (c.status === 'stack_built') await schedule(c);
  res.json(c);
}));

// ---------------------------------------------------------------- interview
r.post('/companies/:id/interview/start', h(async (q, res) => res.json(await startInterview(q.params.id))));
r.post('/companies/:id/interview/answer', h(async (q, res) => res.json(await answerQuestion(q.params.id, q.body))));
r.put('/companies/:id/interview/qa/:qid', h(async (q, res) => res.json(await editAnswer(q.params.id, q.params.qid, q.body.answer))));

// ---------------------------------------------------------------- stack + sources
r.get('/companies/:id/stack', h(async (q, res) => {
  const id = q.params.id;
  const [sources, competitors, changes] = await Promise.all([SourceM.find({ company: id, status: { $ne: 'removed' } }).sort({ 'scores.overall': -1 }), CompetitorM.find({ company: id }), StackChangeM.find({ company: id }).sort({ createdAt: -1 }).limit(10)]);
  res.json({ sources, competitors, changes });
}));
r.post('/companies/:id/stack/build', h(async (q, res) => { const run = await startJob('discovery', q.params.id, 'manual', async (log) => { const s = await buildSignalStack(q.params.id, log); await schedule(q.params.id); return s; }); res.json({ jobId: run._id }); }));
r.post('/companies/:id/stack/reassess', h(async (q, res) => {
  const c = notFound(await CompanyM.findById(q.params.id));
  const prev = c.profileHistory.length ? c.profileHistory[c.profileHistory.length - 1].profile : null;
  const run = await startJob('reassess', q.params.id, 'manual', (log) => reassessStack(q.params.id, { previousProfile: prev, log }));
  res.json({ jobId: run._id });
}));
r.delete('/companies/:id/competitors/:cid', h(async (q, res) => {
  const c = notFound(await CompetitorM.findOne({ _id: q.params.cid, company: q.params.id }));
  await SourceM.updateMany({ company: q.params.id, competitor: c.name }, { status: 'removed', note: 'Competitor removed by founder' });
  await c.deleteOne();
  res.json({ ok: true });
}));

r.get('/companies/:id/sources', h(async (q, res) => {
  const f = { company: q.params.id }; if (q.query.category) f.category = q.query.category; if (q.query.status) f.status = q.query.status;
  res.json(await SourceM.find(f).sort({ category: 1, 'scores.overall': -1 }).select('-lastText -seenLinks'));
}));
r.post('/companies/:id/sources', h(async (q, res) => res.status(201).json(await addManualSource(q.params.id, q.body))));
r.post('/companies/:id/sources/approve-suggested', h(async (q, res) => { const x = await SourceM.updateMany({ company: q.params.id, status: 'suggested' }, { status: 'approved' }); res.json({ approved: x.modifiedCount }); }));
r.get('/companies/:id/sources/duplicates', h(async (q, res) => {
  const items = await RawItemM.find({ company: q.params.id, 'alsoSeenIn.0': { $exists: true } }).select('title url source alsoSeenIn').limit(100).populate('source', 'name');
  res.json(items);
}));
r.patch('/sources/:sid', h(async (q, res) => { const s = notFound(await SourceM.findById(q.params.sid)); ['status', 'reason', 'name'].forEach((k) => q.body[k] !== undefined && (s[k] = q.body[k])); await s.save(); res.json(s); }));
r.delete('/sources/:sid', h(async (q, res) => { await SourceM.updateOne({ _id: q.params.sid }, { status: 'removed' }); res.json({ ok: true }); }));
r.post('/sources/:sid/check', h(async (q, res) => {
  const s = notFound(await SourceM.findById(q.params.sid)); const c = await CompanyM.findById(s.company);
  const out = await checkSource(s, c);
  res.json({ ...out, source: s });
}));
r.get('/sources/:sid/logs', h(async (q, res) => res.json(await CrawlLogM.find({ source: q.params.sid }).sort({ startedAt: -1 }).limit(50))));

// ---------------------------------------------------------------- monitoring / analysis / signals
r.post('/companies/:id/monitor', h(async (q, res) => { const run = await startJob('monitoring', q.params.id, 'manual', (log) => monitoringPipeline(q.params.id, { log, force: true })); res.json({ jobId: run._id }); }));
r.post('/companies/:id/analyse', h(async (q, res) => { const run = await startJob('analysis', q.params.id, 'manual', (log) => analyseNewItems(q.params.id, { log })); res.json({ jobId: run._id }); }));
r.get('/companies/:id/signals', h(async (q, res) => {
  const { category, competitor, from, to, minRelevance, impact, verification, urgency, sort = 'score', limit = 200 } = q.query;
  const f = { company: q.params.id };
  if (category) f.category = category; if (competitor) f.competitor = competitor; if (impact) f.impactType = impact; if (verification) f.verification = verification; if (urgency) f.urgency = urgency;
  if (minRelevance) f.strategicRelevance = { $gte: +minRelevance };
  if (from || to) f.discoveredAt = { ...(from && { $gte: istDayStart(from) }), ...(to && { $lte: istDayEnd(to) }) };
  res.json(await SignalM.find(f).sort(sort === 'date' ? { publishedAt: -1, discoveredAt: -1 } : { score: -1 }).limit(+limit));
}));
r.get('/companies/:id/records', h(async (q, res) => res.json(await RawItemM.find({ company: q.params.id }).sort({ discoveredAt: -1 }).limit(200).select('-content').populate('source', 'name category'))));

// ---------------------------------------------------------------- internal uploads
r.post('/companies/:id/internal', upload.single('file'), h(async (q, res) => { if (!q.file) throw Object.assign(new Error('file is required'), { status: 400 }); res.status(201).json(await ingestUpload(q.params.id, q.file)); }));
r.get('/companies/:id/internal', h(async (q, res) => res.json(await InternalDocM.find({ company: q.params.id }).sort({ createdAt: -1 }))));
r.delete('/internal/:did', h(async (q, res) => { const d = notFound(await InternalDocM.findById(q.params.did)); await SignalM.deleteMany({ sourceUrl: `internal://doc/${d._id}` }); await d.deleteOne(); res.json({ ok: true }); }));

// ---------------------------------------------------------------- briefs + actions
r.get('/companies/:id/briefs', h(async (q, res) => res.json(await BriefM.find({ company: q.params.id }).sort({ createdAt: -1 }).select('-html -markdown -content.appendix'))));
r.post('/companies/:id/briefs/generate', h(async (q, res) => {
  const run = await startJob('weekly_brief', q.params.id, 'manual', (log) => weeklyPipeline(q.params.id, { trigger: 'manual', lookbackDays: q.body?.lookbackDays, force: true, log }));
  res.json({ jobId: run._id });
}));
r.get('/briefs/:bid', h(async (q, res) => res.json(notFound(await BriefM.findById(q.params.bid)))));
r.get('/briefs/:bid/export.:fmt', h(async (q, res) => {
  const b = notFound(await BriefM.findById(q.params.bid));
  if (q.params.fmt === 'md') res.type('text/markdown').set('Content-Disposition', `attachment; filename="brief-${b.weekKey}.md"`).send(b.markdown);
  else if (q.params.fmt === 'html') res.type('html').set('Content-Disposition', `attachment; filename="brief-${b.weekKey}.html"`).send(b.html);
  else throw Object.assign(new Error('Use .md or .html'), { status: 400 });
}));
r.post('/briefs/:bid/email', h(async (q, res) => { const b = notFound(await BriefM.findById(q.params.bid)); const c = await CompanyM.findById(b.company); await emailBrief(b, c, q.body.to); res.json({ ok: true }); }));
r.get('/companies/:id/actions', h(async (q, res) => res.json(await ActionM.find({ company: q.params.id }).sort({ createdAt: -1 }).limit(200))));
r.patch('/actions/:aid', h(async (q, res) => { const a = notFound(await ActionM.findById(q.params.aid)); ['status', 'owner', 'note', 'dueDate'].forEach((k) => q.body[k] !== undefined && (a[k] = q.body[k])); await a.save(); res.json(a); }));

// ---------------------------------------------------------------- audits, jobs, stats
r.get('/companies/:id/audits', h(async (q, res) => res.json(await AuditReportM.find({ company: q.params.id }).sort({ createdAt: -1 }).limit(12))));
r.post('/companies/:id/audits/run', h(async (q, res) => { const run = await jobFns(q.params.id).audit('manual'); res.json({ jobId: run._id }); }));
r.post('/audits/:audId/apply', h(async (q, res) => {
  const rep = notFound(await AuditReportM.findById(q.params.audId));
  const idxs = q.body.all ? rep.recommendations.map((_, i) => i) : [q.body.index];
  for (const i of idxs) await applyRecommendation(rep, i);
  if (q.body.dismiss != null && rep.recommendations[q.body.dismiss]) rep.recommendations[q.body.dismiss].state = 'dismissed';
  rep.markModified('recommendations'); await rep.save(); res.json(rep);
}));
r.get('/companies/:id/jobs', h(async (q, res) => res.json(await JobRunM.find({ company: q.params.id }).sort({ startedAt: -1 }).limit(40).select('-log'))));
r.get('/jobs/:jid', h(async (q, res) => res.json(notFound(await JobRunM.findById(q.params.jid)))));
r.get('/companies/:id/stats', h(async (q, res) => {
  const id = q.params.id, oid = new mongoose.Types.ObjectId(id);
  const [sourcesByCat, signalsByCat, records, signals, briefs, competitors, byDay, failed, lastJobs] = await Promise.all([
    SourceM.aggregate([{ $match: { company: oid, status: 'approved' } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    SignalM.aggregate([{ $match: { company: oid } }, { $group: { _id: '$category', n: { $sum: 1 } } }]),
    RawItemM.countDocuments({ company: id }), SignalM.countDocuments({ company: id }), BriefM.countDocuments({ company: id }), CompetitorM.countDocuments({ company: id }),
    SignalM.aggregate([{ $match: { company: oid } }, { $group: { _id: { $dateToString: { format: '%Y-%m-%d', date: '$createdAt', timezone: IST } }, n: { $sum: 1 } } }, { $sort: { _id: 1 } }, { $limit: 60 }]),
    JobRunM.find({ company: id, status: 'failed' }).sort({ startedAt: -1 }).limit(5).select('-log'),
    JobRunM.aggregate([{ $match: { company: oid } }, { $sort: { startedAt: -1 } }, { $group: { _id: '$type', last: { $first: '$$ROOT' } } }]),
  ]);
  const health = await SourceM.aggregate([{ $match: { company: oid, status: { $in: ['approved', 'blocked', 'dead'] } } }, { $group: { _id: { $cond: [{ $gte: ['$health.consecutiveFailures', 3] }, 'failing', { $cond: [{ $gt: ['$health.consecutiveFailures', 0] }, 'degraded', 'healthy'] }] }, n: { $sum: 1 } } }]);
  res.json({ sourcesByCat, signalsByCat, records, signals, briefs, competitors, byDay, failedJobs: failed, health, lastJobs: lastJobs.map((x) => ({ type: x._id, status: x.last.status, at: x.last.startedAt, error: x.last.error })), schedule: scheduleInfo(id) });
}));

export default r;
