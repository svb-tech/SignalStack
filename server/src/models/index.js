import mongoose from 'mongoose';
const { Schema, Types } = mongoose;
const M = Schema.Types.Mixed;
const ref = (name) => ({ type: Schema.Types.ObjectId, ref: name, index: true });

export const PROFILE_ARRAYS = ['businessLines', 'revenueStreams', 'customerSegments', 'highValueSegments', 'customerProblems', 'unmetNeeds', 'whyCustomersChoose', 'competitorsNamed', 'marketChanges', 'materialRisks', 'growthPriorities', 'internalInfo', 'decisionsToSupport', 'keywords'];
export const PROFILE_STRINGS = ['oneLiner', 'positioning', 'industry', 'geographies', 'notes'];

const QA = new Schema({
  n: Number,
  area: String,
  topicId: { type: String, default: '' },
  informationObjective: { type: String, default: '' },
  question: String,
  why: String,
  answer: { type: String, default: '' },
  skipped: { type: Boolean, default: false },
  followUpOf: { type: Number, default: null },
  askedAt: { type: Date, default: Date.now },
  answeredAt: Date,
});

const User = new Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  name: { type: String, default: '' },
  passwordHash: { type: String, required: true },
}, { timestamps: true });

const Company = new Schema({
  owner: ref('User'),
  name: { type: String, required: true }, url: { type: String, required: true }, domain: String,
  status: { type: String, default: 'created' }, // created|researched|interviewing|profiled|stack_built
  research: {
    summary: String, industry: String, products: [String], customerSegments: [String], positioning: String, geographies: [String],
    facts: [{ claim: String, sourceUrl: String, evidenceSnippet: String }],
    assumptions: [{ claim: String, rationale: String }],
    unknowns: [String], pages: [{ url: String, title: String, via: String }], limitations: [String], researchedAt: Date,
  },
  profile: { type: M, default: {} },
  profileHistory: [{ at: Date, by: String, profile: M }],
  profileDirty: { type: Boolean, default: false },
  interview: { status: { type: String, default: 'not_started' }, maxQuestions: { type: Number, default: 10 }, qa: [QA] },
  settings: {
    timezone: { type: String, default: 'Asia/Kolkata' },
    brief: { enabled: { type: Boolean, default: true }, day: { type: Number, default: 1 }, time: { type: String, default: '08:00' }, lookbackDays: { type: Number, default: 7 }, emailTo: { type: String, default: '' } },
    monitoring: { enabled: { type: Boolean, default: true }, everyHours: { type: Number, default: 24 }, sourceRefreshHours: { type: Number, default: 20 } },
    audit: { enabled: { type: Boolean, default: true }, dayOfMonth: { type: Number, default: 1 }, time: { type: String, default: '07:00' } },
    autoApproveDiscovered: { type: Boolean, default: true },
  },
}, { timestamps: true });

const Source = new Schema({
  company: ref('Company'), key: { type: String, index: true },
  category: { type: String, enum: ['customers', 'competitors', 'market', 'internal'], index: true },
  type: { type: String }, // rss|webpage|listing|google_news|hn|stackexchange|reddit|web_search|upload
  name: String, url: String, query: String, meta: { type: M, default: {} },
  competitor: String, topic: String,
  reason: String, scoreNotes: String,
  scores: { specific: Number, recent: Number, credible: Number, overall: Number },
  status: { type: String, default: 'suggested', index: true }, // suggested|approved|rejected|removed|dead|blocked|deprecated
  origin: { type: String, default: 'discovered' }, // discovered|manual|audit|reassess
  relevance: { current: { type: Number, default: null }, previous: { type: Number, default: null }, trend: { type: String, default: 'new' } },
  health: {
    lastCheckedAt: Date, lastOkAt: Date, lastNewContentAt: Date, consecutiveFailures: { type: Number, default: 0 },
    lastError: String, lastStatus: Number, items30d: { type: Number, default: 0 }, signals30d: { type: Number, default: 0 }, totalChecks: { type: Number, default: 0 },
  },
  contentHash: String, lastText: String, seenLinks: [String], note: String,
}, { timestamps: true });
Source.index({ company: 1, key: 1 }, { unique: true });

const RawItem = new Schema({
  company: ref('Company'), source: ref('Source'), category: String, competitor: String,
  url: String, canonicalUrl: { type: String, index: true }, title: String, content: String,
  publishedAt: Date, discoveredAt: { type: Date, default: Date.now, index: true },
  contentHash: { type: String, index: true }, titleKey: { type: String, index: true },
  headlineOnly: { type: Boolean, default: false }, kind: { type: String, default: 'article' }, // article|page_change|baseline|post
  status: { type: String, default: 'new', index: true }, // new|analysed|ignored
  analysisNote: String, alsoSeenIn: [{ source: Schema.Types.ObjectId, url: String, domain: String, at: Date }],
}, { timestamps: true });

const Signal = new Schema({
  company: ref('Company'), item: ref('RawItem'), source: ref('Source'),
  category: { type: String, index: true }, competitor: { type: String, index: true },
  headline: String, whatHappened: String, eventDate: Date, publishedAt: Date, discoveredAt: Date,
  sourceName: String, sourceUrl: String, sourceDomain: String, evidenceSnippet: String, evidenceVerified: Boolean,
  customerQuotes: [String], sentiment: String,
  businessArea: String, impactType: { type: String, enum: ['opportunity', 'threat', 'neutral'], default: 'neutral' },
  urgency: { type: String, default: 'low' }, verification: { type: String, index: true }, // corroborated|single_source|unverified|user_generated|internal_data
  whyItMatters: String, interpretation: String, considerations: [String],
  sourceReliability: Number, evidenceStrength: Number, strategicRelevance: Number,
  factors: M, score: { type: Number, index: true }, rankExplanation: String, tags: [String], weekKey: String,
}, { timestamps: true });

const CrawlLog = new Schema({
  company: ref('Company'), source: ref('Source'), sourceName: String, startedAt: Date, durationMs: Number,
  ok: Boolean, httpStatus: Number, itemsFound: Number, newItems: Number, duplicates: Number, error: String, note: String,
});

const Competitor = new Schema({
  company: ref('Company'), name: String, url: String, domain: String, kind: String, why: String, basis: String,
  verified: Boolean, positioning: String, products: [String], pricingNotes: String, targetCustomers: String,
  facts: [{ claim: String, sourceUrl: String, evidenceSnippet: String }], assumptions: [String], pages: M,
}, { timestamps: true });

const Brief = new Schema({
  company: ref('Company'), weekKey: String, periodStart: Date, periodEnd: Date, trigger: String,
  status: { type: String, default: 'ready' }, content: M, markdown: String, html: String, signalIds: [Types.ObjectId], limitations: [String], emailedAt: Date,
}, { timestamps: true,minimize:false });

const Action = new Schema({
  company: ref('Company'), brief: ref('Brief'), title: String, reason: String, owner: String, priority: String,
  status: { type: String, default: 'todo' }, signalIds: [Types.ObjectId], dueDate: Date, note: String,
}, { timestamps: true });

const JobRun = new Schema({
  company: ref('Company'), type: String, trigger: String, status: { type: String, default: 'running', index: true },
  startedAt: { type: Date, default: Date.now }, finishedAt: Date, error: String, stats: M, log: [String],
}, { timestamps: true });

const AuditReport = new Schema({
  company: ref('Company'), summary: String, stats: M,
  findings: [{ type: { type: String }, sourceId: Types.ObjectId, sourceName: String, url: String, detail: String }],
  recommendations: [{ action: String, sourceId: Types.ObjectId, candidate: M, reason: String, state: { type: String, default: 'pending' } }],
}, { timestamps: true });

const InternalDoc = new Schema({
  company: ref('Company'), filename: String, mime: String, kind: String, chars: Number, rows: Number,
  preview: String, analysis: M, limitations: [String],
}, { timestamps: true });

const StackChange = new Schema({
  company: ref('Company'), trigger: String, summary: String,
  changes: [{ type: { type: String }, sourceId: Types.ObjectId, name: String, category: String, reason: String }],
}, { timestamps: true });

const m = (n, s) => mongoose.models[n] || mongoose.model(n, s);
export const UserM = m('User', User);
export const CompanyM = m('Company', Company);
export const SourceM = m('Source', Source);
export const RawItemM = m('RawItem', RawItem);
export const SignalM = m('Signal', Signal);
export const CrawlLogM = m('CrawlLog', CrawlLog);
export const CompetitorM = m('Competitor', Competitor);
export const BriefM = m('Brief', Brief);
export const ActionM = m('Action', Action);
export const JobRunM = m('JobRun', JobRun);
export const AuditReportM = m('AuditReport', AuditReport);
export const InternalDocM = m('InternalDoc', InternalDoc);
export const StackChangeM = m('StackChange', StackChange);
