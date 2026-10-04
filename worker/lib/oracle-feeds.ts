import type { Env } from './db';
import { oracleJson, type OracleConfig } from './oracle';
import { ISO3_NAME } from '../agent/country-names';
import { hs6Label } from '../agent/codes';
import type { ExploreOpportunity, Overview, RankedItem } from '../../shared/types';

/**
 * Cross-country feeds built from the precomputed Oracle payloads.
 *
 * Oracle returns every product above a noise floor with its score and growth. Which of them are
 * "traditional" (not for SMEs) is the admin's call, held in D1, so it is applied here and a change in
 * the Owner portal takes effect immediately. Nothing in this file filters by chapter on its own.
 */

export interface FeedEntity {
  id: string;
  slug: string;
  name: string;
  iso3: string;
  continent: string | null;
}

export interface FeedItem {
  flow: 'X' | 'M';
  code: string;
  level: string;
  name: string | null;
  year: number;
  value_usd: number;
  cagr_3y: number | null;
  yoy_pct: number | null;
  score: number;
  confidence: 'high' | 'medium' | 'low';
  signal: string;
  top_partner: string | null;
  top_share_pct: number | null;
  partner_count: number | null;
  unit_value_usd_t: number | null;
  years_available: number | null;
  trend: string | null;
  partners?: Array<{ iso3: string; name: string; value_usd: number }>;
}

export interface ProductsFeed {
  reporter: string;
  latest_year: number;
  count: number;
  products: FeedItem[];
}

export interface DashboardPayload {
  overview: Overview;
  top_exports: RankedItem[];
  top_imports: RankedItem[];
  partners_export: RankedItem[];
  partners_import: RankedItem[];
  trend: Array<{ year: number; export_usd: number; import_usd: number; balance_usd: number }>;
  computed_at: string | null;
}

/** Active countries that have an ISO3 code, optionally narrowed by continent or slug. */
export async function feedEntities(
  db: D1Database,
  filter: { continent?: string; slug?: string } = {},
): Promise<FeedEntity[]> {
  const clauses = ["kind = 'country'", 'is_active = 1', 'iso3 IS NOT NULL'];
  const binds: unknown[] = [];
  if (filter.continent) {
    clauses.push('continent = ?');
    binds.push(filter.continent);
  }
  if (filter.slug) {
    clauses.push('slug = ?');
    binds.push(filter.slug);
  }
  const { results } = await db
    .prepare(`SELECT id, slug, name, iso3, continent FROM entities WHERE ${clauses.join(' AND ')} ORDER BY name`)
    .bind(...binds)
    .all<FeedEntity>();
  return results ?? [];
}

export const oracleProducts = (cfg: OracleConfig, iso3: string) =>
  oracleJson<ProductsFeed>(cfg, { route: 'products', iso3 });

export const oracleDashboard = (cfg: OracleConfig, iso3: string) =>
  oracleJson<DashboardPayload>(cfg, { route: 'dashboard', iso3 });

/** The score is out of 100 here; the app's shared score takes 0 to 1 for its momentum term. */
export const CONFIDENCE_WEIGHT = { high: 0.9, medium: 0.6, low: 0.3 } as const;

export function flowName(f: 'X' | 'M'): 'export' | 'import' {
  return f === 'X' ? 'export' : 'import';
}

/** Curated product label first, then what Comtrade called it. */
export function itemName(i: FeedItem): string {
  return hs6Label(i.code, i.name);
}

export function partnerLabel(iso3: string | null): string | null {
  return iso3 ? (ISO3_NAME[iso3] ?? iso3) : null;
}

/** Only the latest year of each line: older rows are products that stopped being reported. */
export function currentItems(feed: ProductsFeed): FeedItem[] {
  return feed.products.filter((p) => p.year === feed.latest_year);
}

const usd = (v: number) =>
  v >= 1e9 ? `$${(v / 1e9).toFixed(2)} billion` : v >= 1e6 ? `$${(v / 1e6).toFixed(1)} million` : `$${Math.round(v / 1e3)} thousand`;

/** One sentence from the figures, with nothing the data does not support. */
export function feedRationale(i: FeedItem): string {
  const parts = [`${i.flow === 'M' ? 'Imports' : 'Exports'} reached ${usd(i.value_usd)} in ${i.year}.`];
  if (i.cagr_3y != null) parts.push(`That is ${i.cagr_3y > 0 ? '+' : ''}${i.cagr_3y.toFixed(1)}% a year over three years.`);
  if (i.top_partner && i.top_share_pct != null) {
    parts.push(`${partnerLabel(i.top_partner)} accounts for ${i.top_share_pct.toFixed(0)}% of it.`);
  }
  return parts.join(' ');
}

export function toExplore(e: FeedEntity, i: FeedItem, category: 'traditional' | 'non_traditional'): ExploreOpportunity & { hs_code: string } {
  return {
    id: `${e.slug}-${i.flow}-${i.code}`,
    kind: 'product',
    slug: e.slug,
    country: e.name,
    iso3: e.iso3,
    continent: e.continent ?? '',
    name: itemName(i),
    flow: flowName(i.flow),
    year: i.year,
    value_usd: i.value_usd,
    growth_pct: i.cagr_3y,
    rank: null,
    momentum: i.score / 100,
    rationale: feedRationale(i),
    partners: (i.partners ?? []).map((p) => ({ iso3: p.iso3, name: p.name, value_usd: p.value_usd, detail_available: true })),
    category,
    hs_code: i.code,
  };
}

export type FeedEnv = Pick<Env, 'DB'>;
