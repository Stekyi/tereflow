/**
 * Trade News: filtering, country tagging, topics and the 12-hour cache.
 *   node scripts/test-trade-news.mjs
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-tradenews-test.mjs';
await build({
  stdin: { contents: "export { buildTradeNews, countriesIn, topicOf, loadTradeNews, isTradeStory } from './worker/lib/trade-news';", resolveDir: '.', loader: 'ts' },
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node20',
});
const { buildTradeNews, countriesIn, topicOf, loadTradeNews, isTradeStory } = await import(`./../${OUT}`);
rmSync(OUT);

let n = 0;
const ok = (c, m) => { assert.ok(c, m); n++; };

const item = (title, o = {}) => ({ title, summary: o.summary ?? '', link: o.link ?? `https://x.test/${encodeURIComponent(title)}`, source: 'S', published: o.published ?? '2026-10-04T10:00:00Z', beat: o.beat, region: 'africa' });
const wire = {
  generated: '2026-10-04T12:00:00Z',
  byBeat: {
    business: [
      item('Ghana cocoa exports rise as tariff talks open', { published: '2026-10-04T11:00:00Z' }),
      item('Global shipping rates climb on port congestion'),
      item('Startup raises seed round', { summary: 'A fintech in Lagos' }),
    ],
    sport: [item('Club trade rumours: striker to move')],
    global: [item('Ghana cocoa exports rise as tariff talks open', { link: 'https://x.test/Ghana%20cocoa%20exports%20rise%20as%20tariff%20talks%20open' })],
  },
};
const out = buildTradeNews(wire);
ok(out.items.length === 2, `two trade stories kept, got ${out.items.length}`);
ok(!out.items.some((i) => /striker/.test(i.title)), 'sport beat is excluded');
ok(out.items[0].title.startsWith('Ghana cocoa'), 'newest first');
ok(out.items[0].scope === 'country' && out.items[0].countries.includes('Ghana'), 'country tag');
ok(out.items[1].scope === 'global' && out.items[1].countries.length === 0, 'global tag');
ok(out.items[0].topic === 'Tariffs and policy', 'topic');
ok(topicOf('Port congestion hits cargo') === 'Shipping and logistics', 'shipping topic');
ok(countriesIn('UK and US agree trade deal with the UAE').sort().join() === 'United Arab Emirates,United Kingdom,United States', 'aliases');
ok(out.countries[0].name === 'Ghana', 'country tally');
ok(buildTradeNews(null).items.length === 0, 'null wire is safe');

ok(!isTradeStory('Israeli authorities trade blame for failure', ''), 'trade as a verb is not trade news');
ok(!isTradeStory('Drug haul and first lady news', 'The bill will support farmers'), 'support is not a port');
ok(isTradeStory('Ghana tariffs on rice imports rise', ''), 'headline tariff');
ok(isTradeStory('Farmers hope for relief', 'Exports of cocoa fell and shipping rates rose'), 'two body hits');
ok(!isTradeStory('Farmers hope for relief', 'Exports fell'), 'one body hit is not enough');

ok(isTradeStory('Nigeria inflation eases in September', '', 'business'), 'business beat plus economy term');
ok(!isTradeStory('Nigeria inflation eases in September', '', 'ghana'), 'economy term alone outside business beat');
const carried = buildTradeNews({ byBeat: {} }, new Date('2026-10-04T12:00:00Z'), [
  { title: 'Old but kept', link: 'https://x.test/k', published: '2026-10-01T00:00:00Z', summary: '', source: '', image: null, scope: 'global', countries: [], region: '', topic: 'Commodities' },
  { title: 'Too old', link: 'https://x.test/o', published: '2026-09-01T00:00:00Z', summary: '', source: '', image: null, scope: 'global', countries: [], region: '', topic: 'Commodities' },
]);
ok(carried.items.length === 1 && carried.items[0].title === 'Old but kept', 'carries 7 days, drops older');

ok(countriesIn('U.K. and U.S. sign deal').sort().join() === 'United Kingdom,United States', 'dotted aliases');
ok(!isTradeStory('Mahama urges health investment', '', 'business'), 'no loose economy words');

// 12-hour cache: serves held data inside the window, refreshes after, keeps stale on failure.
const kv = new Map();
const env = { CACHE: { get: async (k) => (kv.has(k) ? JSON.parse(kv.get(k)) : null), put: async (k, v) => void kv.set(k, v) }, ANANSE_NEWS_URL: 'https://wire.test/' };
let calls = 0, fail = false;
globalThis.fetch = async () => { calls++; if (fail) return new Response('no', { status: 500 }); return new Response(JSON.stringify(wire)); };
const a = await loadTradeNews(env); ok(a.items.length === 2 && calls === 1, 'first load fetches');
await loadTradeNews(env); ok(calls === 1, 'second load is served from cache');
const stale = JSON.parse(kv.get('trade-news:v4')); stale.fetched = new Date(Date.now() - 13 * 3600e3).toISOString(); kv.set('trade-news:v4', JSON.stringify(stale));
fail = true; const b = await loadTradeNews(env); ok(b.items.length === 2 && calls === 2, 'stale copy served when refresh fails');
fail = false; await loadTradeNews(env); ok(calls === 3, 'refreshes after 12 hours');

console.log(`trade-news: ${n} checks passed`);
