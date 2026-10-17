import type { Env } from '../lib/db';
import { uid } from '../lib/db';
import { hs2Sector, hs2Label } from './codes';
import { oracleConfig, type OracleConfig } from '../lib/oracle';
import { feedRationale, itemName, oracleDashboard } from '../lib/oracle-feeds';
import { searchProducts } from '../lib/product-index-d1';
import { loadCountryDataForCode, oracleCatalogue } from '../lib/oracle-insight';

/**
 * Weekly feed fan-out.
 *
 * Users follow a product, sector, country or HS chapter. After the analysis
 * run rebuilds the numbers, this turns those subscriptions into feed items.
 *
 * Two rules shape it:
 *  - The *fact* that something moved is free. The forward-looking read on it is
 *    premium. A free user should be able to see that there is something worth
 *    knowing, otherwise the paywall is just a blank wall.
 *  - Everything is deduped per user per ISO week, so a manual re-run on a
 *    Friday does not spam anybody's feed.
 */

interface Subscription {
  id: string;
  user_id: string;
  kind: 'product' | 'sector' | 'country' | 'hs_code';
  value: string;
  label: string | null;
}

interface SignalRow {
  id: string;
  entity_id: string;
  entity_slug: string;
  entity_name: string;
  hs_code: string | null;
  product_name: string;
  flow: 'export' | 'import';
  cagr_3y: number | null;
  momentum: number;
  current_rank: number | null;
  projected_rank: number | null;
  horizon_years: number;
  rationale: string | null;
}

export interface FanoutResult {
  subscribers: number;
  subscriptions: number;
  items_written: number;
}

export async function fanOutFeed(env: Env, runId: string): Promise<FanoutResult> {
  const week = isoWeekKey(new Date());

  const { results: subs } = await env.DB.prepare(
    'SELECT id, user_id, kind, value, label FROM subscriptions',
  ).all<Subscription>();
  const subscriptions = subs ?? [];
  if (subscriptions.length === 0) {
    return { subscribers: 0, subscriptions: 0, items_written: 0 };
  }

  // Signals now come from Oracle's product index (the scored lines of every active country), not from the old D1 copy.
  const cfg = oracleConfig(env);
  const entities = cfg ? await activeEntities(env) : [];
  const cache = new Map<string, SignalRow[]>();
  const pending: FeedDraft[] = [];

  for (const sub of subscriptions) {
    const matched = (await signalsFor(env, cfg, sub, entities, cache)).filter((s) => matches(sub, s)).slice(0, 4);

    for (const s of matched) {
      // Export and import signals for the same product would otherwise produce
      // two identically titled cards, which reads as a duplicate.
      const side = s.flow === 'export' ? 'sells' : 'buys';
      pending.push({
        user_id: sub.user_id,
        kind: 'signal',
        title: `${s.entity_name} ${side} more ${s.product_name.toLowerCase()} every year`,
        body: `${s.rationale ?? ''} Momentum score ${Math.round(s.momentum * 100)} out of 100.`.trim(),
        payload: {
          signal_id: s.id,
          hs_code: s.hs_code,
          flow: s.flow,
          cagr_3y: s.cagr_3y,
          momentum: s.momentum,
          current_rank: s.current_rank,
          projected_rank: s.projected_rank,
        },
        entity_id: s.entity_id,
        premium_only: 1,
        // Signal rows are deleted and re-inserted on every run, so their id is
        // not stable. Key on what the signal actually *is* instead.
        dedupe_key: `${week}:${sub.id}:sig:${s.entity_id}:${s.hs_code ?? 'na'}:${s.flow}`,
      });
    }

    // Push and pull: who sells this and who buys it. Free, because it is the
    // thing that makes someone want the premium read.
    if (sub.kind === 'hs_code' || sub.kind === 'product') {
      const balance = await pushPull(env, cfg, sub);
      if (balance) {
        pending.push({
          user_id: sub.user_id,
          kind: 'market_balance',
          title: balance.title,
          body: balance.body,
          payload: balance.payload,
          entity_id: null,
          premium_only: 0,
          dedupe_key: `${week}:${sub.id}:balance`,
        });
      }
    }

    if (sub.kind === 'country') {
      const country = await countryMove(env, cfg, sub.value);
      if (country) {
        pending.push({
          user_id: sub.user_id,
          kind: 'trend',
          title: country.title,
          body: country.body,
          payload: country.payload,
          entity_id: country.entity_id,
          premium_only: 0,
          dedupe_key: `${week}:${sub.id}:trend`,
        });
      }
    }
  }

  const written = await writeFeed(env, pending, runId);
  return {
    subscribers: new Set(subscriptions.map((s) => s.user_id)).size,
    subscriptions: subscriptions.length,
    items_written: written,
  };
}

function matches(sub: Subscription, s: SignalRow): boolean {
  const value = sub.value.trim().toLowerCase();
  switch (sub.kind) {
    case 'hs_code': {
      const signalCode = s.hs_code ?? '';
      // Following a specific 6-digit line means that line, not its whole
      // chapter. Following a 2-digit chapter still means the chapter. Before
      // products were stored at HS6 every code was a chapter and this
      // distinction did not exist.
      if (value.length === 6 && signalCode.length === 6) return signalCode === value;
      return signalCode.slice(0, 2) === value.padStart(2, '0').slice(0, 2);
    }
    case 'sector':
      return hs2Sector(s.hs_code).toLowerCase() === value;
    case 'product':
      return (
        s.product_name.toLowerCase().includes(value) ||
        hs2Label(s.hs_code).toLowerCase().includes(value)
      );
    case 'country':
      return s.entity_slug === value.toLowerCase() || s.entity_name.toLowerCase() === value;
    default:
      return false;
  }
}

/**
 * For a followed product, find which activated market exports the most of it
 * (the push) and which imports the most (the pull). This is the "who is
 * pushing and who is pulling" view.
 *
 * Scoped to chapter-level world-total rows. trade_facts now holds specific HS6
 * lines and per-partner rows alongside the chapter totals, so an unscoped
 * query here would both scan an order of magnitude more rows and double-count
 * the same trade at two levels of detail.
 */
async function pushPull(env: Env, cfg: OracleConfig | null, sub: Subscription) {
  if (!cfg) return null;
  const hs =
    sub.kind === 'hs_code'
      ? sub.value.padStart(2, '0').slice(0, 2)
      : await hsForProduct(env, cfg, sub.value);
  if (!hs) return null;

  // Each active country's trade in this chapter, summed from its scored lines in the latest year (from Oracle).
  const data = await loadCountryDataForCode(env, cfg, hs).catch(() => []);
  const totals = new Map<string, { name: string; slug: string; flow: 'export' | 'import'; value_usd: number }>();
  for (const { e, feed } of data) {
    for (const i of feed.products) {
      if (i.year !== feed.latest_year || !i.code.startsWith(hs)) continue;
      const flow = i.flow === 'X' ? 'export' : 'import';
      const key = `${e.slug}|${flow}`;
      const cur = totals.get(key) ?? { name: e.name, slug: e.slug, flow, value_usd: 0 };
      cur.value_usd += i.value_usd;
      totals.set(key, cur);
    }
  }
  const rows = [...totals.values()].sort((a, b) => b.value_usd - a.value_usd);
  if (rows.length === 0) return null;

  const exporters = rows.filter((r) => r.flow === 'export').slice(0, 3);
  const importers = rows.filter((r) => r.flow === 'import').slice(0, 3);
  if (exporters.length === 0 && importers.length === 0) return null;

  const label = hs2Label(hs);
  const bn = (v: number) => `$${(v / 1e9).toFixed(2)}bn`;

  const pushText = exporters.length
    ? `Pushing it out: ${exporters.map((e) => `${e.name} (${bn(e.value_usd)})`).join(', ')}.`
    : '';
  const pullText = importers.length
    ? `Pulling it in: ${importers.map((e) => `${e.name} (${bn(e.value_usd)})`).join(', ')}.`
    : '';

  return {
    title: `Who is buying and selling ${label.toLowerCase()}`,
    body: `${pushText} ${pullText}`.trim(),
    payload: {
      hs_code: hs,
      exporters: exporters.map((e) => ({ name: e.name, slug: e.slug, value_usd: e.value_usd })),
      importers: importers.map((e) => ({ name: e.name, slug: e.slug, value_usd: e.value_usd })),
      note: 'Covers activated markets only.',
    },
  };
}

/** Best-effort map from a free-text product to the HS chapter holding the most trade in it, asked of Oracle. */
async function hsForProduct(env: Env, cfg: OracleConfig, text: string): Promise<string | null> {
  const words = text.trim().toLowerCase().split(/[^a-z0-9]+/).filter((w) => w.length > 1);
  if (words.length === 0) return null;
  const found = await oracleCatalogue(env, cfg, { tokens: words, codes: [], limit: 1 }).catch(() => null);
  return found?.[0]?.hs_code.slice(0, 2) ?? null;
}

async function countryMove(env: Env, cfg: OracleConfig | null, slugOrIso: string) {
  if (!cfg) return null;
  const entity = await env.DB.prepare(
    `SELECT id, slug, name, iso3 FROM entities
      WHERE (slug = ? OR lower(iso3) = lower(?)) AND is_active = 1`,
  )
    .bind(slugOrIso.toLowerCase(), slugOrIso)
    .first<{ id: string; slug: string; name: string; iso3: string | null }>();
  if (!entity?.iso3) return null;

  const dash = await oracleDashboard(cfg, entity.iso3).catch(() => null);
  const o = dash?.overview;
  if (!o) return null;

  const bn = (v: number) => `$${(v / 1e9).toFixed(1)}bn`;
  const dir = o.balance_usd >= 0 ? 'surplus' : 'deficit';
  const move =
    o.export_yoy_pct == null
      ? ''
      : ` Exports moved ${o.export_yoy_pct > 0 ? 'up' : 'down'} ${Math.abs(o.export_yoy_pct).toFixed(0)}% on the year.`;

  return {
    entity_id: entity.id,
    title: `${entity.name}: ${bn(o.export_usd)} out, ${bn(o.import_usd)} in`,
    body: `${entity.name} ran a trade ${dir} of ${bn(Math.abs(o.balance_usd))} in ${o.year}.${move}`,
    payload: { slug: entity.slug, ...o },
  };
}

interface ActiveEntity { id: string; slug: string; name: string; iso3: string | null }
async function activeEntities(env: Env): Promise<ActiveEntity[]> {
  const { results } = await env.DB.prepare(`SELECT id, slug, name, iso3 FROM entities WHERE kind = 'country' AND is_active = 1`).all<ActiveEntity>();
  return results ?? [];
}

/** The scored lines that could matter to one subscription, found inside Oracle and shaped as signals. */
async function signalsFor(
  env: Env,
  cfg: OracleConfig | null,
  sub: Subscription,
  entities: ActiveEntity[],
  cache: Map<string, SignalRow[]>,
): Promise<SignalRow[]> {
  if (!cfg) return [];
  const value = sub.value.trim().toLowerCase();
  const p = { tokens: [] as string[], codes: [] as string[], prefix: '', flow: '', iso3s: [] as string[], limit: 200 };
  if (sub.kind === 'hs_code') p.prefix = value.replace(/\D/g, '').slice(0, 6);
  else if (sub.kind === 'product') p.tokens = value.split(/[^a-z0-9]+/).filter((w) => w.length > 1).slice(0, 8);
  else if (sub.kind === 'country') {
    const e = entities.find((x) => x.slug === value || x.name.toLowerCase() === value || x.iso3?.toLowerCase() === value);
    if (!e?.iso3) return [];
    p.iso3s = [e.iso3];
  } else p.limit = 800; // a sector spans chapters, so take the best-scoring lines and filter by sector below
  const key = JSON.stringify(p);
  const hit = cache.get(key);
  if (hit) return hit;
  const found = await searchProducts(env, cfg, { ...p, iso3s: p.iso3s.length ? p.iso3s : entities.map((e) => e.iso3).filter((x): x is string => !!x) });
  const byIso = new Map(entities.map((e) => [e.iso3, e]));
  const rows: SignalRow[] = (found?.products ?? [])
    .filter((i) => byIso.has(i.reporter) && i.cagr_3y != null && i.cagr_3y > 0)
    .map((i) => {
      const e = byIso.get(i.reporter)!;
      return {
        id: `${i.reporter}-${i.flow}-${i.code}`,
        entity_id: e.id,
        entity_slug: e.slug,
        entity_name: e.name,
        hs_code: i.code,
        product_name: itemName(i),
        flow: i.flow === 'X' ? 'export' : 'import',
        cagr_3y: i.cagr_3y,
        momentum: i.score / 100,
        current_rank: null,
        projected_rank: null,
        horizon_years: 0,
        rationale: feedRationale(i),
      } satisfies SignalRow;
    });
  cache.set(key, rows);
  return rows;
}
interface FeedDraft {
  user_id: string;
  kind: string;
  title: string;
  body: string;
  payload: unknown;
  entity_id: string | null;
  premium_only: 0 | 1;
  dedupe_key: string;
}

async function writeFeed(env: Env, drafts: FeedDraft[], _runId: string): Promise<number> {
  if (drafts.length === 0) return 0;
  const CHUNK = 25;
  let written = 0;
  for (let i = 0; i < drafts.length; i += CHUNK) {
    const chunk = drafts.slice(i, i + CHUNK);
    const res = await env.DB.batch(
      chunk.map((d) =>
        env.DB.prepare(
          `INSERT OR IGNORE INTO feed_items
             (id, user_id, kind, title, body, payload, entity_id, premium_only, dedupe_key)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          uid('fee_'),
          d.user_id,
          d.kind,
          d.title.slice(0, 200),
          d.body.slice(0, 2000),
          JSON.stringify(d.payload),
          d.entity_id,
          d.premium_only,
          d.dedupe_key,
        ),
      ),
    );
    written += res.reduce((sum, r) => sum + (r.meta?.changes ?? 0), 0);
  }
  return written;
}

/** ISO-week key like 2026-W36, so a re-run inside the same week is a no-op. */
function isoWeekKey(d: Date): string {
  const date = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
  const day = date.getUTCDay() || 7;
  date.setUTCDate(date.getUTCDate() + 4 - day);
  const yearStart = new Date(Date.UTC(date.getUTCFullYear(), 0, 1));
  const week = Math.ceil(((date.getTime() - yearStart.getTime()) / 86_400_000 + 1) / 7);
  return `${date.getUTCFullYear()}-W${String(week).padStart(2, '0')}`;
}
