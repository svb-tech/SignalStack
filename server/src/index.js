import express from 'express';
import cors from 'cors';
import mongoose from 'mongoose';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { cfg } from './config.js';
import { CompanyM } from './models/index.js';
import api from './routes/api.js';
import { markStaleJobs } from './services/jobs.js';
import { startScheduler } from './services/scheduler.js';

const app = express();
app.set('trust proxy', 1); // correct client IPs behind Render/nginx (used by the login rate limit)
app.use(cors());
app.use(express.json({ limit: '2mb' }));
app.use('/api', api);

const dist = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist');
if (fs.existsSync(dist)) {
  app.use(express.static(dist));
  app.get(/^(?!\/api).*/, (_q, res) => res.sendFile(path.join(dist, 'index.html')));
}
app.use((err, _req, res, _next) => {
  if (err.name === 'CastError') return res.status(400).json({ error: 'Invalid id' });
  if (err.status !== 404 && !err.status) console.error(err);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

await mongoose.connect(cfg.mongo);
await markStaleJobs();
// Schedules default to Indian time now; move companies still on the old UTC default.
await CompanyM.updateMany({ 'settings.timezone': 'UTC' }, { 'settings.timezone': 'Asia/Kolkata' });
if (!process.env.JWT_SECRET) console.warn('[auth] JWT_SECRET not set: using an insecure development secret.');

app.listen(cfg.port, () =>
  console.log(
    `Signal Stack API on :${cfg.port} (Groq ${
      cfg.groq.key ? 'configured' : 'NOT configured'
    }, Tavily ${cfg.tavilyKey ? 'on' : 'off'})`
  )
);

startScheduler().catch((e) => console.error('scheduler failed', e));
