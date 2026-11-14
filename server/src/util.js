import crypto from 'node:crypto';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const sha1 = (s) => crypto.createHash('sha1').update(String(s)).digest('hex');
export const clamp = (n, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, Number.isFinite(n) ? n : lo));
export const truncate = (s, n) => (s && s.length > n ? s.slice(0, n) + '…' : s || '');
export const normText = (s) => String(s || '').replace(/\s+/g, ' ').trim();

export function pLimit(n) {
  let active = 0;
  const q = [];
  const next = () => {
    if (active >= n || !q.length) return;
    active++;
    const { fn, res, rej } = q.shift();
    fn().then(res, rej).finally(() => { active--; next(); });
  };
  return (fn) => new Promise((res, rej) => { q.push({ fn, res, rej }); next(); });
}

export function domainOf(url) {
  try { return new URL(url).hostname.replace(/^www\./, '').toLowerCase(); } catch { return ''; }
}

export function normUrl(url) {
  try {
    const u = new URL(url);
    u.hash = '';
    [...u.searchParams.keys()].forEach((k) => { if (/^(utm_|fbclid|gclid|ref$|mc_)/i.test(k)) u.searchParams.delete(k); });
    u.hostname = u.hostname.replace(/^www\./, '').toLowerCase();
    let s = u.toString();
    if (s.endsWith('/')) s = s.slice(0, -1);
    return s;
  } catch { return String(url || '').trim(); }
}

const STOP = new Set('the a an and or of to in on for with by at from is are was were be been this that these those it its as into about over under your our their you we they will can may more most new how why what when who which has have had not but also than then'.split(' '));
export const tokens = (s) => normText(s).toLowerCase().replace(/[^a-z0-9\u00C0-\u024F ]/g, ' ').split(' ').filter((w) => w.length > 2 && !STOP.has(w));
export const titleKey = (t) => tokens(t).join(' ');

export function jaccard(a, b) {
  const A = new Set(Array.isArray(a) ? a : tokens(a));
  const B = new Set(Array.isArray(b) ? b : tokens(b));
  if (!A.size || !B.size) return 0;
  let inter = 0;
  for (const x of A) if (B.has(x)) inter++;
  return inter / (A.size + B.size - inter);
}

// All user-facing dates/times are Indian Standard Time (UTC+5:30, no DST). Storage stays UTC.
export const IST = 'Asia/Kolkata';
const IST_MS = 330 * 60_000;
const shifted = (d) => { const t = new Date(d); return isNaN(t) ? null : new Date(t.getTime() + IST_MS); };
export const istDate = (d) => shifted(d)?.toISOString().slice(0, 10) ?? 'n/a';
export const istTime = (d = new Date()) => shifted(d)?.toISOString().slice(11, 19) ?? 'n/a';
const DAY_ONLY = /^\d{4}-\d{2}-\d{2}$/;
export const istDayStart = (s) => new Date(DAY_ONLY.test(s) ? `${s}T00:00:00+05:30` : s);
export const istDayEnd = (s) => new Date(DAY_ONLY.test(s) ? `${s}T23:59:59.999+05:30` : s);

export function weekKey(d = new Date()) {
  const ist = shifted(d);
  const t = new Date(Date.UTC(ist.getUTCFullYear(), ist.getUTCMonth(), ist.getUTCDate()));
  const day = t.getUTCDay() || 7;
  t.setUTCDate(t.getUTCDate() + 4 - day);
  const y0 = new Date(Date.UTC(t.getUTCFullYear(), 0, 1));
  return `${t.getUTCFullYear()}-W${String(Math.ceil(((t - y0) / 864e5 + 1) / 7)).padStart(2, '0')}`;
}

export const daysAgo = (d) => (d ? (Date.now() - new Date(d).getTime()) / 864e5 : Infinity);

/** True if `needle` appears (whitespace/case-insensitive) inside `haystack`. Used to verify LLM evidence quotes. */
export function containsQuote(haystack, needle) {
  const clean = (s) => normText(s).toLowerCase().replace(/[“”‘’"'`]/g, '');
  const n = clean(needle).replace(/…$/, '').trim();
  if (n.length < 12) return false;
  return clean(haystack).includes(n);
}

export function assertPublicUrl(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only http(s) URLs are allowed');
  const h = u.hostname.toLowerCase();
  if (h === 'localhost' || h.endsWith('.local') || h.endsWith('.internal') || /^(127\.|10\.|0\.|192\.168\.|169\.254\.|172\.(1[6-9]|2\d|3[01])\.)/.test(h) || h === '::1' || h.startsWith('[')) {
    throw new Error('Private/local addresses are not allowed');
  }
  return u.toString();
}

export function ensureUrl(raw) {
  let s = String(raw || '').trim();
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  return assertPublicUrl(s);
}

export function parseDate(v) {
  if (!v) return null;
  const d = new Date(v);
  if (isNaN(d)) return null;
  if (d.getTime() > Date.now() + 864e5) return null;
  if (d.getFullYear() < 2000) return null;
  return d;
}
