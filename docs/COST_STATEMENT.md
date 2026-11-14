# Cost statement — everything runs on free / open-source components

| Component | What it does | Cost | Free-tier limits to know |
|---|---|---|---|
| Node.js, Express, React, Vite, Tailwind, Recharts, Mongoose, Zod, cheerio, fast-xml-parser, robots-parser, node-cron, multer, papaparse, xlsx, pdf-parse, nodemailer | Application, crawler, parsers, scheduler | $0 (open source) | – |
| MongoDB | Database | $0: local/Docker Community, or Atlas M0 free (512 MB) | Atlas M0 storage 512 MB |
| Groq API (free tier, `openai/gpt-oss-20b` by default) | Research synthesis, interview, source planning, analysis, brief | $0 | Free tier has per-minute and per-day request limits that change over time; the client throttles to `GEMINI_RPM` (default 8) and retries with backoff on 429. A full company build uses roughly 40–80 calls; analysis batches 5 items per call. Free-tier prompts may be used by Google to improve products — do not send confidential data on the free tier (internal uploads are sent to the model). |
| Tavily (optional) | Web search | $0 free plan (≈1,000 credits/month) | Without it: DuckDuckGo HTML search through the robots-checked crawler (best effort, may return nothing) |
| Google News RSS | News discovery per query | $0 | Headline + snippet + publisher only; article text is not available through the redirect, so these items are marked `headline_only` and carry lower evidence strength |
| Hacker News Algolia API, StackExchange API | Customer discussion | $0 | StackExchange anonymous quota ~300 req/day/IP |
| Reddit official API (optional) | Customer discussion | $0 for low-volume non-commercial use | Needs app registration; robots.txt forbids crawling so API only |
| Hosting | Render free web service / Docker locally | $0 | Free services sleep when idle → in-process cron only runs while awake (catch-up job mitigates) |

No paid APIs, paid scraping platforms or paid AI services are used.

## Crawler etiquette
`robots.txt` is fetched and obeyed (5xx on robots.txt = treated as disallow), `Crawl-delay` honoured (capped 10 s), minimum 2 s between requests to one host (`CRAWL_HOST_DELAY_MS`), identifiable User-Agent with contact (`CRAWLER_USER_AGENT`), 2 MB response cap, 15 s timeout, no authentication bypass, no login-walled content, private/local addresses rejected (SSRF guard). Documented APIs/RSS endpoints (Google News RSS, HN, StackExchange, Reddit, Tavily) are rate-limited but not robots-gated because they are machine interfaces governed by their own terms.
