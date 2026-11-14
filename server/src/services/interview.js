import { z } from 'zod';
import { CompanyM } from '../models/index.js';
import { llmJSON } from '../llm.js';
import { compactProfile, mergeProfile, PROFILE_SHAPE } from './prompts.js';
import { jaccard } from '../util.js';

const MAX_FOLLOWUPS = 4;
const MAX_REGENERATIONS = 3;

// Fixed interview topics: the model may only pick from these. `ask` is the fallback question ({co} = company name).
const topic = (id, area, objective, ask) => ({ id, area, objective, ask });
const TOPICS = [
  topic('revenue', 'business lines & revenue streams', 'Understand business lines, monetization and revenue streams.', 'Which products or services currently contribute most to {co}’s business?'),
  topic('customer_segments', 'highest-value customer segments', 'Identify the most important student/customer cohorts.', 'Which customer groups are currently the most important for {co}’s growth?'),
  topic('customer_pain_points', 'current customer problems & unmet needs', 'Understand customer problems and unmet needs.', 'What are the most common problems customers face before choosing {co}?'),
  topic('differentiation', 'why customers choose us over alternatives', 'Understand why customers choose the company over alternatives.', 'What makes customers choose {co} instead of the alternatives?'),
  topic('competitors', 'important competitors & substitutes', 'Identify important competitors and alternative solutions.', 'Which companies or alternative services do customers most often compare with {co}?'),
  topic('market_changes', 'major industry/market changes', 'Understand important market and industry changes.', 'Which changes in your market are currently affecting {co} the most?'),
  topic('business_risks', 'developments that could materially affect the business', 'Identify developments that could create material business risks.', 'What external developments could create the biggest risks for {co} over the next year?'),
  topic('growth_priorities', 'growth priorities for the next 6-12 months', 'Understand business growth priorities for the next 6–12 months.', 'What are {co}’s most important growth priorities for the next 6–12 months?'),
  topic('internal_intelligence', 'internal business information that should influence decisions', 'Identify internal information useful for business decisions.', 'Which internal data or operational metrics would help identify problems and opportunities at {co}?'),
  topic('decision_priorities', 'decisions the intelligence system should help the founder make', 'Understand which decisions the intelligence system should support.', 'What decisions would you most like the Signal Stack intelligence system to help {co} make?'),
];
const TOPIC_BY_ID = new Map(TOPICS.map((t) => [t.id, t]));

const Step = z.object({
  profilePatch: z.record(z.any()).default({}),
  next: z.object({
    done: z.boolean().default(false),
    type: z.enum(['new', 'followup']).default('new'),
    topicId: z.string().default(''),
    area: z.string().default(''),
    informationObjective: z.string().default(''),
    question: z.string().default(''),
    why: z.string().default(''),
    followUpOf: z.number().nullable().optional(),
  }),
});

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
async function load(id) { const c = await CompanyM.findById(id); if (!c) throw fail('Company not found', 404); return c; }

const isMain = (q) => q.followUpOf == null;
const answeredMain = (qa) => qa.filter((q) => isMain(q) && (q.answer || q.skipped)).length;
const followCount = (qa) => qa.filter((q) => !isMain(q)).length;

// Older records may have no topicId: match them by their area text instead.
function topicIdOf(q) {
  if (TOPIC_BY_ID.has(q.topicId)) return q.topicId;
  const area = String(q.area || '').toLowerCase().trim();
  return TOPICS.find((t) => t.area.toLowerCase() === area)?.id || '';
}
const coveredIds = (qa) => new Set(qa.filter(isMain).map(topicIdOf).filter(Boolean));
const remainingTopics = (qa) => { const covered = coveredIds(qa); return TOPICS.filter((t) => !covered.has(t.id)); };

function history(qa) {
  return qa.map((q) => [
    `Q${q.n}`,
    q.followUpOf != null ? `(follow-up to Q${q.followUpOf})` : '',
    `[topic: ${topicIdOf(q) || q.area || 'unknown'}]`,
    `[area: ${q.area || ''}]`,
    q.question,
    `A: ${q.skipped ? '(SKIPPED - founder marked confidential)' : q.answer || '(unanswered)'}`,
  ].filter(Boolean).join(' ')).join('\n\n') || '(none yet)';
}

// Secondary check only; topic ids are the main guard against repeated questions.
const isDuplicate = (question, qa) => qa.some((old) => old.question && jaccard(old.question.toLowerCase(), question.toLowerCase()) > 0.7);

function isValid(next, qa, remaining) {
  if (next.done || !next.question?.trim() || isDuplicate(next.question, qa)) return false;
  if (next.type === 'followup') {
    const parent = qa.find((q) => q.n === next.followUpOf);
    return !!parent && isMain(parent) && !parent.skipped && followCount(qa) < MAX_FOLLOWUPS;
  }
  return remaining.some((t) => t.id === next.topicId); // new questions must use an uncovered topic
}

function generateStep(company, lastAnswered, previousFailure) {
  const qa = company.interview.qa;
  const remainingText = remainingTopics(qa).map((t) => `- topicId: ${t.id}\n  area: ${t.area}\n  objective: ${t.objective}`).join('\n');
  const prompt = `
You are conducting a founder interview for a company intelligence
and competitive intelligence system.

COMPANY:
${company.name}

COMPANY RESEARCH:
${compactProfile(company)}

Unverified research assumptions:
${(company.research?.assumptions || []).slice(0, 6).map((a) => a.claim).join(' | ')}

Research unknowns:
${(company.research?.unknowns || []).join(' | ')}

INTERVIEW PROGRESS:
${answeredMain(qa)} of ${company.interview.maxQuestions} main questions answered.

PREVIOUS QUESTIONS AND ANSWERS:
${history(qa)}

AVAILABLE TOPICS NOT YET COVERED:
${remainingText}

${previousFailure ? `PREVIOUS GENERATION WAS REJECTED:\n${previousFailure}\nGenerate a genuinely different question.` : ''}

TASK 1: PROFILE PATCH

Update the company profile using ONLY the latest founder answer.

Latest answer:
${lastAnswered ? (lastAnswered.skipped ? '(Founder skipped this question)' : lastAnswered.answer) : '(No answer yet)'}

Use this profile shape:
${PROFILE_SHAPE}

Do not invent information. Return an empty object if the answer
was skipped or does not provide useful profile information.

TASK 2: NEXT QUESTION

Ask exactly ONE question.

Rules:

1. For a new question, choose ONLY one topicId from the
   AVAILABLE TOPICS NOT YET COVERED list.

2. Never choose a topic that has already been covered.

3. Read all previous questions and answers. Do not ask a question
   that seeks substantially the same information as an earlier
   question, even if the wording is different.

4. Do not repeat revenue questions, customer-segment questions,
   or customer-pain-point questions once their topic is covered.

5. A follow-up is allowed only if the latest answer is vague,
   ambiguous, incomplete, or introduces an important detail
   that needs clarification.

6. Follow-ups must use type "followup" and set followUpOf to
   the question number being clarified.

7. Follow-ups do not count as a new topic.

8. Ask company-specific, conversational questions that can be
   answered in 1-4 sentences.

9. Do not ask for confidential financial figures or private data.
   The founder must be able to skip confidential questions.

10. "why" must explain in one sentence why this information
    matters to the intelligence system.

For a new question, return the exact topicId and area from
the available topic list.

Return JSON in this exact shape:

{
  "profilePatch": {},
  "next": {
    "done": false,
    "type": "new",
    "topicId": "growth_priorities",
    "area": "growth priorities for the next 6-12 months",
    "informationObjective": "Understand business growth priorities",
    "question": "Your question here?",
    "why": "Why this information matters.",
    "followUpOf": null
  }
}
`;
  return llmJSON({ prompt, schema: Step, temperature: 0.3 });
}

/** Asks the model for the next question, retrying when it repeats a topic; falls back to a fixed question. */
async function step(company, lastAnswered) {
  const qa = company.interview.qa;
  const remaining = remainingTopics(qa);
  if (answeredMain(qa) >= company.interview.maxQuestions || !remaining.length) return { profilePatch: {}, next: { done: true } };

  let profilePatch = {}, failure = '';
  for (let attempt = 0; attempt < MAX_REGENERATIONS; attempt++) {
    const out = await generateStep(company, lastAnswered, failure);
    profilePatch = out.profilePatch || {};
    if (out.next.done || isValid(out.next, qa, remaining)) return out;
    failure = `The generated question was invalid, duplicated, or selected an already-covered topic. Available topic IDs: ${remaining.map((t) => t.id).join(', ')}. Previously covered topic IDs: ${[...coveredIds(qa)].join(', ')}.`;
  }

  // The model kept repeating itself: ask the first uncovered topic rather than ending the interview early.
  const t = remaining[0];
  return {
    profilePatch,
    next: { done: false, type: 'new', topicId: t.id, area: t.area, informationObjective: t.objective, question: t.ask.replace('{co}', company.name), why: `Understanding ${t.objective.toLowerCase()}`, followUpOf: null },
  };
}

/** Stores the next question on the company (or marks the interview complete). Returns the new question. */
function applyNext(company, next) {
  const qa = company.interview.qa;
  if (next.done || !next.question) {
    company.interview.status = 'complete';
    if (company.status !== 'stack_built') company.status = 'profiled';
    return null;
  }

  const isFollowUp = next.type === 'followup' && next.followUpOf != null && followCount(qa) < MAX_FOLLOWUPS;
  const t = isFollowUp ? null : TOPIC_BY_ID.get(next.topicId);
  if (!isFollowUp && !t) throw new Error(`Invalid interview topic: ${next.topicId}`);

  qa.push({
    n: qa.length + 1,
    area: isFollowUp ? next.area || 'follow-up' : t.area,
    topicId: isFollowUp ? topicIdOf(qa.find((q) => q.n === next.followUpOf) || {}) : t.id,
    informationObjective: next.informationObjective || (isFollowUp ? 'Clarify a previous answer' : t.objective),
    question: next.question,
    why: next.why,
    followUpOf: isFollowUp ? next.followUpOf : null,
  });

  company.interview.status = 'in_progress';
  if (company.status === 'researched' || company.status === 'created') company.status = 'interviewing';
  return qa[qa.length - 1];
}

export async function startInterview(companyId) {
  const c = await load(companyId);
  if (c.interview.qa.length) return c;
  applyNext(c, (await step(c, null)).next);
  await c.save();
  return c;
}

export async function answerQuestion(companyId, { answer, skip }) {
  const c = await load(companyId);
  const open = c.interview.qa.find((q) => !q.answer && !q.skipped);
  if (!open) throw fail('No open question');
  if (!skip && !String(answer || '').trim()) throw fail('Answer is empty (or skip the question)');

  open.skipped = !!skip;
  open.answer = skip ? '' : String(answer).trim();
  open.answeredAt = new Date();

  const out = await step(c, open);
  c.profile = mergeProfile(c.profile, out.profilePatch);
  c.markModified('profile');
  applyNext(c, out.next);
  if (c.interview.status === 'complete') c.profileDirty = false;
  await c.save();
  return c;
}

/** Founder edits an earlier answer: rebuild the profile from research + current answers. */
export async function editAnswer(companyId, qaId, answer) {
  const c = await load(companyId);
  const q = c.interview.qa.id(qaId);
  if (!q) throw fail('Question not found', 404);
  q.answer = String(answer || '').trim();
  q.skipped = !q.answer;
  q.answeredAt = new Date();
  await c.save();
  return rebuildProfile(companyId, 'interview-edit');
}

export async function rebuildProfile(companyId, by = 'rebuild') {
  const c = await load(companyId);
  c.profileHistory.push({ at: new Date(), by, profile: c.profile });
  const r = c.research || {};

  const out = await llmJSON({
    prompt: `
Rebuild the company intelligence profile from public
research and the founder's CURRENT interview answers.

Founder answers override older assumptions.

Research:
${r.summary || ''}

Products:
${(r.products || []).join(', ')}

Segments:
${(r.customerSegments || []).join(', ')}

Verified facts:
${(r.facts || []).map((f) => f.claim).join(' | ')}

INTERVIEW:
${history(c.interview.qa.filter((q) => q.answer))}

Return JSON matching this profile shape:
${PROFILE_SHAPE}

Keep keywords as 8-15 specific monitoring phrases.
Do not invent facts.
`,
    schema: z.record(z.any()),
  });

  c.profile = { ...mergeProfile({}, out), ...(c.profile?.notes ? { notes: c.profile.notes } : {}) };
  c.markModified('profile');
  c.profileDirty = true;
  await c.save();
  return c;
}
