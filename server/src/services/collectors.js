// One collector per source type. Each returns [{url,title,content,publishedAt,headlineOnly?,kind?}] and may mutate `source` state fields (hash, lastText, seenLinks).
import { cfg } from '../config.js';
import { politeFetch, apiFetch, parseHtml, parseFeed, looksLikeFeed, stripHtml } from './crawler.js';
import { webSearch, googleNews } from './search.js';
import { normText, parseDate, sha1, normUrl, domainOf, truncate } from '../util.js';

const MAX = () => cfg.crawl.maxItemsPerSource;

async function rss(source) {
  const r = await politeFetch(source.url);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  if (!looksLikeFeed(r)) throw new Error('URL did not return an RSS/Atom feed');
  return { status: r.status, items: parseFeed(r.body).slice(0, MAX()) };
}

async function webpage(source) {
  const r = await politeFetch(source.url);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const p = parseHtml(r.body, r.url);
  const hash = sha1(p.text);
  const prev = source.contentHash;
  const prevLines = new Set((source.lastText || '').split('\n'));
  source.contentHash = hash;
  source.lastText = p.text.slice(0, 40000);
  if (!prev) return { status: r.status, items: [{ url: r.url, title: `Baseline snapshot: ${p.title || source.name}`, content: truncate(p.text, 6000), publishedAt: null, kind: 'baseline' }] };
  if (prev === hash) return { status: r.status, items: [] };
  const added = p.lines.filter((l) => !prevLines.has(l) && l.length > 15);
  if (added.join(' ').length < 40) return { status: r.status, items: [], note: 'cosmetic change only' };
  return { status: r.status, items: [{ url: r.url, title: `Page updated: ${p.title || source.name}`, content: truncate('NEW/CHANGED TEXT ON PAGE:\n' + added.join('\n'), 6000), publishedAt: null, kind: 'page_change' }] };
}

async function listing(source) {
  const r = await politeFetch(source.url);
  if (!r.ok) throw Object.assign(new Error(`HTTP ${r.status}`), { status: r.status });
  const base = new URL(r.url);
  const seen = new Set(source.seenLinks || []);
  const first = seen.size === 0;
  const cand = [];
  for (const l of parseHtml(r.body, r.url).links) {
    try {
      const u = new URL(l.href);
      if (u.host.replace(/^www\./, '') !== base.host.replace(/^www\./, '')) continue;
      const depth = u.pathname.split('/').filter(Boolean).length;
      if (depth < 2 || l.text.length < 15 || normUrl(l.href) === normUrl(r.url)) continue;
      if (/\/(tag|category|author|page|search|login|signup|cart)\b/i.test(u.pathname)) continue;
      cand.push(normUrl(l.href));
    } catch { /* ignore */ }
  }
  const uniq = [...new Set(cand)];
  const fresh = uniq.filter((u) => !seen.has(u));
  source.seenLinks = [...new Set([...fresh, ...seen])].slice(0, 500);
  const items = [];
  for (const u of fresh.slice(0, cfg.crawl.maxArticleFetch)) {
    try {
      const a = await politeFetch(u);
      if (!a.ok || looksLikeFeed(a)) continue;
      const p = parseHtml(a.body, a.url);
      if (p.text.length < 200) continue;
      items.push({ url: a.url, title: p.title || u, content: truncate(p.text, 6000), publishedAt: p.publishedAt, kind: first ? 'post' : 'article' });
    } catch (e) { if (e.code === 'ROBOTS') continue; }
  }
  return { status: r.status, items };
}

async function googleNewsSrc(source) {
  const items = await googleNews(source.query, source.meta?.days || 30);
  return { status: 200, items: items.slice(0, MAX()) };
}

async function hn(source) {
  const since = Math.floor((Date.now() - (source.meta?.days || 30) * 864e5) / 1000);
  const url = `https://hn.algolia.com/api/v1/search_by_date?query=${encodeURIComponent(source.query)}&tags=(story,comment)&numericFilters=created_at_i>${since}&hitsPerPage=${MAX()}`;
  const r = await apiFetch(url);
  if (!r.ok) throw Object.assign(new Error(`HN API ${r.status}`), { status: r.status });
  const j = JSON.parse(r.body);
  return {
    status: r.status,
    items: (j.hits || []).map((h) => {
      const body = stripHtml(h.comment_text || h.story_text || '');
      return { url: `https://news.ycombinator.com/item?id=${h.objectID}`, title: normText(h.story_title || h.title || body.slice(0, 90)), content: body || normText(h.title), publishedAt: parseDate(h.created_at), kind: 'post', ugc: true };
    }).filter((i) => i.content.length > 20),
  };
}

async function stackexchange(source) {
  const site = source.meta?.site || 'stackoverflow';
  const url = `https://api.stackexchange.com/2.3/search/advanced?order=desc&sort=creation&q=${encodeURIComponent(source.query)}&site=${site}&filter=withbody&pagesize=${MAX()}`;
  const r = await apiFetch(url);
  if (!r.ok) throw Object.assign(new Error(`StackExchange API ${r.status}`), { status: r.status });
  const j = JSON.parse(r.body);
  return { status: r.status, items: (j.items || []).map((q) => ({ url: q.link, title: normText(stripHtml(q.title)), content: stripHtml(q.body || '').slice(0, 3000), publishedAt: new Date(q.creation_date * 1000), kind: 'post', ugc: true })) };
}

let redditTok = null;
async function redditToken() {
  if (redditTok && redditTok.exp > Date.now()) return redditTok.v;
  const res = await fetch('https://www.reddit.com/api/v1/access_token', {
    method: 'POST',
    headers: { Authorization: 'Basic ' + Buffer.from(cfg.redditId + ':').toString('base64'), 'Content-Type': 'application/x-www-form-urlencoded', 'User-Agent': cfg.ua },
    body: 'grant_type=https%3A%2F%2Foauth.reddit.com%2Fgrants%2Finstalled_client&device_id=DO_NOT_TRACK_THIS_DEVICE',
  });
  if (!res.ok) throw new Error(`Reddit auth ${res.status}`);
  const j = await res.json();
  redditTok = { v: j.access_token, exp: Date.now() + (j.expires_in - 60) * 1000 };
  return redditTok.v;
}

async function reddit(source) {
  if (!cfg.redditId) throw Object.assign(new Error('Reddit credentials not configured (REDDIT_CLIENT_ID). Reddit disallows bot crawling, so only the official API is used.'), { code: 'NO_CREDS' });
  const tok = await redditToken();
  const sub = source.meta?.subreddit;
  const url = `https://oauth.reddit.com/${sub ? `r/${sub}/` : ''}search?q=${encodeURIComponent(source.query)}&sort=new&t=month&limit=${MAX()}${sub ? '&restrict_sr=1' : ''}&raw_json=1`;
  const r = await apiFetch(url, { headers: { Authorization: `Bearer ${tok}` } });
  if (!r.ok) throw Object.assign(new Error(`Reddit API ${r.status}`), { status: r.status });
  const j = JSON.parse(r.body);
  return { status: r.status, items: (j.data?.children || []).map((c) => c.data).map((d) => ({ url: 'https://www.reddit.com' + d.permalink, title: normText(d.title), content: normText(`${d.title}. ${d.selftext || ''}`).slice(0, 3000), publishedAt: new Date(d.created_utc * 1000), kind: 'post', ugc: true })) };
}

async function webSearchSrc(source) {
  const res = await webSearch(source.query, { max: 10 });
  return { status: 200, items: res.map((r) => ({ url: r.url, title: r.title, content: `${r.title}. ${r.snippet}`, publishedAt: r.publishedAt || null, kind: 'post', ugc: /reddit|quora|forum|trustpilot|g2|capterra|community/i.test(r.url), headlineOnly: !r.snippet })) };
}

const HANDLERS = { rss, webpage, listing, google_news: googleNewsSrc, hn, stackexchange, reddit, web_search: webSearchSrc };

export async function collect(source) {
  const h = HANDLERS[source.type];
  if (!h) throw new Error(`No collector for source type "${source.type}"`);
  return h(source);
}

/** Fetch the full article text for short items (RSS summaries / search snippets), when robots.txt allows. */
export async function enrichItem(item) {
  if (!/^https?:/.test(item.url) || domainOf(item.url) === 'news.google.com') return item;
  try {
    const r = await politeFetch(item.url);
    if (!r.ok || looksLikeFeed(r)) return item;
    const p = parseHtml(r.body, r.url);
    if (p.text.length > (item.content || '').length + 100) {
      item.content = truncate(p.text, 6000);
      item.publishedAt = item.publishedAt || p.publishedAt;
      item.headlineOnly = false;
    }
  } catch { /* keep snippet */ }
  return item;
}
