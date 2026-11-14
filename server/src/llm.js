import { cfg } from './config.js';
import { sleep } from './util.js';

class LLMUnavailable extends Error {}

const GROQ_URL = 'https://api.groq.com/openai/v1/chat/completions';
const MAX_RETRIES = 3;
const MAX_SCHEMA_ATTEMPTS = 2;
const TOKEN_BUDGETS = [2048, 4096, 8192]; // raised when the model cannot finish its JSON

// One request at a time, spaced to the configured requests-per-minute; a 429 pushes everything back.
let nextRequestAt = 0;
let blockedUntil = 0;
let queue = Promise.resolve();

function throttle() {
  const intervalMs = 60000 / Math.max(1, Number(cfg.groq.rpm) || 5);
  const turn = queue.then(async () => {
    const wait = Math.max(nextRequestAt, blockedUntil) - Date.now();
    if (wait > 0) await sleep(wait);
    nextRequestAt = Date.now() + intervalMs;
  });
  queue = turn.catch(() => {}); // keep the queue alive if one waiter fails
  return turn;
}

const cooldown = (ms) => { blockedUntil = Math.max(blockedUntil, Date.now() + Math.max(1000, Math.min(120000, Number(ms) || 1000))); };

const SYSTEM = `
You are a rigorous business intelligence analyst.

Rules:
1. Use supplied material and general industry knowledge only.
2. Clearly label assumptions.
3. Never invent facts, dates, quotes, prices or URLs.
4. If evidence is missing, explicitly say so.
5. Separate verified facts from interpretation.
6. Follow the requested output schema exactly.
7. Return valid JSON only.
8. Do not use Markdown or code fences.
9. Keep responses concise but complete.
`;

/** Parses "7.66s", "2m59.56s", "30" (seconds) or an HTTP date into milliseconds from now. */
export function durationMs(value) {
  const raw = String(value ?? '').trim();
  if (!raw) return 0;
  const m = raw.match(/^(?:(\d+)m)?(\d+(?:\.\d+)?)s$/i);
  if (m) return ((Number(m[1]) || 0) * 60 + Number(m[2])) * 1000;
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return n * 1000;
  const date = Date.parse(raw);
  return Number.isFinite(date) ? Math.max(0, date - Date.now()) : 0;
}

function retryDelay(response, attempt) {
  const headers = response?.headers;
  const fromHeaders = Math.max(...['retry-after', 'x-ratelimit-reset-requests', 'x-ratelimit-reset-tokens'].map((k) => durationMs(headers?.get(k))));
  if (fromHeaders > 0) return fromHeaders + 250;
  return Math.min(60000, 2000 * 2 ** attempt); // exponential backoff when Groq sends no reset headers
}

function isTokenLimitError(data) {
  const text = [data?.error?.message, data?.error?.failed_generation].join(' ').toLowerCase();
  return data?.error?.code === 'json_validate_failed' && ['max completion tokens', 'token limit', 'maximum length'].some((s) => text.includes(s));
}

const errorMessage = (data) => data?.error?.message || data?.message || JSON.stringify(data);

/** One Groq chat completion in JSON mode. Retries network/429/5xx errors and retries with a bigger token budget if the JSON was cut off. Returns the text. */
async function callGroq({ system, prompt, temperature = 0.3, minTokens = 0 }) {
  if (!cfg.groq.key) throw new LLMUnavailable('GROQ_API_KEY is missing. Configure it in your .env file.');
  const model = cfg.groq.model;
  if (!model) throw new LLMUnavailable('GROQ_MODEL is missing from configuration.');

  const messages = [
    { role: 'system', content: system || SYSTEM },
    { role: 'user', content: `${prompt}\n\nIMPORTANT:\nReturn only valid JSON.\nDo not include Markdown or explanations outside JSON.` },
  ];

  const firstBudget = Math.max(0, TOKEN_BUDGETS.findIndex((b) => b >= minTokens));
  for (let t = firstBudget; t < TOKEN_BUDGETS.length; t++) {
    const budget = TOKEN_BUDGETS[t];
    const canGrow = t < TOKEN_BUDGETS.length - 1;

    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      await throttle();
      const lastTry = attempt === MAX_RETRIES - 1;

      const body = { model, messages, temperature, max_completion_tokens: budget, response_format: { type: 'json_object' }, stream: false };
      if (/^openai\/gpt-oss-/i.test(model)) { body.reasoning_effort = 'low'; body.include_reasoning = false; }

      let response;
      try {
        response = await fetch(GROQ_URL, {
          method: 'POST',
          headers: { Authorization: `Bearer ${cfg.groq.key}`, 'Content-Type': 'application/json' },
          signal: AbortSignal.timeout(90000),
          body: JSON.stringify(body),
        });
      } catch (error) {
        if (lastTry) throw new Error(`Groq network/timeout error: ${error.message}`);
        const delay = Math.min(15000, 1000 * 2 ** attempt);
        console.warn(`[Groq] Network error. Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      let data;
      try { data = await response.json(); } catch { throw new Error(`Groq returned invalid HTTP response. Status: ${response.status}`); }

      if (!response.ok) {
        const msg = String(errorMessage(data));
        const lim = /Limit (\d+), Requested (\d+)/i.exec(msg);
        // Prompt + output budget is bigger than the per-minute token cap: retrying the same request can never work.
        if (response.status === 413 || (lim && +lim[2] > +lim[1])) {
          throw Object.assign(new Error(`Groq request too large for the per-minute token limit: ${msg.slice(0, 250)}`), { tooLarge: true });
        }
        // The model produced invalid JSON in JSON mode. Use what it produced if it is usable, otherwise just try again.
        if (data?.error?.code === 'json_validate_failed' && !isTokenLimitError(data)) {
          const partial = data.error.failed_generation;
          if (partial) { try { JSON.parse(extractJson(partial)); return partial; } catch { /* fall through to retry */ } }
          if (lastTry) throw new Error(`Groq could not produce valid JSON: ${msg.slice(0, 250)}`);
          console.warn(`[Groq] json_validate_failed. Retry ${attempt + 1}/${MAX_RETRIES}`);
          continue;
        }
      }

      if (!response.ok && isTokenLimitError(data)) {
        if (canGrow) { console.warn(`[Groq] JSON token limit reached at ${budget}. Retrying with a larger budget.`); break; }
        throw new Error(`Groq could not complete JSON even with ${budget} completion tokens. Reduce prompt size or use a model with a larger output budget.`);
      }

      if (response.status === 429 || response.status >= 500) {
        if (lastTry) throw new Error(`Groq HTTP ${response.status}: ${errorMessage(data)}`);
        const delay = retryDelay(response, attempt);
        if (response.status === 429) {
          // A long reset means a per-day/hourly quota: waiting inside the job is pointless, so say so right away.
          if (delay > 120000) throw new Error(`Groq rate limit reached (${errorMessage(data)}). It resets in about ${Math.ceil(delay / 60000)} min.`);
          cooldown(delay);
        }
        console.warn(`[Groq] HTTP ${response.status}: ${String(errorMessage(data)).slice(0, 200)}. Retry ${attempt + 1}/${MAX_RETRIES} in ${delay}ms`);
        await sleep(delay);
        continue;
      }

      if (!response.ok) throw new Error(`Groq HTTP ${response.status}: ${errorMessage(data)}`);

      const choice = data.choices?.[0];
      const content = choice?.message?.content || '';
      const finishReason = choice?.finish_reason;
      // Reasoning models can spend the whole budget thinking and return nothing: that is a length problem, not a failure.
      if (finishReason === 'length') {
        if (canGrow) { console.warn(`[Groq] Response truncated at ${budget} tokens. Increasing budget.`); break; }
        throw new Error(`Groq response was truncated at ${budget} tokens.`);
      }
      if (!content.trim()) {
        if (lastTry) throw new Error(`Groq returned empty content. Finish reason: ${finishReason || 'unknown'}`);
        console.warn(`[Groq] Empty content. Retry ${attempt + 1}/${MAX_RETRIES}`);
        continue;
      }
      return content;
    }
  }
  throw new Error('Groq request failed after all token-budget retries.');
}

/** Returns the first complete JSON object/array found in the text (ignores code fences and chatter around it). */
export function extractJson(text) {
  const value = String(text || '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();
  const start = value.search(/[\[{]/);
  if (start === -1) throw new Error('No JSON object or array found.');

  const stack = [];
  let inString = false;
  let escaped = false;

  for (let i = start; i < value.length; i++) {
    const char = value[i];

    if (inString) {
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') inString = true;
    else if (char === '{' || char === '[') stack.push(char);
    else if (char === '}' || char === ']') {
      const opening = stack.pop();
      if ((char === '}' && opening !== '{') || (char === ']' && opening !== '[')) throw new Error('Malformed JSON brackets.');
      if (!stack.length) return value.slice(start, i + 1);
    }
  }
  throw new Error('Incomplete JSON response.');
}

/** Asks the model for JSON and validates it with a Zod schema; one corrective retry on failure. */
export async function llmJSON({ prompt, schema, system, temperature = 0.3, minTokens = 0 }) {
  if (!prompt || !schema) throw new Error('llmJSON requires both prompt and schema.');

  let lastError;
  for (let attempt = 0; attempt < MAX_SCHEMA_ATTEMPTS; attempt++) {
    const currentPrompt = attempt === 0 ? prompt : `${prompt}

Your previous response failed JSON/schema validation.

Validation error:
${String(lastError?.message || '').slice(0, 600)}

Correct the response and return ONLY valid JSON matching the requested schema.
Keep the output concise. Do not repeat explanations.`;

    const content = await callGroq({ system, prompt: currentPrompt, temperature, minTokens });
    try {
      return await schema.parseAsync(JSON.parse(extractJson(content)));
    } catch (error) {
      lastError = error;
      console.warn(`[Groq] JSON/schema validation failed on attempt ${attempt + 1}: ${String(error.message).slice(0, 300)}`);
    }
  }
  throw new Error(`Groq output failed JSON/schema validation after ${MAX_SCHEMA_ATTEMPTS} attempts: ${lastError?.message}`);
}
