// Polite crawler primitives: robots.txt, per-host rate limiting, HTML / feed parsing.
import robotsParser from 'robots-parser';
import * as cheerio from 'cheerio';
import { XMLParser } from 'fast-xml-parser';
import { cfg } from '../config.js';
import { sleep, normText, parseDate } from '../util.js';

const robotsCache = new Map();
const hostNext = new Map();

async function rawGet(url, { timeout = cfg.crawl.timeoutMs, headers = {} } = {}) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeout);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      redirect: 'follow',
      headers: { 'User-Agent': cfg.ua, Accept: 'text/html,application/xhtml+xml,application/xml,application/rss+xml,application/atom+xml,application/json;q=0.9,*/*;q=0.5', 'Accept-Language': 'en', ...headers },
    });
    const buf = Buffer.from(await res.arrayBuffer()).subarray(0, cfg.crawl.maxBytes);
    return { status: res.status, ok: res.ok, url: res.url || url, contentType: res.headers.get('content-type') || '', body: buf.toString('utf8') };
  } finally { clearTimeout(t); }
}

async function getRobots(origin) {
  const c = robotsCache.get(origin);
  if (c && Date.now() - c.at < 3600e3) return c.val;
  let val = { allow: true, delay: 0 };
  try {
    const r = await rawGet(origin + '/robots.txt', { timeout: 8000 });
    if (r.status >= 500) val = { allow: false, delay: 0, why: `robots.txt returned ${r.status}` };
    else if (r.ok && !/html/i.test(r.contentType)) {
      const rb = robotsParser(origin + '/robots.txt', r.body);
      val = { rb, allow: true, delay: rb.getCrawlDelay(cfg.botName) || 0 };
    }
  } catch { /* network problem: the page fetch will surface it */ }
  robotsCache.set(origin, { at: Date.now(), val });
  return val;
}
export const clearRobotsCache = () => { robotsCache.clear(); hostNext.clear(); };

/** Fetch honoring robots.txt, crawl-delay and a per-host minimum interval. */
export async function politeFetch(url, opts = {}) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Unsupported protocol');
  const r = await getRobots(u.origin);
  const allowed = r.rb ? r.rb.isAllowed(url, cfg.botName) !== false : r.allow;
  if (!allowed) { const e = new Error(r.why || 'Blocked by robots.txt'); e.code = 'ROBOTS'; throw e; }
  const delay = Math.min(Math.max(cfg.crawl.hostDelayMs, (r.delay || 0) * 1000), 10000);
  const slot = Math.max(Date.now(), hostNext.get(u.host) || 0);
  hostNext.set(u.host, slot + delay);
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
  return rawGet(url, opts);
}

/** Rate-limited fetch for documented public APIs / RSS endpoints (robots.txt is for crawlers; APIs have their own terms). */
export async function apiFetch(url, opts = {}) {
  const host = new URL(url).host;
  const delay = Math.max(cfg.crawl.hostDelayMs, 1000);
  const slot = Math.max(Date.now(), hostNext.get(host) || 0);
  hostNext.set(host, slot + delay);
  const wait = slot - Date.now();
  if (wait > 0) await sleep(wait);
  return rawGet(url, opts);
}

export function stripHtml(html) {
  if (!html) return '';
  const $ = cheerio.load(`<div>${html}</div>`);
  return normText($('div').text());
}

export function parseHtml(html, baseUrl) {
  const $ = cheerio.load(html);
  const meta = (sel) => $(sel).attr('content') || '';
  const title = normText(meta('meta[property="og:title"]') || $('h1').first().text() || $('title').text());
  const description = normText(meta('meta[property="og:description"]') || meta('meta[name="description"]'));
  let published = meta('meta[property="article:published_time"]') || meta('meta[name="date"]') || meta('meta[itemprop="datePublished"]') || $('time[datetime]').first().attr('datetime');
  if (!published) {
    $('script[type="application/ld+json"]').each((_, el) => {
      if (published) return;
      try {
        const walk = (o) => { if (!o || published) return; if (Array.isArray(o)) return o.forEach(walk); if (o.datePublished) published = o.datePublished; if (o['@graph']) walk(o['@graph']); };
        walk(JSON.parse($(el).contents().text()));
      } catch { /* ignore */ }
    });
  }
  const feeds = [];
  $('link[rel="alternate"]').each((_, el) => {
    const type = ($(el).attr('type') || '').toLowerCase();
    const href = $(el).attr('href');
    if (href && /(rss|atom)\+xml/.test(type)) { try { feeds.push(new URL(href, baseUrl).toString()); } catch { /* ignore */ } }
  });
  const links = [];
  $('a[href]').each((_, el) => {
    try {
      const href = new URL($(el).attr('href'), baseUrl).toString();
      if (/^https?:/.test(href)) links.push({ href: href.split('#')[0], text: normText($(el).text()) });
    } catch { /* ignore */ }
  });
  $('script,style,noscript,svg,nav,footer,header,aside,form,iframe').remove();
  const root = $('article').first().length ? $('article').first() : $('main').first().length ? $('main').first() : $('body');
  const blocks = [];
  root.find('h1,h2,h3,h4,p,li,td,blockquote').each((_, el) => { const t = normText($(el).text()); if (t.length > 2) blocks.push(t); });
  const text = (blocks.length ? [...new Set(blocks)].join('\n') : normText(root.text()));
  return { title, description, publishedAt: parseDate(published), feeds, links, text, lines: [...new Set(blocks)] };
}

export function looksLikeFeed(r) {
  return /xml|rss|atom/i.test(r.contentType) || /^\s*<\?xml|^\s*<rss|^\s*<feed/i.test(r.body.slice(0, 200));
}

const xml = new XMLParser({ ignoreAttributes: false, attributeNamePrefix: '@_', textNodeName: '#text', processEntities: true });
const asText = (v) => (v == null ? '' : typeof v === 'object' ? asText(v['#text'] ?? '') : String(v));
const arr = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]);

export function parseFeed(body) {
  const j = xml.parse(body);
  const out = [];
  if (j.rss?.channel) {
    for (const it of arr(j.rss.channel.item)) {
      out.push({
        title: normText(asText(it.title)), url: asText(it.link) || asText(it.guid),
        publishedAt: parseDate(asText(it.pubDate) || asText(it['dc:date'])),
        content: stripHtml(asText(it['content:encoded']) || asText(it.description)), sourceName: asText(it.source),
      });
    }
  } else if (j.feed) {
    for (const it of arr(j.feed.entry)) {
      const link = arr(it.link).find((l) => !l['@_rel'] || l['@_rel'] === 'alternate') || arr(it.link)[0] || {};
      out.push({
        title: normText(asText(it.title)), url: link['@_href'] || asText(it.id),
        publishedAt: parseDate(asText(it.published) || asText(it.updated)), content: stripHtml(asText(it.content) || asText(it.summary)),
      });
    }
  } else if (j['rdf:RDF']) {
    for (const it of arr(j['rdf:RDF'].item)) out.push({ title: normText(asText(it.title)), url: asText(it.link), publishedAt: parseDate(asText(it['dc:date'])), content: stripHtml(asText(it.description)) });
  }
  return out.filter((i) => i.url && i.title);
}
