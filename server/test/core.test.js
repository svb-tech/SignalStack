process.env.CRAWL_HOST_DELAY_MS = '0';
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { rankSignal, evidenceStrength, domainReliability, recencyScore, noveltyScore } from '../src/services/ranking.js';
import { containsQuote, normUrl, titleKey, jaccard, weekKey, assertPublicUrl } from '../src/util.js';
import { extractJson, durationMs } from '../src/llm.js';
import { politeFetch, parseFeed, parseHtml, clearRobotsCache } from '../src/services/crawler.js';
import { collect } from '../src/services/collectors.js';
import { mergeProfile } from '../src/services/prompts.js';

let page = '<html><head><title>Pricing</title></head><body><main><h1>Plans</h1><p>Starter costs 10 dollars per month for small teams.</p><p>Pro costs 30 dollars per month with support.</p></main></body></html>';
const RSS = `<?xml version="1.0"?><rss version="2.0"><channel><title>Blog</title>
<item><title>Acme launches AI advisor</title><link>http://127.0.0.1:PORT/post/1</link><pubDate>Mon, 02 Nov 2026 10:00:00 GMT</pubDate><description>&lt;p&gt;Acme announced a new AI advisor for students.&lt;/p&gt;</description></item>
<item><title>Second post about pricing</title><link>http://127.0.0.1:PORT/post/2</link><pubDate>Tue, 03 Nov 2026 10:00:00 GMT</pubDate><description>Pricing news</description></item></channel></rss>`;
const server = http.createServer((req, res) => {
  const port = server.address().port;
  if (req.url === '/robots.txt') return res.end('User-agent: *\nDisallow: /private\n');
  if (req.url === '/feed.xml') return res.writeHead(200, { 'content-type': 'application/rss+xml' }).end(RSS.replaceAll('PORT', port));
  if (req.url === '/pricing') return res.writeHead(200, { 'content-type': 'text/html' }).end(page);
  if (req.url === '/private/x') return res.end('secret');
  if (req.url === '/blog') return res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><body><a href="/blog/new-post-about-things">Read our new long post about things</a><a href="/blog/other-post-here-too">Another long post title here</a></body></html>`);
  if (req.url.startsWith('/blog/')) return res.writeHead(200, { 'content-type': 'text/html' }).end(`<html><head><title>Post ${req.url}</title><meta property="article:published_time" content="2026-11-01T10:00:00Z"></head><body><article><p>${'This is a substantive article paragraph about the product. '.repeat(10)}</p></article></body></html>`);
  res.writeHead(404).end('nope');
});
let base;
test.before(async () => { await new Promise((r) => server.listen(0, '127.0.0.1', r)); base = `http://127.0.0.1:${server.address().port}`; clearRobotsCache(); });
test.after(() => server.close());

test('robots.txt is respected', async () => {
  await assert.rejects(politeFetch(base + '/private/x'), (e) => e.code === 'ROBOTS');
  const ok = await politeFetch(base + '/pricing');
  assert.equal(ok.status, 200);
});

test('RSS collection parses items', async () => {
  const res = await collect({ type: 'rss', url: base + '/feed.xml' });
  assert.equal(res.items.length, 2);
  assert.match(res.items[0].content, /AI advisor/);
  assert.ok(res.items[0].publishedAt instanceof Date);
});

test('webpage change detection: baseline, no change, change', async () => {
  const src = { type: 'webpage', url: base + '/pricing', name: 'Pricing', health: {} };
  const a = await collect(src);
  assert.equal(a.items[0].kind, 'baseline');
  const b = await collect(src);
  assert.equal(b.items.length, 0);
  page = page.replace('30 dollars', '45 dollars').replace('</main>', '<p>New Enterprise tier launched for large institutions worldwide.</p></main>');
  const c = await collect(src);
  assert.equal(c.items[0].kind, 'page_change');
  assert.match(c.items[0].content, /Enterprise tier/);
});

test('listing: baseline then only new links are fetched', async () => {
  const src = { type: 'listing', url: base + '/blog', name: 'Blog', seenLinks: [] };
  const a = await collect(src);
  assert.equal(a.items.length, 2);
  const b = await collect(src);
  assert.equal(b.items.length, 0);
});

test('ranking separates reliability / evidence from relevance and orders sensibly', () => {
  const strong = rankSignal({ relevance: 0.9, impact: 0.9, urgency: 0.8, sourceReliability: 0.9, evidenceStrength: 0.9, recency: 1, novelty: 1 });
  const weak = rankSignal({ relevance: 0.3, impact: 0.2, urgency: 0.2, sourceReliability: 0.35, evidenceStrength: 0.2, recency: 0.2, novelty: 0.3 });
  assert.ok(strong.score > weak.score + 40);
  assert.match(weak.explanation, /Held back by/);
  assert.ok(domainReliability('https://www.state.gov/x') > domainReliability('https://reddit.com/r/x'));
  assert.ok(evidenceStrength({ evidenceVerified: true, corroborationDomains: 2, hasPublishedDate: true, headlineOnly: false, primary: true }) > evidenceStrength({ evidenceVerified: false }));
  assert.ok(recencyScore(new Date()) > recencyScore(new Date(Date.now() - 60 * 864e5)));
  assert.ok(noveltyScore('acme launches ai advisor', ['acme launches ai advisor today']) < 0.4);
});

test('quote verification, url normalisation, misc utils', () => {
  assert.ok(containsQuote('Acme announced a new AI advisor  for students.', '“announced a new AI advisor for students”'));
  assert.ok(!containsQuote('Acme announced a new AI advisor', 'invented sentence that is not there'));
  assert.equal(normUrl('https://www.Example.com/a/?utm_source=x#frag'), 'https://example.com/a');
  assert.equal(titleKey('The Big News about Acme'), 'big news acme');
  assert.ok(jaccard('alpha beta gamma', 'alpha beta delta') > 0);
  assert.match(weekKey(new Date('2026-11-14')), /^2026-W4\d$/);
  assert.throws(() => assertPublicUrl('http://localhost:3000'));
  assert.deepEqual(JSON.parse(extractJson('```json\n{"a":1}\n```')), { a: 1 });
});

test('parseFeed handles Atom and parseHtml extracts dates', () => {
  const atom = '<feed xmlns="http://www.w3.org/2005/Atom"><entry><title>T</title><link href="http://x.com/1"/><updated>2026-11-01T00:00:00Z</updated><summary>S</summary></entry></feed>';
  assert.equal(parseFeed(atom)[0].url, 'http://x.com/1');
  const p = parseHtml('<html><head><title>X</title><script type="application/ld+json">{"datePublished":"2026-10-05"}</script></head><body><p>hello world content here</p></body></html>', 'http://x.com');
  assert.equal(p.publishedAt.getUTCFullYear(), 2026);
});

test('profile merge unions arrays without duplicates', () => {
  const m = mergeProfile({ businessLines: ['A'], oneLiner: 'old' }, { businessLines: ['a', 'B'], oneLiner: 'new' });
  assert.deepEqual(m.businessLines, ['A', 'B']);
  assert.equal(m.oneLiner, 'new');
});

test('rate-limit reset headers are parsed (seconds, minutes+seconds, plain number)', () => {
  assert.equal(durationMs('7.66s'), 7660);
  assert.equal(durationMs('2m59.5s'), 179500);
  assert.equal(durationMs('30'), 30000);
  assert.equal(durationMs(''), 0);
  assert.equal(durationMs(null), 0);
});
