import type { Env } from '../lib/db';
import { uid } from '../lib/db';
import { hs2Sector, hs2Label } from './codes';

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

  const { results: signalRows } = await env.DB.prepare(
    `SELECT s.id, s.entity_id, e.slug AS entity_slug, e.name AS entity_name,
            s.hs_code, s.product_name, s.flow, s.cagr_3y, s.momentum,
            s.current_rank, s.projected_rank, s.horizon_years, s.rationale
       FROM opportunity_signals s
       JOIN entities e ON e.id = s.entity_id
      WHERE e.is_active = 1
      ORDER BY s.momentum DESC`,
  ).all<SignalRow>();
  const signals = signalRows ?? [];

  const pending: FeedDraft[] = [];

  for (const sub of subscriptions) {
    const matched = signals.filter((s) => matches(sub, s)).slice(0, 4);

    for (const s of matched) {
      // Export and import signals for the same product would otherwise produce
      // two identically titled cards, which reads as a duplicate.
      const side = s.flow === 'export' ? 'sells' : 'buys';
      pending.push({
        user_id: sub.user_id,
        kind: 'signal',
        title: `${s.entity_name} ${side} more ${s.product_name.toLowerCase()} every year`,
        body:
          `${s.rationale ?? ''} ` +
          `Projected to reach rank ${s.projected_rank ?? '?'} within ${s.horizon_years} years, ` +
          `from rank ${s.current_rank ?? '?'} today.`,
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
      const balance = await pushPull(env, sub);
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
      const country = await countryMove(env, sub.value);
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
    case 'hs_code':
      return (s.hs_code ?? '').padStart(2, '0').slice(0, 2) === value.padStart(2, '0').slice(0, 2);
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
 */
async function pushPull(env: Env, sub: Subscription) {
  const hs =
    sub.kind === 'hs_code'
      ? sub.value.padStart(2, '0').slice(0, 2)
      : await hsForProduct(env, sub.value);
  if (!hs) return null;

  const { results } = await env.DB.prepare(
    `SELECT e.name, e.slug, f.flow, f.value_usd, f.year
       FROM trade_facts f
       JOIN entities e ON e.id = f.entity_id
      WHERE f.hs_code = ? AND f.stream = 'goods' AND e.is_active = 1
        AND f.year = (SELECT MAX(year) FROM trade_facts WHERE hs_code = ? AND entity_id = f.entity_id)
      ORDER BY f.value_usd DESC`,
  )
    .bind(hs, hs)
    .all<{ name: string; slug: string; flow: 'export' | 'import'; value_usd: number; year: number }>();

  const rows = results ?? [];
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

/** Best-effort map from a free-text product to an HS chapter we hold data for. */
async function hsForProduct(env: Env, text: string): Promise<string | null> {
  const row = await env.DB.prepare(
    `SELECT hs_code FROM trade_facts
      WHERE hs_code IS NOT NULL AND lower(product_name) LIKE ?
      GROUP BY hs_code ORDER BY SUM(value_usd) DESC LIMIT 1`,
  )
    .bind(`%${text.trim().toLowerCase()}%`)
    .first<{ hs_code: string }>();
  return row?.hs_code ?? null;
}

async function countryMove(env: Env, slugOrIso: string) {
  const entity = await env.DB.prepare(
    `SELECT id, slug, name FROM entities
      WHERE (slug = ? OR lower(iso3) = lower(?)) AND is_active = 1`,
  )
    .bind(slugOrIso.toLowerCase(), slugOrIso)
    .first<{ id: string; slug: string; name: string }>();
  if (!entity) return null;

  const row = await env.DB.prepare(
    "SELECT payload FROM analysis_results WHERE entity_id = ? AND kind = 'overview'",
  )
    .bind(entity.id)
    .first<{ payload: string }>();
  if (!row) return null;

  let o: {
    year: number;
    export_usd: number;
    import_usd: number;
    balance_usd: number;
    export_yoy_pct: number | null;
  };
  try {
    o = JSON.parse(row.payload);
  } catch {
    return null;
  }

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
