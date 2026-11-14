import * as cheerio from 'cheerio';
import { cfg } from '../config.js';
import { politeFetch, apiFetch, parseFeed } from './crawler.js';
import { parseDate, normText } from '../util.js';

/** Web search: Tavily (free tier) if configured, else robots-checked DuckDuckGo HTML. Returns [] (never throws) on failure. */
export async function webSearch(query, { max = 8, log, includeDomains, rawContent = false } = {}) {
  if (cfg.tavilyKey) {
    try {
      const res = await fetch('https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.tavilyKey}` },
        body: JSON.stringify({
          query, max_results: max, search_depth: 'basic',
          ...(includeDomains?.length ? { include_domains: includeDomains } : {}),
          ...(rawContent ? { include_raw_content: 'text' } : {}),
        }),
      });
      if (res.ok) {
        const j = await res.json();
        return (j.results || []).map((r) => ({ title: normText(r.title), url: r.url, snippet: normText(r.content), rawContent: r.raw_content || '', publishedAt: parseDate(r.published_date), engine: 'tavily' }));
      }
      log?.(`Tavily ${res.status} for "${query}", falling back`);
    } catch (e) { log?.(`Tavily error: ${e.message}`); }
  }
  try {
    const r = await politeFetch('https://html.duckduckgo.com/html/?q=' + encodeURIComponent(query));
    if (!r.ok) return [];
    const $ = cheerio.load(r.body);
    const out = [];
    $('.result').each((_, el) => {
      const a = $(el).find('a.result__a').first();
      let href = a.attr('href') || '';
      const m = href.match(/[?&]uddg=([^&]+)/);
      if (m) href = decodeURIComponent(m[1]);
      if (/^https?:/.test(href)) out.push({ title: normText(a.text()), url: href, snippet: normText($(el).find('.result__snippet').text()), engine: 'duckduckgo' });
    });
    return out.slice(0, max);
  } catch (e) {
    log?.(`Web search unavailable (${e.code === 'ROBOTS' ? 'blocked by robots.txt' : e.message}); add TAVILY_API_KEY (free tier) for reliable search`);
    return [];
  }
}

function googleNewsUrl(query, days = 30) {
  const [hl, region] = cfg.newsRegion.split(':');
  const q = `${query} when:${days}d`;
  return `https://news.google.com/rss/search?q=${encodeURIComponent(q)}&hl=${hl}&gl=${region}&ceid=${region}:${hl.split('-')[0]}`;
}

export async function googleNews(query, days = 30) {
  const r = await apiFetch(googleNewsUrl(query, days));
  if (!r.ok) throw Object.assign(new Error(`Google News RSS ${r.status}`), { status: r.status });
  return parseFeed(r.body).map((i) => ({ ...i, headlineOnly: true, content: `${i.title}${i.sourceName ? ' — ' + i.sourceName : ''}`, sourceName: i.sourceName }));
}

/** Tavily Extract: fetches page text through Tavily's own infrastructure (subject to Tavily's terms).
 *  Not guaranteed for bot-protected sites: failed URLs are simply absent from the result. */
export async function tavilyExtract(urls, { log } = {}) {
  if (!cfg.tavilyKey || !urls.length) return [];
  try {
    const res = await fetch('https://api.tavily.com/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${cfg.tavilyKey}` },
      body: JSON.stringify({ urls, extract_depth: 'basic', format: 'text' }),
    });
    if (!res.ok) { log?.(`Tavily extract ${res.status}`); return []; }
    const j = await res.json();
    return (j.results || []).map((r) => ({ url: r.url, text: normText(r.raw_content) })).filter((r) => r.text.length > 200);
  } catch (e) { log?.(`Tavily extract error: ${e.message}`); return []; }
}
