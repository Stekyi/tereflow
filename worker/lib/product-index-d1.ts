import type { Env } from './db';
import type { FeedEntity, FeedItem, ProductsFeed } from './oracle-feeds';
import { oracleSearch } from './oracle-feeds';
import type { OracleConfig } from './oracle';
import { openOracleBreaker, oracleBreakerOpen } from './oracle-health';

/**
 * ORDS first, D1 behind it, for the product index.
 *
 * Oracle answers product search, product detail and the typeahead. D1 holds a copy of the same index
 * (`product_index`, refreshed by `python -m tereflow_oracle sync-index-d1`), read only when Oracle fails or its breaker is
 * open. A fallback answer can be as old as the last sync, so callers mark it with `x-data-source: d1-fallback`.
 */
export type IndexItem = FeedItem & { reporter: string };
export interface SearchParams { tokens: string[]; codes: string[]; prefix: string; flow: string; iso3s: string[]; limit: number }
export type Source = 'oracle' | 'd1';

interface Row {
  reporter_iso3: string; flow: 'X' | 'M'; cmd_code: string; level: string | null; product_name: string | null; year: number;
  value_usd: number | null; cagr_3y: number | null; yoy_pct: number | null; score: number; confidence: string | null;
  signal: string | null; top_partner: string | null; top_share_pct: number | null; partner_count: number | null;
  unit_value_usd_t: number | null; years_available: number | null; trend: string | null;
}

const toItem = (r: Row): IndexItem => ({
  reporter: r.reporter_iso3,
  flow: r.flow,
  code: r.cmd_code,
  level: r.level ?? '',
  name: r.product_name,
  year: r.year,
  value_usd: r.value_usd ?? 0,
  cagr_3y: r.cagr_3y,
  yoy_pct: r.yoy_pct,
  score: r.score,
  confidence: (r.confidence as FeedItem['confidence']) ?? 'low',
  signal: r.signal ?? '',
  top_partner: r.top_partner,
  top_share_pct: r.top_share_pct,
  partner_count: r.partner_count,
  unit_value_usd_t: r.unit_value_usd_t,
  years_available: r.years_available,
  trend: r.trend,
});

const COLS = `reporter_iso3, flow, cmd_code, level, product_name, year, value_usd, cagr_3y, yoy_pct, score, confidence, signal,
  top_partner, top_share_pct, partner_count, unit_value_usd_t, years_available, trend`;

/** Same matching as the ORDS route: any token inside the name, a mapped code, or a code prefix. Wider is fine, the caller re-ranks. */
export interface SearchResult { total: number; exports: number; imports: number; markets: number; products: IndexItem[] }
export async function d1Search(db: D1Database, p: SearchParams): Promise<SearchResult> {
  const where: string[] = [];
  const binds: unknown[] = [];
  const any: string[] = [];
  for (const t of p.tokens.slice(0, 8)) {
    const clean = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean) { any.push('lower(product_name) LIKE ?'); binds.push(`%${clean}%`); }
  }
  const codes = p.codes.map((c) => c.replace(/\D/g, '')).filter(Boolean).slice(0, 20);
  if (codes.length) { any.push(`cmd_code IN (${codes.map(() => '?').join(',')})`); binds.push(...codes); }
  const prefix = p.prefix.replace(/\D/g, '');
  if (prefix) { any.push('cmd_code LIKE ?'); binds.push(`${prefix}%`); }
  if (any.length) where.push(`(${any.join(' OR ')})`);
  if (p.flow === 'export' || p.flow === 'import') { where.push('flow = ?'); binds.push(p.flow === 'export' ? 'X' : 'M'); }
  if (p.iso3s.length && p.iso3s.length <= 40) { where.push(`reporter_iso3 IN (${p.iso3s.map(() => '?').join(',')})`); binds.push(...p.iso3s); }
  const w = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const [rows, count] = await Promise.all([
    db.prepare(`SELECT ${COLS} FROM product_index ${w} ORDER BY score DESC, value_usd DESC LIMIT ?`).bind(...binds, p.limit).all<Row>(),
    db.prepare(`SELECT COUNT(*) AS n, SUM(CASE WHEN flow = 'X' THEN 1 ELSE 0 END) AS x, SUM(CASE WHEN flow = 'M' THEN 1 ELSE 0 END) AS m, COUNT(DISTINCT reporter_iso3) AS c FROM product_index ${w}`).bind(...binds).first<{ n: number; x: number | null; m: number | null; c: number }>(),
  ]);
  return { total: count?.n ?? 0, exports: count?.x ?? 0, imports: count?.m ?? 0, markets: count?.c ?? 0, products: (rows.results ?? []).map(toItem) };
}

/** Product search: Oracle, then D1. Null only when the ORDS route is not defined yet (the caller has a legacy path). */
export async function searchProducts(
  env: Env,
  cfg: OracleConfig,
  p: SearchParams,
): Promise<(SearchResult & { source: Source }) | null> {
  if (!oracleBreakerOpen()) {
    try {
      const r = await oracleSearch(cfg, { ...p });
      return r ? { ...r, source: 'oracle' } : null;
    } catch {
      openOracleBreaker(60);
    }
  }
  return { ...(await d1Search(env.DB, p)), source: 'd1' };
}

/** The chapter's lines across every country, with each country's latest year and trade totals, from D1. */
export async function d1CountryFeeds(
  db: D1Database,
  entities: FeedEntity[],
  hs: string,
): Promise<Array<{ e: FeedEntity; feed: ProductsFeed; totals: { export_usd: number; import_usd: number } | null }>> {
  const [lines, meta] = await Promise.all([
    db.prepare(`SELECT ${COLS} FROM product_index WHERE cmd_code LIKE ? ORDER BY score DESC LIMIT 2500`).bind(`${hs.slice(0, 2)}%`).all<Row>(),
    db.prepare('SELECT reporter_iso3, latest_year, export_usd, import_usd FROM product_index_meta').all<{
      reporter_iso3: string; latest_year: number; export_usd: number | null; import_usd: number | null;
    }>(),
  ]);
  const byIso = new Map<string, FeedItem[]>();
  for (const r of lines.results ?? []) byIso.set(r.reporter_iso3, [...(byIso.get(r.reporter_iso3) ?? []), toItem(r)]);
  const metaIso = new Map((meta.results ?? []).map((m) => [m.reporter_iso3, m]));
  return entities.flatMap((e) => {
    const m = metaIso.get(e.iso3);
    if (!m) return [];
    const products = byIso.get(e.iso3) ?? [];
    return [{
      e,
      feed: { reporter: e.iso3, latest_year: m.latest_year, count: products.length, products },
      totals: { export_usd: m.export_usd ?? 0, import_usd: m.import_usd ?? 0 },
    }];
  });
}

/** Distinct 6-digit products matching a search, from D1. */
export async function d1Catalogue(
  db: D1Database,
  p: { tokens: string[]; codes: string[]; limit: number },
): Promise<Array<{ hs_code: string; product_name: string | null; total_value: number }>> {
  const any: string[] = [];
  const binds: unknown[] = [];
  for (const t of p.tokens.slice(0, 8)) {
    const clean = t.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (clean) { any.push('lower(p.product_name) LIKE ?'); binds.push(`%${clean}%`); }
  }
  const codes = p.codes.map((c) => c.replace(/\D/g, '')).filter(Boolean).slice(0, 20);
  if (codes.length) { any.push(`substr(p.cmd_code, 1, 6) IN (${codes.map(() => '?').join(',')})`); binds.push(...codes); }
  const w = any.length ? `WHERE ${any.join(' OR ')}` : '';
  const { results } = await db.prepare(
    `SELECT substr(p.cmd_code, 1, 6) AS hs_code,
            MAX(CASE WHEN length(p.cmd_code) = 6 THEN p.product_name END) AS product_name,
            SUM(p.value_usd) AS total_value
       FROM product_index p
       JOIN product_index_meta m ON m.reporter_iso3 = p.reporter_iso3 AND p.year = m.latest_year
       ${w}
      GROUP BY substr(p.cmd_code, 1, 6)
      ORDER BY total_value DESC LIMIT ?`,
  ).bind(...binds, p.limit).all<{ hs_code: string; product_name: string | null; total_value: number }>();
  return results ?? [];
}
