import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { attachSources, bad, getEntityBySlug, json } from '../lib/db';
import type {
  CountryDashboard,
  Entity,
  OpportunitySignal,
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

async function loadResult<T>(db: D1Database, entityId: string, kind: string): Promise<T | null> {
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

  const isPremium = c.req.header('x-ta-tier') === 'premium';

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

  const payload: CountryDashboard = {
    entity,
    overview,
    top_exports: topExports ?? [],
    top_imports: topImports ?? [],
    services: services ?? [],
    partners_export: partnersExport ?? [],
    partners_import: partnersImport ?? [],
    trend: trend ?? [],
    recommendations: recs ?? [],
    opportunities: isPremium ? (signals ?? []) : null,
    opportunities_locked: isPremium ? 0 : (signals?.length ?? 0),
    computed_at: computed?.at ?? null,
  };

  return json(payload, 200, { 'cache-control': 'public, max-age=900' });
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

/** Registry browser: every source link we hold, active or not. */
pub.get('/registry', async (c) => {
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities ORDER BY kind, continent, name`,
  ).all<Entity>();
  const withSources = await attachSources(c.env.DB, results ?? []);
  return json({ entities: withSources, count: withSources.length });
});
