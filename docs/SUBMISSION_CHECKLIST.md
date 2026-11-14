# What you still have to do (cannot be done from code alone)

1. `server/.env`: add a **free Groq key** and a `JWT_SECRET` (and optionally Tavily / Reddit / SMTP). Start MongoDB.
2. Run the **MeetUniversity** workflow (UI or `npm run demo`) → confirm ≥20 approved sources, 5–10 competitors, brief generated.
3. Run **two other companies from different industries**; change business context on one and **Reassess**.
4. Reach **≥30 collected records** (check Dashboard / `npm run evidence`). Run *Monitor sources now* again on another day for history, and upload one real CSV/PDF if you have it for the Internal category (otherwise the brief honestly says Internal is empty).
5. `npm run evidence` → commit `reports/` (3 briefs) and `docs/TEST_EVIDENCE_GENERATED.md`; add screenshots of Dashboard, Stack, Feed, Brief, Jobs.
6. Record the 5–10 min screen demo following the README order. Say plainly what is a limitation.
7. Push to GitHub, optionally deploy (Render + Atlas), submit repo + URL + video. Replace `YOUR_USER` / contact e-mail in `.env.example` User-Agent.
8. Export `docs/TECHNICAL.md` to PDF if a PDF is required (≤5 pages).
