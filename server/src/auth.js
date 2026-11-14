import express from 'express';
import { UserM, CompanyM } from './models/index.js';
import { cfg } from './config.js';
import { hashPassword, verifyPassword, signToken, verifyToken } from './jwt.js';

const fail = (status, message) => Object.assign(new Error(message), { status });
const h = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
const publicUser = (u) => ({ id: u._id, email: u.email, name: u.name });
const issue = (u) => ({ token: signToken({ sub: String(u._id) }, cfg.jwt.secret, cfg.jwt.expiresDays * 86400), user: publicUser(u) });

/** Protects every route mounted after it; sets req.userId. */
export function requireAuth(req, _res, next) {
  const m = /^Bearer (.+)$/.exec(req.headers.authorization || '');
  const payload = m && verifyToken(m[1], cfg.jwt.secret);
  if (!payload) return next(fail(401, 'Please log in'));
  req.userId = payload.sub;
  next();
}

// Brute-force guard: 10 failed attempts per IP per 15 minutes.
const misses = new Map();
const locked = (ip) => { const x = misses.get(ip); return !!x && x.until > Date.now() && x.n >= 10; };
const miss = (ip) => {
  const now = Date.now(), x = misses.get(ip);
  if (misses.size > 5000) for (const [k, v] of misses) if (v.until < now) misses.delete(k);
  if (!x || x.until < now) misses.set(ip, { n: 1, until: now + 15 * 60_000 }); else x.n++;
};
const DUMMY = await hashPassword('timing-equaliser');

export const authRouter = express.Router();

authRouter.post('/register', h(async (q, res) => {
  const email = String(q.body.email || '').trim().toLowerCase(), password = String(q.body.password || ''), name = String(q.body.name || '').trim().slice(0, 80);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw fail(400, 'Enter a valid email address');
  if (password.length < 8) throw fail(400, 'Password must be at least 8 characters');
  const first = (await UserM.estimatedDocumentCount()) === 0;
  if (!first && !cfg.jwt.allowRegister) throw fail(403, 'Registration is closed');
  let user;
  try { user = await UserM.create({ email, name, passwordHash: await hashPassword(password) }); }
  catch (e) { throw e.code === 11000 ? fail(409, 'An account with this email already exists') : e; }
  // Data created before login existed belongs to the first account.
  if (first) await CompanyM.updateMany({ owner: { $exists: false } }, { owner: user._id });
  res.status(201).json(issue(user));
}));

authRouter.post('/login', h(async (q, res) => {
  if (locked(q.ip)) throw fail(429, 'Too many failed attempts. Try again in 15 minutes.');
  const user = await UserM.findOne({ email: String(q.body.email || '').trim().toLowerCase() });
  const ok = await verifyPassword(String(q.body.password || ''), user ? user.passwordHash : DUMMY);
  if (!user || !ok) { miss(q.ip); throw fail(401, 'Invalid email or password'); }
  misses.delete(q.ip);
  res.json(issue(user));
}));

authRouter.get('/me', requireAuth, h(async (q, res) => {
  const user = await UserM.findById(q.userId);
  if (!user) throw fail(401, 'Please log in');
  res.json({ user: publicUser(user) });
}));
