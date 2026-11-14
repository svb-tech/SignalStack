// Deterministic ranking + separate reliability / evidence / relevance measures.
import { clamp, daysAgo, domainOf, jaccard, tokens } from '../util.js';

const NEWS = /(reuters|bbc|nytimes|wsj|ft\.com|bloomberg|theguardian|economictimes|thehindu|timesofindia|indianexpress|livemint|hindustantimes|business-standard|techcrunch|forbes|cnbc|apnews|insidehighered|thepienews|timeshighereducation|chronicle\.com|educationdive|theverge|wired|axios|economist)\./i;

export function domainReliability(url, type = '', companyDomain = '') {
  const d = domainOf(url);
  if (type === 'upload' || url?.startsWith('internal://')) return 0.7;
  if (!d) return 0.4;
  if (/\.(gov|mil)(\.[a-z]{2})?$/.test(d) || /\.gov\./.test(d) || /\.nic\.in$/.test(d) || /(europa\.eu|un\.org|worldbank\.org|oecd\.org|who\.int|imf\.org)$/.test(d)) return 0.92;
  if (/\.(edu|ac\.[a-z]{2})$/.test(d) || /\.edu\./.test(d)) return 0.85;
  if (companyDomain && d.endsWith(companyDomain)) return 0.75; // primary source for statements about itself
  if (NEWS.test(d + '.')) return 0.8;
  if (/wikipedia\.org$/.test(d)) return 0.6;
  if (/(reddit|ycombinator|stackexchange|stackoverflow|quora|trustpilot|glassdoor|g2|capterra|youtube|x|twitter|facebook|linkedin|medium)\./.test(d + '.') || type === 'hn' || type === 'reddit' || type === 'stackexchange') return 0.35;
  if (d === 'news.google.com') return 0.5;
  return 0.45;
}

export function recencyScore(date, halfLifeDays = 14) {
  const a = daysAgo(date);
  if (!Number.isFinite(a)) return 0.35;
  return clamp(Math.pow(0.5, Math.max(0, a) / halfLifeDays));
}

export function noveltyScore(candidateText, previousTexts) {
  let max = 0;
  for (const p of previousTexts) max = Math.max(max, jaccard(candidateText, p));
  return clamp(1 - max);
}

export function keywordOverlap(text, keywords) {
  const hay = ' ' + tokens(text).join(' ') + ' ';
  const ks = [...new Set((keywords || []).map((k) => tokens(k).join(' ')).filter((k) => k.length > 3))];
  if (!ks.length) return 0;
  let hits = 0;
  for (const k of ks) if (hay.includes(' ' + k + ' ') || hay.includes(' ' + k)) hits++;
  return clamp(hits / Math.min(5, ks.length));
}

/** Evidence strength: how well the claim is supported, independent of how "important" it is. */
export function evidenceStrength({ evidenceVerified, corroborationDomains = 0, hasPublishedDate, headlineOnly, primary }) {
  let s = 0;
  if (evidenceVerified) s += 0.4;
  s += Math.min(0.3, corroborationDomains * 0.15);
  if (hasPublishedDate) s += 0.1;
  if (!headlineOnly) s += 0.1;
  if (primary) s += 0.1;
  return clamp(s);
}

export const URGENCY = { critical: 1, high: 0.8, medium: 0.5, low: 0.2 };

const WEIGHTS = { relevance: 0.25, impact: 0.25, urgency: 0.15, credibility: 0.15, recency: 0.1, novelty: 0.1 };

export function rankSignal(f) {
  const credibility = clamp(0.5 * f.sourceReliability + 0.5 * f.evidenceStrength);
  const parts = { relevance: f.relevance, impact: f.impact, urgency: f.urgency, credibility, recency: f.recency, novelty: f.novelty };
  let score = 0;
  for (const k of Object.keys(WEIGHTS)) score += WEIGHTS[k] * clamp(parts[k]);
  score = Math.round(score * 1000) / 10; // 0..100
  const contrib = Object.keys(WEIGHTS).map((k) => ({ k, v: WEIGHTS[k] * clamp(parts[k]), raw: clamp(parts[k]) })).sort((a, b) => b.v - a.v);
  const pct = (x) => Math.round(x * 100) + '%';
  const top = contrib.slice(0, 3).map((c) => `${c.k} ${pct(c.raw)}`).join(', ');
  const weak = contrib.filter((c) => c.raw < 0.35).map((c) => c.k);
  const explanation = `Score ${score}/100. Strongest drivers: ${top}.` + (weak.length ? ` Held back by: ${weak.join(', ')}.` : '') +
    ` Source reliability ${pct(f.sourceReliability)}, evidence strength ${pct(f.evidenceStrength)} (separate from relevance ${pct(f.relevance)}).`;
  return { score, parts, explanation, strategicRelevance: clamp(0.6 * f.relevance + 0.4 * f.impact) };
}
