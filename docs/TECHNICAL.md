# Technical documentation (≈5 pages)

## 1. Architecture
```
React SPA ──REST──▶ Express API ──▶ MongoDB
                      │
   ┌──────────────────┼────────────────────────────────────────┐
   │ research → interview → stack discovery → monitor → analysis → ranking → brief
   │                          ▲ audit (monthly)    ▲ node-cron schedules + manual triggers
   └──────────── JobRun log (every run, incl. failures) ─────────┘
LLM: Groq free tier (JSON mode + Zod validation + retry)   Crawler: fetch + cheerio + robots-parser
```
Why this shape: a single Node process keeps free hosting trivial; MongoDB suits heterogeneous evidence documents; long operations run as background `JobRun`s the UI polls, so nothing blocks on slow crawls or rate-limited LLM calls. Redis/BullMQ was deliberately skipped (optional in the brief) — durability comes from Mongo job records and boot-time recovery.

Collections: `Company` (research, profile + history, interview Q&A, settings) · `Source` (category, type, reason, scores, health, relevance trend, status) · `RawItem` (every collected record, hashes, `alsoSeenIn`) · `Signal` (analysed development) · `CrawlLog` (history per source) · `Competitor` · `Brief` · `Action` · `JobRun` · `AuditReport` · `InternalDoc` · `StackChange`.

## 2. Company understanding & interview
`research.js` fetches the homepage and up to five relevant internal pages (about/product/pricing/customers/blog…) under robots rules, adds web-search and news snippets, and asks the LLM for facts + assumptions. **Facts must carry a verbatim quote; the server checks the quote exists in the fetched text of the cited URL, otherwise the claim is demoted to "assumption".**

`interview.js` makes one LLM call per turn that (a) patches the structured profile from the last answer and (b) produces the next question. Inputs: research, profile, full Q&A history, the ten required areas not yet covered. Rules: one question at a time, ≤4 follow-ups (only when the last answer was vague/opened a thread), 10 main questions, similarity check (Jaccard > 0.7) against earlier questions with one forced regeneration, skip = confidential (recorded, never re-asked). Answers can be edited later; the profile is rebuilt from research + current answers and the stack is flagged for reassessment. Questions differ per company because they are generated from that company's research and answers — there is no question list in the code except the *area names* from the assignment.

## 3. Source discovery (no hard-coded competitors or sources)
1. **Competitors**: web-search results ("alternatives to X", "X competitors", keyword-based) + founder-named competitors are given to the LLM as grounding; it proposes 6–10 direct/substitute competitors with homepage URLs. **Each URL is fetched and must resolve and be robots-allowed or the competitor is dropped.** Profiles are produced from homepage text with quote-verified facts vs assumptions.
2. **Competitor sources are derived from each verified site**: RSS feed (from `<link rel=alternate>`) or blog listing, pricing page (change detection), careers page (hiring), Google News query, review/complaint web search — each with a company-specific reason.
3. **Customer & market sources**: the LLM plans customer-voice queries (written as the problem, not the brand) across HN, StackExchange, Reddit API, web search, and market topics (regulatory, industry, economic, technology, country) as Google-News queries plus official regulator/association URLs it is confident exist.
4. **Validation probe for every candidate**: fetch / run the query, parse items, find newest date, verify robots. Failed candidates are stored as `rejected` with the reason. Scores: *specific* = keyword overlap of the sampled content with the company's problem-space (deterministic), *recent* = age of newest item (half-life style buckets), *credible* = domain-class reliability (gov/edu/official/news/UGC); overall = 0.4/0.3/0.3. Auto-approval threshold 0.45 (configurable on/off) — otherwise `suggested` for human approval.

## 4. Crawling & monitoring
Collectors per type: `rss`, `webpage` (content-hash + line-diff change detection; first visit stores a baseline record), `listing` (finds new same-site article links, fetches only unseen ones), `google_news`, `hn`, `stackexchange`, `reddit`, `web_search`. Pipeline per source: collect → short items enriched with full article text (robots permitting) → de-duplication by canonical URL, content hash and normalised title → store `RawItem` + `CrawlLog` → update health (failures, last OK, new-content time). Cross-source duplicates are stored once, and the other sources are appended to `alsoSeenIn` (shown in Source Manager; also used as corroboration). Items older than 45 days are kept as history but not analysed. Concurrency 4 across hosts, serialised per host with a reservation-slot rate limiter.

## 5. Analysis & ranking
`analysis.js` sends batches of 5 items with the company profile to the LLM. For each: significant or not (with ignore reason), category, competitor, factual `whatHappened`, event date only if stated, business area, opportunity/threat/neutral, urgency, relevance/impact 0–10, a **verbatim evidence snippet**, customer quotes, and separately `interpretation`/`whyItMatters`/`considerations`.

Server-side verification (the LLM is not trusted): snippet and quotes must appear in the item text (`evidenceVerified`); corroboration counts distinct other domains carrying a near-identical headline; user-generated sources are labelled `user_generated` and never `corroborated` by themselves. **Three separate measures are stored**: `sourceReliability` (domain class), `evidenceStrength` (verbatim-verified 0.4 + corroboration ≤0.3 + dated 0.1 + not headline-only 0.1 + primary source 0.1), `strategicRelevance` (0.6 relevance + 0.4 impact). No AI "confidence" is used as proof.

Rank score (0–100) = 25% relevance + 25% impact + 15% urgency + 15% credibility (mean of reliability and evidence strength) + 10% recency (14-day half-life) + 10% novelty (1 − max Jaccard similarity to signals from the last 60 days). Each signal stores `factors` and a plain-language `rankExplanation` (strongest drivers, weak factors).

## 6. Monday brief
The top 45 signals of the look-back window are given IDs S1…Sn. The LLM writes implications only and must cite IDs. **The server then grounds every item**: invalid/missing citations drop the item; the displayed "verified facts" are copied from the cited signals (`whatHappened`, source link, date, verification) — the LLM cannot alter them; interpretation is rendered in a visually separate block. Empty categories get an explicit "no meaningful development" note; fewer than three evidenced opportunities are reported as such. The appendix is built from the database (source, link, published/discovered dates, evidence snippet, verbatim flag, verification, reliability, evidence strength). Output: structured JSON (rendered natively), Markdown, email-ready HTML, optional SMTP delivery, action items persisted for tracking (to do / in progress / done).

## 7. Internal intelligence
CSV/TSV/Excel/PDF/text uploads are parsed (papaparse, SheetJS, pdf-parse). For tabular data, exact value counts of categorical-looking columns (lost reason, stage, objection, status…) are computed deterministically over all rows and passed to the LLM with a text sample; findings need a verbatim quote or statistics line which is verified. Findings become `internal` signals (`verification: internal_data`). Truncation is disclosed as a limitation.

## 8. Scheduling & reliability
`scheduler.js` registers per-company cron jobs in the company's time zone: weekly brief, monitoring (6/12/24 h), monthly audit. Jobs run through `startJob`, which locks per (company, type), writes a `JobRun` with live log, status success/partial/failed and the error. On boot: interrupted jobs are marked failed, schedules are re-created, and a catch-up weekly brief runs if none succeeded in 8 days. Sources track consecutive failures; robots-blocked sources are marked `blocked`. The monthly audit re-probes failing URLs (dead after ≥3 failures or 404/410), flags exact-URL duplicates and ≥5-item overlaps, inactive sources (no new content 60 days), low-yield sources (≥5 items, 0 signals in 30 days), declining relevance (rate halved vs prior 30 days), and proposes new sources with the same discovery pipeline; recommendations are applied or dismissed by the user.

## 9. Changing business context
Editing the profile (or an interview answer) sets `profileDirty`. *Reassess* sends the old and new profile plus all sources to the LLM, which returns keep/deprecate with a reason and a new relevance per source; deprecated sources stop being crawled, a focused discovery adds new sources, and a `StackChange` record explains what changed (visible under Signal Stack → What changed).

## 10. Security & compliance
robots.txt obeyed; identifiable UA; rate limits; SSRF guard on user-supplied URLs; 15 MB upload cap; secrets only in `.env`. **Authentication:** email + password accounts, scrypt hashes, HS256 JWT bearer tokens (no extra dependencies); all routes except `/api/health` and `/api/auth/*` require a token and every company-scoped resource is checked against its owner (404 otherwise); failed logins are rate-limited per IP. Tokens live in the browser's localStorage.

## 11. Known limitations
Google News items are headline-level (redirect links are not resolved), JS-rendered pages yield little text, `webpage` change detection can flag noisy dynamic pages (mitigated by a minimum diff size), free LLM quotas bound throughput, DuckDuckGo fallback may be blocked (use Tavily free key), and quality depends on the LLM — all outputs retain links so a human can verify.
