# Requirements → implementation

| Requirement | Where |
|---|---|
| Company setup, initial research, facts vs assumptions | `Setup.jsx`, `research.js` (quote-verified facts) |
| Adaptive 10-question interview, one at a time, memory, follow-ups, skip, edit | `interview.js`, `Interview.jsx` |
| Company intelligence profile view/edit | `Profile.jsx`, `PUT /companies/:id/profile` |
| Signal Stack: Customers / Competitors / Market / Internal + reasons | `stack.js`, `Stack.jsx`, `internal.js` |
| 5–10 competitors, no hard-coded lists | `discoverCompetitors` (search-grounded, URL-verified) |
| Source specific / recent / credible, justified | `probe`, `scoreCandidate`, `Source.reason`, `Source.scoreNotes` |
| Monitoring, change detection, dedupe, evidence, history | `collectors.js`, `monitor.js`, `RawItem`, `CrawlLog` |
| robots.txt / rate limits / no auth bypass | `crawler.js` (`politeFetch`) + test |
| Analysis: what/when/source/verified/why/area/type/urgency/action | `analysis.js`, `Signal` |
| Verified vs interpretation separation | Signal fields + Feed/Brief UI blocks |
| Ranking with reliability / evidence / relevance separate | `ranking.js` + test |
| Monday brief (10 sections, no manufactured news) | `brief.js`, `Briefs.jsx` |
| Dashboard pages (setup, profile, interview, stack, source manager, feed, brief, settings) | `client/src/pages` |
| Weekly brief + monthly audit schedulers, failure log, manual trigger | `scheduler.js`, `jobs.js`, `audit.js`, `Operations.jsx` |
| Internal CSV/Excel/PDF/text uploads | `internal.js` |
| Stress test + reassess on context change | `reassessStack`, *What changed* tab, README steps |
| Free/open-source only, documented limits | `COST_STATEMENT.md` |
| Export / email-ready | `/briefs/:id/export.md|html`, nodemailer |
