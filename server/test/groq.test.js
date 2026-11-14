import test from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

process.env.GROQ_API_KEY = 'test'; process.env.GROQ_RPM = '60000';
const { llmJSON } = await import('../src/llm.js');
const { B } = await import('../src/services/brief.js');

const ok = (content, finish = 'stop') => ({ ok: true, status: 200, headers: new Headers(), json: async () => ({ choices: [{ message: { content }, finish_reason: finish }] }) });
const err = (status, error) => ({ ok: false, status, headers: new Headers(), json: async () => ({ error }) });
const mock = (...replies) => { const calls = []; global.fetch = async (_u, o) => { calls.push(JSON.parse(o.body)); return replies[Math.min(calls.length - 1, replies.length - 1)]; }; return calls; };
const S = z.object({ a: z.number() });

test('reasoning model with empty content + finish=length grows the token budget instead of failing', async () => {
  const calls = mock(ok('', 'length'), ok('{"a":1}'));
  assert.deepEqual(await llmJSON({ prompt: 'x', schema: S }), { a: 1 });
  assert.equal(calls[1].max_completion_tokens, 4096);
});

test('json_validate_failed with usable failed_generation is salvaged', async () => {
  mock(err(400, { code: 'json_validate_failed', message: 'bad json', failed_generation: 'Sure: {"a":2} done' }));
  assert.deepEqual(await llmJSON({ prompt: 'x', schema: S }), { a: 2 });
});

test('json_validate_failed without usable output is retried', async () => {
  const calls = mock(err(400, { code: 'json_validate_failed', message: 'bad json' }), ok('{"a":3}'));
  assert.deepEqual(await llmJSON({ prompt: 'x', schema: S }), { a: 3 });
  assert.equal(calls.length, 2);
});

test('empty content (finish=stop) is retried', async () => {
  mock(ok('', 'stop'), ok('{"a":4}'));
  assert.deepEqual(await llmJSON({ prompt: 'x', schema: S }), { a: 4 });
});

test('request over the per-minute token cap is reported as tooLarge, not retried', async () => {
  const calls = mock(err(413, { message: 'Request too large ... tokens per minute (TPM): Limit 8000, Requested 12000' }));
  await assert.rejects(() => llmJSON({ prompt: 'x', schema: S }), (e) => e.tooLarge === true);
  assert.equal(calls.length, 1);
});

test('minTokens skips the small budget', async () => {
  const calls = mock(ok('{"a":5}'));
  await llmJSON({ prompt: 'x', schema: S, minTokens: 4096 });
  assert.equal(calls[0].max_completion_tokens, 4096);
});

test('brief schema survives sloppy model output and drops only the bad item', () => {
  const out = B.parse({
    executiveSummary: [{ headline: 'H', whyItMatters: ['a', 'b'], signals: 'S1, S2' }, 'garbage', { headline: 5, signals: [3] }],
    customers: null,
    opportunities: { title: 'T', impact: { x: 'y' }, nextStep: 7, priority: 'high', signals: ['s4', { id: 'S5' }] },
    risks: 'nope',
  });
  assert.equal(out.executiveSummary.length, 2); // the 'garbage' item is dropped, the rest kept
  assert.deepEqual(out.executiveSummary[0].signals, ['S1', 'S2']);
  assert.equal(out.executiveSummary[0].whyItMatters, 'a; b');
  assert.deepEqual(out.executiveSummary[1].signals, ['S3']);
  assert.equal(out.customers.length, 0);
  assert.deepEqual(out.opportunities[0].signals, ['S4', 'S5']);
  assert.equal(out.opportunities[0].nextStep, '7');
  assert.equal(out.risks.length, 0);
});
