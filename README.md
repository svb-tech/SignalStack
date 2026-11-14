# Signal Stack — Company Intelligence & Executive Briefing Engine

Enter a company name + website → the system researches it, interviews the founder (10 adaptive questions), builds a justified **Signal Stack** (Customers · Competitors · Market · Internal), crawls the approved sources, analyses what matters, ranks signals and writes a **Monday Morning Brief** in which every claim links to collected evidence.

Built for the EDXSO AI Engineer Intern assignment 1. Stack: **React + Tailwind + Recharts**, **Node + Express**, **MongoDB**, **Groq (free tier)**, **Zod** structured outputs, custom robots-respecting crawler, **node-cron** scheduler.

> Honest status: the code is complete and the crawler/ranking/parsing logic is covered by automated tests (`npm test`). The live collected records, the three sample reports and the screen recording are produced **by you running the demo** with your own keys — nothing in this repo is pre-filled or fabricated.

## Why not Firecrawl / SerpAPI / OpenAI?
The assignment forbids paid APIs. The suggested stack was adapted: Firecrawl → own crawler (`cheerio`, `robots-parser`, RSS/Atom parsing); SerpAPI → Tavily free tier *or* robots-checked DuckDuckGo HTML + Google News RSS + HN/StackExchange APIs; OpenAI → Groq free tier; BullMQ+Redis → MongoDB-persisted job runs + node-cron (no Redis to host). See `docs/COST_STATEMENT.md`.

## Quick start (local)
Requirements: Node ≥ 18.18, MongoDB (local, Docker or Atlas free M0).

```bash
npm run install:all
cp server/.env.example server/.env      # set GROQ_API_KEY (free: https://console.groq.com/keys), MONGODB_URI and JWT_SECRET
npm run build                            # builds the React client; the API serves it
npm start                                # http://localhost:5000
```
Development: `npm run dev:server` + `npm run dev:client` (Vite on :5173 proxies `/api`).
Docker: `cp server/.env.example server/.env` then `docker compose up --build`.

Optional free keys: `TAVILY_API_KEY` (better web search), `REDDIT_CLIENT_ID` (Reddit via official API; Reddit's robots.txt forbids crawling), SMTP settings (email delivery).

## Login (JWT) & Indian time
* **Auth:** sign up / log in on the first screen. The server issues an HS256 JWT (7 days, `JWT_EXPIRES_DAYS`); passwords are hashed with scrypt; there are no extra dependencies. Every `/api` route except `/api/health` and `/api/auth/*` needs `Authorization: Bearer <token>`, and each user only sees their own companies.
* The first account to sign up automatically adopts any companies created before login existed. Set `ALLOW_REGISTRATION=false` afterwards to stop others from signing up.
* In production (`NODE_ENV=production`, which the Dockerfile sets) the server refuses to start without a `JWT_SECRET` of 32+ characters.
* **IST:** all dates and times in the UI, briefs, job logs and the signals-per-day chart are shown in Indian Standard Time; schedules default to `Asia/Kolkata` (still changeable in Settings). Stored timestamps remain UTC.

## Reproduce the demonstration
In the UI: **Add a company** → name `MeetUniversity`, URL `https://www.meetuniversity.com` → review **Company profile** (verified facts vs assumptions) → **AI interview** (answer honestly, skip confidential ones) → **Signal Stack → Build** → **Source manager** (approve suggested) → **Dashboard → Generate brief** → **Monday brief** (export MD/HTML) → **Jobs & audits → Run monthly audit**.

Headless equivalent (also usable for the two extra companies):
```bash
npm run demo -- "MeetUniversity" https://www.meetuniversity.com            # interactive interview in terminal
npm run demo -- "Zerodha" https://zerodha.com demo/zerodha.answers.json    # or answers from a JSON file (see demo/answers.TEMPLATE.json)
npm run evidence                                                           # writes docs/TEST_EVIDENCE_GENERATED.md and exports briefs to reports/
```
**Stress test (required):** run two companies from different industries (e.g. a fintech and a retail brand), compare interview questions / competitors / sources, then on one company edit the profile (e.g. change growth priorities), click **Reassess Signal Stack** and show the **Signal Stack → What changed** tab.

**Reaching the minimums:** ≥20 approved sources for MeetUniversity (Source manager → *Approve all suggested*, or add sources manually), ≥30 collected records in total (run *Monitor sources now* on several days or add more sources; `npm run evidence` prints the totals). If a count falls short, the product reports it as a warning instead of inventing data.

## Automation
* **Weekly brief** (day/time/time zone in Settings): source checks → dedupe/change detection → analysis → ranking → brief saved → optional email. Manual trigger: *Generate brief*.
* **Monitoring job** (every 6/12/24 h) keeps the feed fresh between briefs; per-source minimum refresh interval is configurable.
* **Monthly audit**: dead URLs, duplicates/overlap, inactive sources, declining relevance, newly discovered sources, recommendations you can apply/dismiss; report stored with history.
* Every run is a `JobRun` document; failures show on the Dashboard and *Jobs & audits*. Server start marks interrupted jobs failed and runs a **catch-up weekly brief** if none succeeded in 8 days.
* Free hosting note: free web tiers sleep; use Docker/local or an uptime pinger for guaranteed cron.

## Tests
`npm test` runs an in-process HTTP fixture server and checks: JWT/password handling, IST helpers, robots.txt enforcement, RSS/Atom parsing, page-change detection (baseline → no change → diff), listing crawl of new links only, ranking behaviour, evidence-quote verification, URL normalisation, SSRF guard, profile merge.

## Repository map
```
server/src/models        Mongo schemas (Company, Source, RawItem, Signal, Brief, JobRun, AuditReport…)
server/src/services      research · interview · stack (discovery) · collectors · crawler · monitor · analysis · ranking · internal · brief · audit · scheduler
server/src/routes/api.js REST API
server/scripts           demo.js (end-to-end), evidence.js (counts + report export)
client/src/pages         Setup · Dashboard · Profile · Interview · Stack · Sources · Feed · Briefs · Operations · Settings
docs/                    TECHNICAL.md · COST_STATEMENT.md · REQUIREMENTS_MATRIX.md · SUBMISSION_CHECKLIST.md
```
