import { ISO3_NAME } from '../../shared/country-names';

/**
 * Trade News: a reading bulletin built from Ananse's public wire.
 *
 * Ananse already publishes /api/wire (CORS open, every beat and region). Tereflow takes only the
 * trade-related stories, tags each as Global or by country, and keeps the result for twelve hours.
 * Set ANANSE_NEWS_URL to point at a dedicated Ananse endpoint later; the shape it must return is
 * the same `items` array the wire uses.
 */

export type { TradeNewsItem, TradeNewsPayload } from '../../shared/trade-news';
import type { TradeNewsItem, TradeNewsPayload } from '../../shared/trade-news';
import type { Env } from './db';

const TRADE_URL = 'https://ananses.com/api/trade-news';
const WIRE_URL = 'https://ananses.com/api/wire';
const REFRESH_MS = 12 * 3600 * 1000;
const KV_KEY = 'trade-news:v5';
const MAX_ITEMS = 120;
const KEEP_MS = 7 * 86400 * 1000;

const TERMS = [
  'tariffs?', 'exports?', 'exporters?', 'imports?', 'importers?', 'customs (duty|duties|revenue|service|officials?)',
  'wto', 'world trade organi[sz]ation', 'agoa', 'afcfta', 'free trade', 'trade (deals?|wars?|agreements?|talks|policy|balance|deficit|surplus|ministers?|partners?|barriers?|routes?|corridors?|data|figures)',
  'trading partners?', 'sanctions', 'embargo(es)?', 'supply chains?', 'freight', 'shipping (rates?|lanes?|routes?|costs?|lines?|companies)',
  'container (ships?|shipping|rates?|terminals?)', 'seaports?', 'port (congestion|authority|of [A-Z])', 'cargo (ships?|vessels?|volumes?)',
  'commodity prices?', 'commodities', 'cocoa', 'cashew', 'shea', 'oil prices?', 'crude oil', 'gold prices?', 'quotas?', 'anti-dumping',
  'bilateral trade', 'balance of trade', 'current account',
];
const TRADE_RES = TERMS.map((t) => new RegExp('\\b(' + t + ')\\b', 'i'));

const ECON = /\b(econom(y|ic|ies)|inflation|gdp|currency|exchange rates?|central bank|foreign (exchange|investment|reserves?)|fuel prices?|petrol|diesel|oil|gold|debt|imf|world bank|manufactur\w+|agribusiness)\b/i;

/** A story counts when the headline carries a trade term, or the headline plus summary carry two. */
export function isTradeStory(title: string, summary: string, beat = ''): boolean {
  if (beat === 'business' && ECON.test(title)) return true;
  if (TRADE_RES.some((re) => re.test(title))) return true;
  const text = `${title}. ${summary}`;
  return TRADE_RES.filter((re) => re.test(text)).length >= 2;
}

const TOPICS: [string, RegExp][] = [
  ['Tariffs and policy', /\b(tariffs?|duty|duties|quota|sanctions?|embargo|wto|trade (deal|war|agreement|policy)|agoa|afcfta|free trade)\b/i],
  ['Shipping and logistics', /\b(shipping|freight|ports?|container|cargo|logistics|supply chains?|customs)\b/i],
  ['Commodities', /\b(commodity|commodities|cocoa|cashew|shea|crude|oil prices?|gold prices?|copper|coffee|wheat|grain)\b/i],
];

const ALIASES: Record<string, string> = {
  uk: 'United Kingdom',
  'u.k.': 'United Kingdom',
  britain: 'United Kingdom',
  us: 'United States',
  'u.s.': 'United States',
  usa: 'United States',
  uae: 'United Arab Emirates',
  eu: '',
};

const NAMES = Array.from(new Set(Object.values(ISO3_NAME)))
  .filter((n) => n.length > 3)
  .sort((a, b) => b.length - a.length);

function esc(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const NAME_RE = new RegExp('\\b(' + NAMES.map(esc).join('|') + ')\\b', 'g');
const ALIAS_RE = /(?<![\w.])(UK|U\.K\.|U\.S\.|USA|US|UAE|Britain)(?![\w])/g;

/** Countries named in the headline or summary. A story naming none is Global. */
export function countriesIn(text: string): string[] {
  const found = new Set<string>();
  for (const m of text.matchAll(NAME_RE)) found.add(m[1]);
  for (const m of text.matchAll(ALIAS_RE)) {
    const full = ALIASES[m[1].toLowerCase()];
    if (full) found.add(full);
  }
  return Array.from(found).slice(0, 4);
}

export function topicOf(text: string): string {
  for (const [name, re] of TOPICS) if (re.test(text)) return name;
  return 'Markets and economy';
}

interface WireItem {
  title?: string;
  summary?: string;
  link?: string;
  source?: string;
  published?: string;
  image?: string;
  beat?: string;
  region?: string;
}

/** Pure: turns a wire body into the bulletin. Exported for tests. */
export function buildTradeNews(wire: unknown, now = new Date(), carry: TradeNewsItem[] = []): TradeNewsPayload {
  const w = (wire ?? {}) as { generated?: string; byBeat?: Record<string, WireItem[]>; top?: WireItem[] };
  const pool: WireItem[] = [];
  for (const [beat, list] of Object.entries(w.byBeat ?? {})) {
    if (beat === 'sport' || beat === 'entertainment' || beat === 'faith' || beat === 'explainer') continue;
    if (Array.isArray(list)) pool.push(...list.map((x) => ({ ...x, beat: x.beat ?? beat })));
  }
  if (Array.isArray(w.top)) pool.push(...w.top);

  const seen = new Set<string>();
  const items: TradeNewsItem[] = [];
  const cutoff = now.getTime() - KEEP_MS;
  for (const old of carry) {
    if (Date.parse(old.published) >= cutoff && !seen.has(old.link)) {
      seen.add(old.link);
      items.push(old);
    }
  }
  for (const it of pool) {
    const title = (it.title ?? '').trim();
    const link = (it.link ?? '').trim();
    if (!title || !/^https?:\/\//.test(link) || seen.has(link)) continue;
    const summary = (it.summary ?? '').replace(/\s+/g, ' ').trim();
    const text = `${title}. ${summary}`;
    if (!isTradeStory(title, summary, it.beat ?? '')) continue;
    seen.add(link);
    const countries = countriesIn(text);
    items.push({
      title,
      summary: summary.length > 320 ? summary.slice(0, 317) + '...' : summary,
      link,
      source: it.source ?? '',
      published: it.published ?? '',
      image: it.image && /^https:\/\//.test(it.image) ? it.image : null,
      scope: countries.length ? 'country' : 'global',
      countries,
      region: it.region ?? '',
      topic: topicOf(text),
    });
  }
  items.sort((a, b) => (b.published || '').localeCompare(a.published || ''));
  const top = items.slice(0, MAX_ITEMS);

  const tally = (keys: string[]) => {
    const m = new Map<string, number>();
    for (const k of keys) m.set(k, (m.get(k) ?? 0) + 1);
    return Array.from(m, ([name, count]) => ({ name, count })).sort((a, b) => b.count - a.count);
  };
  return {
    generated: w.generated ?? now.toISOString(),
    fetched: now.toISOString(),
    items: top,
    countries: tally(top.flatMap((i) => i.countries)).slice(0, 20),
    topics: tally(top.map((i) => i.topic)),
  };
}

/** Cached for twelve hours. A failed refresh serves the previous bulletin rather than an empty page. */
export async function loadTradeNews(env: Pick<Env, 'CACHE' | 'ANANSE_NEWS_URL'>): Promise<TradeNewsPayload> {
  const held = await env.CACHE.get<TradeNewsPayload>(KV_KEY, 'json');
  if (held && Date.now() - Date.parse(held.fetched) < REFRESH_MS) return held;
  try {
    const get = (u: string) =>
      fetch(u, { headers: { accept: 'application/json', 'user-agent': 'Tereflow/1.0 (+https://tereflow.tiwaak.com)' } });
    // The dedicated Ananse trade desk is preferred. Until it is deployed, or if it is down, the wire is filtered here.
    let fresh: TradeNewsPayload | null = null;
    const desk = await get(env.ANANSE_NEWS_URL || TRADE_URL).catch(() => null);
    if (desk && desk.ok) {
      const body = (await desk.json().catch(() => null)) as Partial<TradeNewsPayload> | null;
      if (body && Array.isArray(body.items) && body.items.length) {
        fresh = { ...(body as TradeNewsPayload), fetched: new Date().toISOString() };
      }
    }
    if (!fresh) {
      const res = await get(WIRE_URL);
      if (!res.ok) throw new Error(`Ananse ${res.status}`);
      fresh = buildTradeNews(await res.json(), new Date(), held?.items ?? []);
    }
    if (fresh.items.length) {
      await env.CACHE.put(KV_KEY, JSON.stringify(fresh), { expirationTtl: 7 * 86400 });
      return fresh;
    }
    if (held) return held;
    return fresh;
  } catch (e) {
    if (held) return held;
    throw e;
  }
}
