import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { attachSources, bad, getEntityBySlug, json } from '../lib/db';
import { currentUser, isEntitled } from '../lib/session';
import { hs2Label, hs2Sector, hs6Label } from '../agent/codes';
import { shortProductName } from '../../shared/product-name';
import { opportunityScore } from '../../shared/opportunity';
import { buildProductInsight } from '../lib/product-insight';
import { loadSettings } from '../lib/settings';
import {
  classify,
  dominantCodes,
  loadClassifications,
  loadClassificationsBulk,
  resolveForEntity,
} from '../lib/classify';
import type {
  CountryDashboard,
  CountrySummary,
  Entity,
  ExploreOpportunity,
  ExportClassification,
  Flow,
  MarketProducts,
  OpportunitySignal,
  ProductBreakdown,
  ProductBreakdownRow,
  ProductCard,
  ProductCountry,
  ProductDetail,
  RankedItem,
  Recommendation,
  TrendPoint,
  Overview,
} from '../../shared/types';

export const pub = new Hono<{ Bindings: Env }>();

/** Directory. Only activated records are visible publicly. */
pub.get('/entities', async (c) => {
  const kind = c.req.query('kind');
  const continent = c.req.query('continent');
  const q = c.req.query('q');
  const all = c.req.query('all') === '1';

  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (!all) clauses.push('is_active = 1');
  if (kind) {
    clauses.push('kind = ?');
    binds.push(kind);
  }
  if (continent) {
    clauses.push('continent = ?');
    binds.push(continent);
  }
  if (q) {
    clauses.push('(name LIKE ? OR iso3 LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';

  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, name, kind, continent, iso3, iso2, agency_name, homepage,
            is_active, coverage_score, last_ingest_at
       FROM entities ${where}
      ORDER BY kind = 'country' DESC, continent, name`,
  )
    .bind(...binds)
    .all<Entity>();

  return json({ entities: results ?? [], count: results?.length ?? 0 });
});

/** Counts for the home screen. */
pub.get('/stats', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT
       (SELECT COUNT(*) FROM entities WHERE kind='country')            AS countries,
       (SELECT COUNT(*) FROM entities WHERE kind='country' AND is_active=1) AS countries_active,
       (SELECT COUNT(*) FROM entities WHERE kind='intl_org')           AS orgs,
       (SELECT COUNT(*) FROM entities WHERE kind='regional_body')      AS regional,
       (SELECT COUNT(*) FROM entity_sources)                           AS sources,
       (SELECT COUNT(*) FROM trade_facts)                              AS facts,
       (SELECT MAX(finished_at) FROM analysis_runs WHERE status IN ('ok','partial')) AS last_run`,
  ).first();
  return json(row ?? {});
});

export async function loadResult<T>(db: D1Database, entityId: string, kind: string): Promise<T | null> {
  const row = await db
    .prepare('SELECT payload FROM analysis_results WHERE entity_id = ? AND kind = ?')
    .bind(entityId, kind)
    .first<{ payload: string }>();
  if (!row) return null;
  try {
    return JSON.parse(row.payload) as T;
  } catch {
    return null;
  }
}

/**
 * The country dashboard.
 * Premium gating: opportunity signals are counted for everyone but only
 * returned when the caller is on a premium tier.
 */
pub.get('/dashboard/:slug', async (c) => {
  const entity = await getEntityBySlug(c.env.DB, c.req.param('slug'));
  if (!entity) return bad('Not found', 404);
  if (!entity.is_active) {
    return json(
      {
        entity,
        inactive: true,
        message:
          'This country is registered but not yet activated, so no analysis has been produced.',
      },
      200,
    );
  }

  // The gate is the signed-in user's entitlement. A client header cannot buy
  // premium, and a lapsed subscription stops working on its expiry date.
  const viewer = await currentUser(c.req.raw, c.env);
  const isPremium = isEntitled(viewer);

  const [overview, topExports, topImports, services, partnersExport, partnersImport, trend, recs] =
    await Promise.all([
      loadResult<Overview>(c.env.DB, entity.id, 'overview'),
      loadResult<RankedItem[]>(c.env.DB, entity.id, 'top_exports'),
      loadResult<RankedItem[]>(c.env.DB, entity.id, 'top_imports'),
      loadResult<RankedItem[]>(c.env.DB, entity.id, 'services'),
      loadResult<RankedItem[]>(c.env.DB, entity.id, 'partners_export'),
      loadResult<RankedItem[]>(c.env.DB, entity.id, 'partners_import'),
      loadResult<TrendPoint[]>(c.env.DB, entity.id, 'yearly_trend'),
      loadResult<Recommendation[]>(c.env.DB, entity.id, 'recommendations'),
    ]);

  const { results: signals } = await c.env.DB.prepare(
    `SELECT id, hs_code, product_name, flow, cagr_3y, momentum,
            current_rank, projected_rank, horizon_years, confidence, rationale
       FROM opportunity_signals
      WHERE entity_id = ?
      ORDER BY momentum DESC
      LIMIT 12`,
  )
    .bind(entity.id)
    .all<OpportunitySignal>();

  const computed = await c.env.DB.prepare(
    'SELECT MAX(computed_at) AS at FROM analysis_results WHERE entity_id = ?',
  )
    .bind(entity.id)
    .first<{ at: string | null }>();

  // Traditional vs non-traditional: tag each product row so the UI can badge
  // cocoa/gold-style bulk commodities differently from what an SME could
  // actually enter. Partner rows have no HS code and are left untagged.
  const classifications = await loadClassifications(c.env.DB, entity.id);
  const settings = await loadSettings(c.env);
  const dominant = dominantCodes(overview?.export_chapter_shares, settings.dominantShareThreshold);
  const tagProducts = (items: RankedItem[]) =>
    items.map((r) => ({ ...r, category: classify(r.code, classifications, dominant) }));

  const payload: CountryDashboard = {
    entity,
    overview,
    top_exports: tagProducts(topExports ?? []),
    top_imports: tagProducts(topImports ?? []),
    services: services ?? [],
    partners_export: partnersExport ?? [],
    partners_import: partnersImport ?? [],
    trend: trend ?? [],
    recommendations: recs ?? [],
    opportunities: isPremium ? (signals ?? []) : null,
    opportunities_locked: isPremium ? 0 : (signals?.length ?? 0),
    computed_at: computed?.at ?? null,
  };

  // Cached only for anonymous readers. The payload's `opportunities` field
  // depends on the caller's entitlement, so caching it for a signed-in reader
  // means somebody who just upgraded keeps seeing the locked version for the
  // rest of the window, and any cache that ignored `private` would be holding
  // one reader's entitlement level and serving it to another.
  return json(
    payload,
    200,
    viewer
      ? { 'cache-control': 'no-store', vary: 'Cookie' }
      : { 'cache-control': 'public, max-age=300', vary: 'Cookie' },
  );
});

/** Where the numbers came from — shown under every dashboard. */
pub.get('/dashboard/:slug/sources', async (c) => {
  const entity = await getEntityBySlug(c.env.DB, c.req.param('slug'));
  if (!entity) return bad('Not found', 404);

  const { results: contributors } = await c.env.DB.prepare(
    `SELECT DISTINCT source_ref FROM trade_facts WHERE entity_id = ?`,
  )
    .bind(entity.id)
    .all<{ source_ref: string }>();

  return json({
    official: entity.sources,
    harmonised: (contributors ?? []).map((r) => r.source_ref),
    note:
      'Official national publications are listed for citation and are health-checked weekly. ' +
      'The comparable figures charted above come from the harmonised sources so that ' +
      'countries can be compared on the same basis.',
  });
});

/** Product detail for the dashboard's clickable ranked rows. */
pub.get('/dashboard/:slug/products/:flow/:hsCode', async (c) => {
  const entity = await getEntityBySlug(c.env.DB, c.req.param('slug'));
  if (!entity) return bad('Not found', 404);

  const flow = c.req.param('flow');
  const hsCode = decodeURIComponent(c.req.param('hsCode'));
  if (flow !== 'export' && flow !== 'import') return bad('Invalid trade flow', 400);

  const product = await c.env.DB.prepare(
    `SELECT year, product_name, value_usd, qty, qty_unit
       FROM trade_facts
      WHERE entity_id = ? AND flow = ? AND stream = 'goods' AND hs_code = ?
        AND partner_iso3 IS NULL
      ORDER BY year DESC
      LIMIT 1`,
  )
    .bind(entity.id, flow, hsCode)
    .first<{
      year: number;
      product_name: string | null;
      value_usd: number;
      qty: number | null;
      qty_unit: string | null;
    }>();

  if (!product) return bad('Product breakdown not found', 404);

  const detailed = await c.env.DB.prepare(
    `SELECT partner_iso3, partner_name, SUM(value_usd) AS value_usd,
            SUM(qty) AS qty, MAX(qty_unit) AS qty_unit
       FROM trade_facts
      WHERE entity_id = ? AND year = ? AND flow = ? AND stream = 'goods'
        AND hs_code = ? AND partner_iso3 IS NOT NULL
      GROUP BY partner_iso3, partner_name, qty_unit
      ORDER BY value_usd DESC`,
  )
    .bind(entity.id, product.year, flow, hsCode)
    .all<ProductBreakdownRow>();

  const detailAvailable = (detailed.results?.length ?? 0) > 0;
  const rows = detailAvailable
    ? detailed.results ?? []
    : (
        await c.env.DB.prepare(
          `SELECT partner_iso3, partner_name, value_usd, qty, qty_unit
             FROM trade_facts
            WHERE entity_id = ? AND year = ? AND flow = ? AND stream = 'goods'
              AND hs_code IS NULL AND partner_iso3 IS NOT NULL
            ORDER BY value_usd DESC`,
        )
          .bind(entity.id, product.year, flow)
          .all<ProductBreakdownRow>()
      ).results ?? [];

  const response: ProductBreakdown = {
    product_name: product.product_name ?? hsCode,
    hs_code: hsCode,
    flow,
    year: product.year,
    product_value_usd: product.value_usd,
    product_qty: product.qty,
    product_qty_unit: product.qty_unit,
    detail_available: detailAvailable,
    note: detailAvailable
      ? 'Partner rows are reported for this product.'
      : 'Product-level partner detail was not published. Showing the available partner totals for this trade flow.',
    rows,
  };

  return json(response, 200, { 'cache-control': 'private, max-age=300' });
});

/** Cross-country league table for the explore screen. */
pub.get('/rankings', async (c) => {
  const metric = c.req.query('metric') ?? 'export';
  const column = metric === 'import' ? 'import_usd' : 'export_usd';
  const { results } = await c.env.DB.prepare(
    `SELECT e.slug, e.name, e.iso3, e.continent, r.payload
       FROM entities e
       JOIN analysis_results r ON r.entity_id = e.id AND r.kind = 'overview'
      WHERE e.is_active = 1 AND e.kind = 'country'`,
  ).all<{ slug: string; name: string; iso3: string; continent: string; payload: string }>();

  const rows = (results ?? [])
    .map((r) => {
      let o: Overview | null = null;
      try {
        o = JSON.parse(r.payload);
      } catch {
        /* ignore malformed payload */
      }
      return {
        slug: r.slug,
        name: r.name,
        iso3: r.iso3,
        continent: r.continent,
        year: o?.year ?? null,
        value_usd: o ? ((o as unknown as Record<string, number>)[column] ?? 0) : 0,
        balance_usd: o?.balance_usd ?? 0,
      };
    })
    .filter((r) => r.value_usd > 0)
    .sort((a, b) => b.value_usd - a.value_usd)
    .map((r, i) => ({ ...r, rank: i + 1 }));

  return json({ metric, rows });
});

// --- product-first browsing -------------------------------------------------

/** How many specific product lines a browse request returns at most. */
const PRODUCT_PAGE = 60;

/**
 * The specific products an SME can look at, across every activated country.
 *
 * This is the app's front door. It reads opportunity_signals, which the
 * pipeline already writes one row per (country, product, flow) with the value,
 * growth, best market and momentum attached, so the hot path is a single
 * indexed read rather than a per-row join back into trade_facts.
 *
 * Traditional/gated lines (oil, mining, precious metals, a country's own
 * dominant legacy commodity) are hidden by default: an SME with working
 * capital cannot enter them, and burying the things it can enter underneath
 * them is exactly the complaint this endpoint exists to answer. Pass all=1
 * to include them.
 */
pub.get('/products', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const flow = c.req.query('flow');
  const continent = c.req.query('continent');
  const slug = c.req.query('country');
  const includeTraditional = c.req.query('all') === '1';
  const limit = Math.min(Number(c.req.query('limit') ?? PRODUCT_PAGE) || PRODUCT_PAGE, 120);

  const clauses = ['e.is_active = 1', 's.hs_code IS NOT NULL'];
  const binds: unknown[] = [];
  if (q) {
    clauses.push('(s.product_name LIKE ? OR s.hs_code LIKE ?)');
    binds.push(`%${q}%`, `${q}%`);
  }
  if (flow === 'export' || flow === 'import') {
    clauses.push('s.flow = ?');
    binds.push(flow);
  }
  if (continent) {
    clauses.push('e.continent = ?');
    binds.push(continent);
  }
  if (slug) {
    clauses.push('e.slug = ?');
    binds.push(slug);
  }

  /*
   * No page cap on the query.
   *
   * Signals are capped at SIGNALS_PER_COUNTRY when they are written, so the
   * whole table is a few hundred rows and would be a few thousand at ninety
   * countries. Fetching all of them and paging in memory costs nothing and
   * buys two things the previous LIMIT could not give: a `count` that is the
   * real total rather than the size of the page, and a summary that counts
   * every match rather than whatever happened to land in the first slice.
   */
  const { results } = await c.env.DB.prepare(
    `SELECT s.entity_id, s.hs_code, s.product_name, s.flow, s.year, s.value_usd,
            s.cagr_3y, s.momentum, s.confidence, s.best_market, s.best_market_iso3,
            s.best_market_product_specific,
            e.slug, e.name AS country, e.iso3, e.continent
       FROM opportunity_signals s
       JOIN entities e ON e.id = s.entity_id
      WHERE ${clauses.join(' AND ')}
      ORDER BY s.momentum DESC, s.cagr_3y DESC`,
  )
    .bind(...binds)
    .all<SignalRow>();

  const classifications = await loadClassificationsBulk(
    c.env.DB,
    (results ?? []).map((r) => r.entity_id),
  );

  const matched = (results ?? [])
    .map((r) => toProductCard(r, classifications))
    .filter((p) => includeTraditional || p.category !== 'traditional')
    .sort((a, b) => b.score - a.score);

  const settings = await loadSettings(c.env);

  /*
   * The figures the home page leads with.
   *
   * These follow the same filters as the list below them, so a reader who
   * narrows to Africa sees how many openings are in Africa, not a global
   * number sitting above an African list.
   */
  const summary = {
    total: matched.length,
    exports: matched.filter((p) => p.flow === 'export').length,
    imports: matched.filter((p) => p.flow === 'import').length,
    strong: matched.filter((p) => p.score >= settings.scoreBandStrong).length,
    markets: new Set(matched.map((p) => p.slug)).size,
    /** Biggest single line in view, so the scale of the list is visible. */
    largest_usd: matched.length ? Math.max(...matched.map((p) => p.value_usd)) : 0,
  };

  return json({ products: matched.slice(0, limit), count: matched.length, summary });
});

interface SignalRow {
  entity_id: string;
  hs_code: string;
  product_name: string | null;
  flow: Flow;
  year: number | null;
  value_usd: number | null;
  cagr_3y: number | null;
  momentum: number | null;
  confidence: number | null;
  best_market: string | null;
  best_market_iso3: string | null;
  best_market_product_specific: number | null;
  slug: string;
  country: string;
  iso3: string;
  continent: string;
}

function toProductCard(
  r: SignalRow,
  classifications: Map<string, Map<string, ExportClassification>>,
): ProductCard {
  const full = r.product_name ?? hs6Label(r.hs_code);
  return {
    hs_code: r.hs_code,
    name: shortProductName(full),
    name_full: full,
    sector: hs2Sector(r.hs_code),
    category: classify(r.hs_code, resolveForEntity(classifications, r.entity_id), new Set()),
    flow: r.flow,
    country: r.country,
    slug: r.slug,
    iso3: r.iso3,
    continent: r.continent,
    year: r.year ?? 0,
    value_usd: r.value_usd ?? 0,
    growth_pct: r.cagr_3y,
    score: opportunityScore({
      cagr_3y: r.cagr_3y,
      momentum: r.momentum,
      confidence: r.confidence,
      value_usd: r.value_usd,
    }),
    best_market: r.best_market,
    best_market_iso3: r.best_market_iso3,
    best_market_product_specific: r.best_market_product_specific === 1,
    has_signal: true,
    // A signal is only written when the years were comparable, so anything
    // reaching here already passed the truncation check in analyse.ts.
    partial_coverage: r.cagr_3y == null,
  };
}

/**
 * The product insight behind the modal.
 *
 * Reads precomputed analytics rather than aggregating on request. Pass
 * `?country=slug` to scope the headline figures to one country while keeping
 * the global lists, which is what the country page does.
 */
pub.get('/insight/:hs', async (c) => {
  const hs = c.req.param('hs').trim();
  if (!/^\d{2}$|^\d{6}$/.test(hs)) {
    return bad('hs must be a 2-digit chapter or 6-digit product code', 400);
  }
  const country = c.req.query('country')?.trim() || null;
  const flowParam = c.req.query('flow')?.trim();
  const flow = flowParam === 'export' || flowParam === 'import' ? flowParam : null;

  try {
    const insight = await buildProductInsight(c.env, hs, country, flow);
    return json(insight, 200, { 'cache-control': 'public, max-age=300', vary: 'Cookie' });
  } catch (err) {
    // A bare 500 on one product and not another is impossible to diagnose from
    // the outside. Log which product, and say so in the response, because the
    // modal can then tell the reader this product failed rather than showing
    // an empty shell.
    console.error(`insight failed for HS ${hs}`, err);
    return bad(`could not build the read for HS ${hs}: ${(err as Error).message}`, 500);
  }
});

/**
 * One product, everywhere it is traded.
 *
 * This backs the modal that opens when a product is tapped anywhere in the
 * app. It is deliberately not scoped to a country: tapping a product should
 * answer "who sells this, who buys it, where does it move", which is the
 * question, rather than navigating away into whichever country the row
 * happened to be listed under.
 */
pub.get('/products/:hs', async (c) => {
  const hs = c.req.param('hs').trim();
  if (!/^\d{2}$|^\d{6}$/.test(hs)) {
    return bad('hs must be a 2-digit chapter or 6-digit product code', 400);
  }
  const isSpecific = hs.length === 6;
  const chapter = hs.slice(0, 2);

  // Exact match, never a prefix.
  //
  // trade_facts holds the same trade at two levels: the HS2 chapter row and
  // its HS6 children. `hs_code LIKE '71%'` matches both, so a chapter page
  // summed every dollar twice: Ghana's chapter 71 read $40.35bn against a real
  // $20.18bn. Worse, it was not even a constant factor, because a year whose
  // HS6 detail was never fetched has no children to double, so the error
  // appeared and vanished from one year to the next.
  //
  // A chapter request reads the chapter row. A product request reads the
  // product row. Nothing sums across levels.
  const sideFor = async (flow: Flow): Promise<ProductCountry[]> => {
    const { results } = await c.env.DB.prepare(
      `WITH matched AS (
         SELECT entity_id, year, SUM(value_usd) AS value_usd
           FROM trade_facts
          WHERE hs_code = ? AND flow = ? AND stream = 'goods' AND partner_iso3 IS NULL
          GROUP BY entity_id, year
       ),
       latest AS (SELECT entity_id, MAX(year) AS year FROM matched GROUP BY entity_id)
       SELECT e.slug, e.name, e.iso3, e.continent, m.year, m.value_usd,
              sig.cagr_3y AS growth_pct, sig.best_market
         FROM matched m
         JOIN latest l ON l.entity_id = m.entity_id AND l.year = m.year
         JOIN entities e ON e.id = m.entity_id AND e.is_active = 1
         LEFT JOIN opportunity_signals sig
                ON sig.entity_id = m.entity_id AND sig.hs_code = ? AND sig.flow = ?
        ORDER BY m.value_usd DESC
        LIMIT ?`,
    )
      .bind(hs, flow, hs, flow, MARKET_TOP_N)
      .all<Omit<ProductCountry, 'rank'>>();
    return (results ?? []).map((r, i) => ({ ...r, rank: i + 1 }));
  };

  const [exporters, importers] = await Promise.all([sideFor('export'), sideFor('import')]);

  // Partner detail is reported per flow, not per product, on the keyless
  // Comtrade tier. Rows carrying this exact HS code are preferred and marked;
  // otherwise the country's overall partners are shown and marked as such, so
  // the difference is visible rather than implied.
  const { results: partnerRows } = await c.env.DB.prepare(
    `WITH latest AS (
       SELECT entity_id, flow, MAX(year) AS year
         FROM trade_facts
        WHERE stream = 'goods' AND partner_iso3 IS NOT NULL
        GROUP BY entity_id, flow
     )
     SELECT f.partner_iso3, f.partner_name, SUM(f.value_usd) AS value_usd,
            MAX(CASE WHEN f.hs_code = ? THEN 1 ELSE 0 END) AS product_specific
       FROM trade_facts f
       JOIN entities e ON e.id = f.entity_id AND e.is_active = 1
       JOIN latest l ON l.entity_id = f.entity_id AND l.flow = f.flow AND l.year = f.year
      WHERE f.stream = 'goods' AND f.partner_iso3 IS NOT NULL
        AND (f.hs_code = ? OR f.hs_code IS NULL)
      GROUP BY f.partner_iso3
      ORDER BY product_specific DESC, value_usd DESC
      LIMIT 8`,
  )
    .bind(hs, hs)
    .all<{
      partner_iso3: string | null;
      partner_name: string | null;
      value_usd: number;
      product_specific: number;
    }>();

  const { results: relatedRows } = isSpecific
    ? await c.env.DB.prepare(
        `SELECT hs_code, MAX(product_name) AS product_name, SUM(value_usd) AS value_usd
           FROM trade_facts
          WHERE hs_code LIKE ? AND hs_code <> ? AND length(hs_code) = 6
            AND stream = 'goods' AND partner_iso3 IS NULL
          GROUP BY hs_code
          ORDER BY value_usd DESC
          LIMIT 6`,
      )
        .bind(`${chapter}%`, hs)
        .all<{ hs_code: string; product_name: string | null; value_usd: number }>()
    : { results: [] };

  const nameRow = await c.env.DB.prepare(
    `SELECT product_name FROM trade_facts
      WHERE hs_code = ? AND product_name IS NOT NULL LIMIT 1`,
  )
    .bind(hs)
    .first<{ product_name: string }>();

  const full = nameRow?.product_name ?? (isSpecific ? hs6Label(hs) : hs2Label(hs));
  const globalClassifications = await loadClassifications(c.env.DB, '*');

  return json({
    hs_code: hs,
    name: shortProductName(full),
    name_full: full,
    sector: hs2Sector(hs),
    chapter,
    chapter_label: hs2Label(chapter),
    category: classify(hs, globalClassifications, new Set()),
    total_export_usd: exporters.reduce((s, r) => s + r.value_usd, 0),
    total_import_usd: importers.reduce((s, r) => s + r.value_usd, 0),
    exporters,
    importers,
    partners: (partnerRows ?? []).map((p) => ({
      name: p.partner_name ?? p.partner_iso3 ?? 'Unknown',
      iso3: p.partner_iso3,
      value_usd: p.value_usd,
      product_specific: p.product_specific === 1,
    })),
    related: (relatedRows ?? []).map((r) => ({
      hs_code: r.hs_code,
      name: shortProductName(r.product_name ?? hs6Label(r.hs_code)),
      value_usd: r.value_usd,
    })),
    partial_coverage: [...exporters, ...importers].some((r) => r.growth_pct == null),
  } satisfies ProductDetail);
});

/**
 * The countries index: one row per country with its headline figures.
 * Carries no product lists by design -- somebody who wanted a product would
 * have opened the product, and mixing the two is what made the old home page
 * unusable.
 */
pub.get('/countries', async (c) => {
  const continent = c.req.query('continent');
  const q = (c.req.query('q') ?? '').trim();

  const clauses = ["kind = 'country'"];
  const binds: unknown[] = [];
  if (continent) {
    clauses.push('continent = ?');
    binds.push(continent);
  }
  if (q) {
    clauses.push('(name LIKE ? OR iso3 LIKE ?)');
    binds.push(`%${q}%`, `%${q}%`);
  }

  const { results: entities } = await c.env.DB.prepare(
    `SELECT id, slug, name, iso3, continent, is_active, last_ingest_at
       FROM entities WHERE ${clauses.join(' AND ')}
      ORDER BY is_active DESC, continent, name`,
  )
    .bind(...binds)
    .all<{
      id: string;
      slug: string;
      name: string;
      iso3: string | null;
      continent: string | null;
      is_active: number;
      last_ingest_at: string | null;
    }>();

  const rows = entities ?? [];
  const ids = rows.filter((r) => r.is_active === 1).map((r) => r.id);

  // Opportunity counts for every listed country in one query. D1 caps bound
  // parameters at 100, so the id list is chunked rather than inlined.
  const counts = new Map<string, number>();
  for (let i = 0; i < ids.length; i += 90) {
    const chunk = ids.slice(i, i + 90);
    if (!chunk.length) continue;
    const { results } = await c.env.DB.prepare(
      `SELECT entity_id, COUNT(*) AS n FROM opportunity_signals
        WHERE entity_id IN (${chunk.map(() => '?').join(',')})
        GROUP BY entity_id`,
    )
      .bind(...chunk)
      .all<{ entity_id: string; n: number }>();
    for (const r of results ?? []) counts.set(r.entity_id, r.n);
  }

  const summaries = await Promise.all(
    rows.map(async (r): Promise<CountrySummary> => {
      const base = {
        slug: r.slug,
        name: r.name,
        iso3: r.iso3,
        continent: r.continent,
        is_active: r.is_active === 1,
        opportunities: counts.get(r.id) ?? 0,
        last_ingest_at: r.last_ingest_at,
      };
      if (r.is_active !== 1) {
        return {
          ...base,
          year: null,
          export_usd: null,
          import_usd: null,
          balance_usd: null,
          top_export: null,
          top_partner: null,
        };
      }
      const [overview, topExports, partners] = await Promise.all([
        loadResult<Overview>(c.env.DB, r.id, 'overview'),
        loadResult<RankedItem[]>(c.env.DB, r.id, 'top_exports'),
        loadResult<RankedItem[]>(c.env.DB, r.id, 'partners_export'),
      ]);
      const top = topExports?.[0];
      return {
        ...base,
        year: overview?.year ?? null,
        export_usd: overview?.export_usd ?? null,
        import_usd: overview?.import_usd ?? null,
        balance_usd: overview?.balance_usd ?? null,
        top_export: top ? shortProductName(top.name) : null,
        top_partner: partners?.[0]?.name ?? null,
      };
    }),
  );

  return json({ countries: summaries, count: summaries.length });
});

/** Public SME view: growing, non-headline products and available services. */
pub.get('/opportunities', async (c) => {
  const includeTraditional = c.req.query('all') === '1';

  const { results: productRows } = await c.env.DB.prepare(
    `SELECT s.id, s.entity_id, s.hs_code, 'product' AS kind, e.slug, e.name AS country, e.iso3, e.continent,
            s.product_name AS name, s.flow, f.year, f.value_usd,
            s.cagr_3y AS growth_pct, s.current_rank AS rank,
            s.momentum, s.rationale
       FROM opportunity_signals s
       JOIN entities e ON e.id = s.entity_id
       LEFT JOIN trade_facts f ON f.entity_id = s.entity_id
         AND f.flow = s.flow AND f.stream = 'goods' AND f.hs_code = s.hs_code
         AND f.partner_iso3 IS NULL
         AND f.year = (SELECT MAX(f2.year) FROM trade_facts f2
                        WHERE f2.entity_id = s.entity_id AND f2.flow = s.flow
                          AND f2.stream = 'goods' AND f2.hs_code = s.hs_code
                          AND f2.partner_iso3 IS NULL)
      WHERE e.is_active = 1
      ORDER BY s.momentum DESC, s.cagr_3y DESC
      LIMIT 100`,
  ).all<ExploreOpportunity & { entity_id: string; hs_code: string | null }>();

  const { results: partnerRows } = await c.env.DB.prepare(
    `WITH latest AS (
       SELECT entity_id, flow, MAX(year) AS year
         FROM trade_facts
        WHERE stream = 'goods' AND partner_iso3 IS NOT NULL
        GROUP BY entity_id, flow
    )
    SELECT s.id AS signal_id, f.partner_iso3, f.partner_name, f.value_usd,
           CASE WHEN f.hs_code = s.hs_code THEN 1 ELSE 0 END AS detail_available
      FROM opportunity_signals s
      JOIN entities e ON e.id = s.entity_id AND e.is_active = 1
      JOIN latest l ON l.entity_id = s.entity_id AND l.flow = s.flow
      JOIN trade_facts f ON f.entity_id = s.entity_id AND f.flow = s.flow
        AND f.year = l.year AND f.stream = 'goods' AND f.partner_iso3 IS NOT NULL
        AND (f.hs_code = s.hs_code OR f.hs_code IS NULL)
     ORDER BY detail_available DESC, f.value_usd DESC`,
  ).all<{
    signal_id: string;
    partner_iso3: string | null;
    partner_name: string | null;
    value_usd: number;
    detail_available: number;
  }>();

  const partnersBySignal = new Map<string, ExploreOpportunity['partners']>();
  for (const row of partnerRows ?? []) {
    const current = partnersBySignal.get(row.signal_id) ?? [];
    if (current.length >= 5) continue;
    current.push({
      iso3: row.partner_iso3,
      name: row.partner_name ?? row.partner_iso3 ?? 'Unknown partner',
      value_usd: row.value_usd,
      detail_available: row.detail_available === 1,
    });
    partnersBySignal.set(row.signal_id, current);
  }

  const { results: serviceRows } = await c.env.DB.prepare(
    `SELECT e.slug, e.name AS country, e.iso3, e.continent, f.flow,
            f.year, f.product_name AS name, f.value_usd,
            CASE WHEN previous.value_usd > 0
                 THEN ((f.value_usd - previous.value_usd) / previous.value_usd) * 100
                 ELSE NULL END AS growth_pct
       FROM trade_facts f
       JOIN entities e ON e.id = f.entity_id
       LEFT JOIN trade_facts previous ON previous.entity_id = f.entity_id
         AND previous.flow = f.flow AND previous.stream = 'services'
         AND previous.year = f.year - 3
      WHERE e.is_active = 1 AND f.stream = 'services'
        AND f.year = (SELECT MAX(f2.year) FROM trade_facts f2
                      WHERE f2.entity_id = f.entity_id AND f2.flow = f.flow
                        AND f2.stream = 'services')
      ORDER BY growth_pct DESC
      LIMIT 40`,
  ).all<ExploreOpportunity>();

  // Traditional vs non-traditional: opportunity_signals already excludes each
  // country's own top-5 headline products, which structurally rules out a
  // dominant legacy commodity (Ghanaian cocoa is always top-5, never a
  // "signal"). What that exclusion does NOT catch is a smaller, growing
  // mining/oil-type category that isn't top-5 yet but is still never
  // realistically SME-accessible — the universal defaults + admin overrides
  // below catch that.
  const classificationsByEntity = await loadClassificationsBulk(
    c.env.DB,
    (productRows ?? []).map((r) => r.entity_id),
  );

  const products = (productRows ?? [])
    .map((row) => {
      const category = classify(row.hs_code, resolveForEntity(classificationsByEntity, row.entity_id), new Set());
      return {
        ...row,
        value_usd: row.value_usd ?? 0,
        year: row.year ?? 0,
        rationale: row.rationale ?? 'Growing outside the headline products.',
        partners: partnersBySignal.get(row.id) ?? [],
        category,
      };
    })
    .filter((row) => includeTraditional || row.category !== 'traditional');
  const services = (serviceRows ?? []).map((row) => ({
    ...row,
    id: `service-${row.slug}-${row.flow}`,
    kind: 'service' as const,
    rank: null,
    momentum: null,
    rationale:
      'Services are available in the source data, but this source currently reports them as one broad category rather than individual service lines.',
    value_usd: row.value_usd ?? 0,
    year: row.year ?? 0,
    growth_pct: row.growth_pct ?? null,
    name: row.name ?? 'Commercial services',
    partners: [],
  }));

  return json({ opportunities: [...products, ...services], count: products.length + services.length });
});

/** How many countries the product view shows per side (exporters / importers) of a product. */
const MARKET_TOP_N = 10;

/**
 * Live search over the specific products actually reported in the data --
 * "Fruit, edible; pineapples, fresh or dried", not the 2-digit chapter
 * "Fruit & nuts" -- for the product search typeahead. Hides
 * traditional/gated categories by default (oil, mining, precious metals, a
 * country's own dominant commodity): those are exactly the obvious
 * big-player categories an SME isn't shopping for. Pass all=1 to see them.
 */
pub.get('/market/hs-codes', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const includeTraditional = c.req.query('all') === '1';
  const LIMIT = q ? 60 : 30;

  // Restricted to the specific-product level and to world-total rows.
  //
  // Without the level filter this ranks HS2 chapters and their HS6 children in
  // one list, which both double-counts the underlying trade and puts a chapter
  // above every product inside it. This endpoint exists to find a specific
  // line, so it lists specific lines.
  const { results } = await c.env.DB.prepare(
    q
      ? `SELECT hs_code, MAX(product_name) AS product_name, SUM(value_usd) AS total_value
           FROM trade_facts
          WHERE stream = 'goods' AND length(hs_code) = 6 AND partner_iso3 IS NULL
            AND flow = 'export' AND product_name LIKE ?
          GROUP BY hs_code
          ORDER BY total_value DESC
          LIMIT ?`
      : `SELECT hs_code, MAX(product_name) AS product_name, SUM(value_usd) AS total_value
           FROM trade_facts
          WHERE stream = 'goods' AND length(hs_code) = 6 AND partner_iso3 IS NULL
            AND flow = 'export'
          GROUP BY hs_code
          ORDER BY total_value DESC
          LIMIT ?`,
  )
    .bind(...(q ? [`%${q}%`, LIMIT * 4] : [LIMIT * 4]))
    .all<{ hs_code: string; product_name: string | null; total_value: number }>();

  const globalClassifications = await loadClassifications(c.env.DB, '*');
  const codes = (results ?? [])
    .map((r) => ({
      code: r.hs_code,
      label: r.product_name ?? hs6Label(r.hs_code),
      sector: hs2Sector(r.hs_code),
      category: classify(r.hs_code, globalClassifications, new Set()),
    }))
    .filter((r) => includeTraditional || r.category !== 'traditional')
    .slice(0, LIMIT);

  return json({ codes });
});

/**
 * Product view: for one HS2 product/service chapter, rank every country by
 * trade volume. Partner detail attached per country is that country's own
 * general trading partners (already computed) — never product-specific,
 * because Comtrade's keyless tier never fetches partner x HS-code together.
 */
pub.get('/market/products', async (c) => {
  const hs = (c.req.query('hs') ?? '').trim();
  const isChapter = /^\d{2}$/.test(hs);
  const isSpecific = /^\d{6}$/.test(hs);
  if (!isChapter && !isSpecific) {
    return bad('hs must be a 2-digit HS chapter or 6-digit HS product code', 400);
  }
  // Exact match at whichever level was asked for. A chapter request reads the
  // chapter row, which already contains everything under it. Matching on a
  // prefix would also pick up the HS6 children stored alongside it and count
  // the same trade twice. See the note in /products/:hs.
  const pattern = hs;

  interface Row {
    id: string;
    slug: string;
    name: string;
    iso3: string;
    continent: string;
    year: number;
    value_usd: number;
  }

  const rankFor = async (flow: 'export' | 'import') => {
    const { results } = await c.env.DB.prepare(
      `WITH matched AS (
         SELECT entity_id, year, SUM(value_usd) AS value_usd
           FROM trade_facts
          WHERE hs_code = ? AND flow = ? AND stream = 'goods' AND partner_iso3 IS NULL
          GROUP BY entity_id, year
       ),
       latest AS (
         SELECT entity_id, MAX(year) AS year FROM matched GROUP BY entity_id
       )
       SELECT e.id, e.slug, e.name, e.iso3, e.continent, m.year, m.value_usd
         FROM matched m
         JOIN latest l ON l.entity_id = m.entity_id AND l.year = m.year
         JOIN entities e ON e.id = m.entity_id AND e.is_active = 1
        ORDER BY m.value_usd DESC
        LIMIT ?`,
    )
      .bind(pattern, flow, MARKET_TOP_N)
      .all<Row>();
    return (results ?? []).map((r, i) => ({ ...r, rank: i + 1 }));
  };

  const [exporters, importers] = await Promise.all([rankFor('export'), rankFor('import')]);

  const idBySlug = new Map<string, string>();
  for (const r of [...exporters, ...importers]) idBySlug.set(r.slug, r.id);

  const partnerEntries = await Promise.all(
    [...idBySlug.entries()].map(async ([slug, id]) => {
      const [partnersExport, partnersImport] = await Promise.all([
        loadResult<RankedItem[]>(c.env.DB, id, 'partners_export'),
        loadResult<RankedItem[]>(c.env.DB, id, 'partners_import'),
      ]);
      return [slug, { export: partnersExport ?? [], import: partnersImport ?? [] }] as const;
    }),
  );

  const strip = (rows: (Row & { rank: number })[]) => rows.map(({ id, ...rest }) => rest);

  // Global framing only here: a product search spans every country at
  // once, so this reflects the universal defaults / admin-curated overrides
  // for the category itself, not any one country's own export mix (see
  // /dashboard/:slug for the per-country, dominant-commodity-aware version).
  const globalClassifications = await loadClassifications(c.env.DB, '*');

  return json({
    hs_code: hs,
    label: isSpecific ? hs6Label(hs) : hs2Label(hs),
    sector: hs2Sector(hs),
    category: classify(hs, globalClassifications, new Set()),
    exporters: strip(exporters),
    importers: strip(importers),
    partners_by_slug: Object.fromEntries(partnerEntries),
  } satisfies MarketProducts);
});

/** Registry browser: every source link we hold, active or not. */
pub.get('/registry', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities ORDER BY kind, continent, name`,
  ).all<Entity>();
  const withSources = await attachSources(c.env.DB, results ?? []);
  return json({ entities: withSources, count: withSources.length });
});
