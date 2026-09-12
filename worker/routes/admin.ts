import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { attachSources, bad, getEntityBySlug, json, slugify, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';
import { loadSettings } from '../lib/settings';
import { dominantCodes, loadClassifications, resolveAll } from '../lib/classify';
import { loadResult } from './public';
import {
  BLUE_OCEAN_VISIBILITIES,
  ENTITY_KINDS,
  SOURCE_CATEGORIES,
  SOURCE_ENDPOINT_TYPES,
  SOURCE_FMTS,
  SOURCE_PARSERS,
  type BlueOceanVisibility,
  type Entity,
  type EntityInput,
  type ExportCategory,
  type Overview,
} from '../../shared/types';
import {
  datasetSpec,
  type DatasetCode,
} from '../../shared/csv/schema';
import { validate as validateCsv, type IndicatorDef } from '../../shared/csv/validate';
import { buildReadme, buildTemplate } from '../../shared/csv/template';
import { analyse } from '../agent/analyse';
import { analyseCountryData, type IndicatorRow, type SectorRow } from '../agent/analyse-manual';
import type { FactRow } from '../agent/types';
import { buildSocialPost, isPublishableLink, type SignalWithMarket } from '../agent/social';

export const admin = new Hono<{ Bindings: Env }>();

admin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

/**
 * D1 refuses a statement carrying more than this many bound parameters.
 *
 * Named because the number decides how many rows fit in one insert and how many
 * codes fit in one delete, and those calculations were repeating the literal in
 * several places. Exceeding it fails the whole batch, so anything building a
 * variable-length parameter list has to divide by it rather than hope.
 */
const D1_MAX_BOUND_PARAMS = 100;

/** Everything, including inactive records, for the admin table. */
admin.get('/entities', async (c) => {
  const kind = c.req.query('kind');
  const q = c.req.query('q');
  const clauses: string[] = [];
  const binds: unknown[] = [];
  if (kind) {
    clauses.push('kind = ?');
    binds.push(kind);
  }
  if (q) {
    clauses.push('(name LIKE ? OR slug LIKE ? OR iso3 LIKE ? OR agency_name LIKE ?)');
    const like = `%${q}%`;
    binds.push(like, like, like, like);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const { results } = await c.env.DB.prepare(
    `SELECT * FROM entities ${where}
      ORDER BY kind, continent, name`,
  )
    .bind(...binds)
    .all<Entity>();
  const withSources = await attachSources(c.env.DB, results ?? []);
  return json({ entities: withSources, count: withSources.length });
});

admin.get('/entities/:slug', async (c) => {
  const entity = await getEntityBySlug(c.env.DB, c.req.param('slug'));
  if (!entity) return bad('Not found', 404);
  return json(entity);
});

function validate(input: EntityInput): string | null {
  if (!input?.name?.trim()) return 'Name is required';
  if (!ENTITY_KINDS.includes(input.kind)) return `kind must be one of ${ENTITY_KINDS.join(', ')}`;
  if (input.iso3 && !/^[A-Za-z]{3}$/.test(input.iso3)) return 'iso3 must be 3 letters';
  for (const s of input.sources ?? []) {
    if (!SOURCE_CATEGORIES.includes(s.category)) return `Bad source category: ${s.category}`;
    if (![1, 2, 3].includes(s.slot)) return 'Source slot must be 1, 2 or 3';
    if (s.fmt && !SOURCE_FMTS.includes(s.fmt)) return `Bad source format: ${s.fmt}`;
    if (s.endpoint_type && !SOURCE_ENDPOINT_TYPES.includes(s.endpoint_type))
      return `Bad endpoint type: ${s.endpoint_type}`;
    if (s.parser_key && !SOURCE_PARSERS.includes(s.parser_key))
      return `Bad parser: ${s.parser_key}`;
    if (s.url && !/^https?:\/\//i.test(s.url)) return `Link must start with http(s): ${s.url}`;
    if (s.config_json) {
      try {
        JSON.parse(s.config_json);
      } catch {
        return `Parser config must be valid JSON for ${s.url}`;
      }
    }
  }
  return null;
}

/** Replace the whole source set for an entity so the form is a simple PUT. */
async function writeSources(db: D1Database, entityId: string, input: EntityInput) {
  const stmts: D1PreparedStatement[] = [
    db.prepare('DELETE FROM entity_sources WHERE entity_id = ?').bind(entityId),
  ];
  const seen = new Set<string>();
  for (const s of input.sources ?? []) {
    const url = (s.url ?? '').trim();
    if (!url) continue;
    const key = `${s.category}:${s.slot}`;
    if (seen.has(key)) continue;
    seen.add(key);
    stmts.push(
      db
        .prepare(
          `INSERT INTO entity_sources
             (id, entity_id, category, slot, url, label, fmt, endpoint_type, parser_key, config_json)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          uid('src_'),
          entityId,
          s.category,
          s.slot,
          url,
          s.label ?? null,
          s.fmt ?? 'html',
          s.endpoint_type ?? 'file',
          s.parser_key ?? 'auto',
          s.config_json ?? '{}',
        ),
    );
  }
  await db.batch(stmts);
}

admin.post('/entities', async (c) => {
  const input = (await c.req.json()) as EntityInput;
  const err = validate(input);
  if (err) return bad(err);

  const slug = slugify(input.slug || input.name);
  const existing = await c.env.DB.prepare('SELECT id FROM entities WHERE slug = ?')
    .bind(slug)
    .first<{ id: string }>();
  if (existing) return bad(`An entity with slug "${slug}" already exists`, 409);

  const id = uid('ent_');
  await c.env.DB.prepare(
    `INSERT INTO entities
       (id, slug, name, kind, continent, iso3, iso2, agency_name, homepage, api_notes, is_active)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      slug,
      input.name.trim(),
      input.kind,
      input.continent ?? null,
      input.iso3?.toUpperCase() ?? null,
      input.iso2?.toUpperCase() ?? null,
      input.agency_name ?? null,
      input.homepage ?? null,
      input.api_notes ?? null,
      input.is_active ? 1 : 0,
    )
    .run();

  await writeSources(c.env.DB, id, input);
  const saved = await getEntityBySlug(c.env.DB, slug);
  return json(saved, 201);
});

admin.put('/entities/:slug', async (c) => {
  const current = await getEntityBySlug(c.env.DB, c.req.param('slug'));
  if (!current) return bad('Not found', 404);

  const input = (await c.req.json()) as EntityInput;
  const err = validate(input);
  if (err) return bad(err);

  await c.env.DB.prepare(
    `UPDATE entities SET
       name = ?, kind = ?, continent = ?, iso3 = ?, iso2 = ?,
       agency_name = ?, homepage = ?, api_notes = ?, is_active = ?,
       updated_at = datetime('now')
     WHERE id = ?`,
  )
    .bind(
      input.name.trim(),
      input.kind,
      input.continent ?? null,
      input.iso3?.toUpperCase() ?? null,
      input.iso2?.toUpperCase() ?? null,
      input.agency_name ?? null,
      input.homepage ?? null,
      input.api_notes ?? null,
      input.is_active ? 1 : 0,
      current.id,
    )
    .run();

  await writeSources(c.env.DB, current.id, input);
  const saved = await getEntityBySlug(c.env.DB, current.slug);
  return json(saved);
});

/** The tick box. Kept as its own endpoint so the list view can toggle inline. */
admin.patch('/entities/:slug/activation', async (c) => {
  const body = (await c.req.json()) as { is_active: boolean };
  const res = await c.env.DB.prepare(
    `UPDATE entities SET is_active = ?, updated_at = datetime('now') WHERE slug = ? OR id = ?`,
  )
    .bind(body.is_active ? 1 : 0, c.req.param('slug'), c.req.param('slug'))
    .run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ slug: c.req.param('slug'), is_active: body.is_active });
});

/** Bulk tick — activate or deactivate a whole continent or kind at once. */
admin.post('/entities/activation/bulk', async (c) => {
  const body = (await c.req.json()) as { slugs: string[]; is_active: boolean };
  if (!Array.isArray(body.slugs) || body.slugs.length === 0) return bad('slugs[] required');

  // D1 allows at most 100 bound parameters per statement.
  const CHUNK = 90;
  let updated = 0;
  for (let i = 0; i < body.slugs.length; i += CHUNK) {
    const slice = body.slugs.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const res = await c.env.DB.prepare(
      `UPDATE entities SET is_active = ?, updated_at = datetime('now')
        WHERE slug IN (${placeholders})`,
    )
      .bind(body.is_active ? 1 : 0, ...slice)
      .run();
    updated += res.meta.changes ?? 0;
  }
  return json({ updated, is_active: body.is_active });
});

/**
 * Who may see a country's blue ocean analysis.
 *
 * Its own endpoint rather than a field on the entity form, because this is an
 * access decision and not a description of the country. Mixing it into the
 * general save would mean an admin editing a homepage URL could change who can
 * read the analysis without noticing.
 *
 * The author and time are recorded. A permission change nobody can trace is one
 * nobody can question later.
 */
admin.patch('/entities/:slug/blue-ocean', async (c) => {
  const body = (await c.req.json()) as { visibility?: string };
  const visibility = body.visibility;
  if (!visibility || !BLUE_OCEAN_VISIBILITIES.includes(visibility as BlueOceanVisibility)) {
    return bad(`visibility must be one of: ${BLUE_OCEAN_VISIBILITIES.join(', ')}`);
  }

  const actor = await currentUser(c.req.raw, c.env);
  const res = await c.env.DB.prepare(
    `UPDATE entities
        SET blue_ocean_visibility = ?,
            blue_ocean_set_by = ?,
            blue_ocean_set_at = datetime('now'),
            updated_at = datetime('now')
      WHERE slug = ? OR id = ?`,
  )
    .bind(
      visibility,
      actor?.email ?? 'unknown',
      c.req.param('slug'),
      c.req.param('slug'),
    )
    .run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ slug: c.req.param('slug'), blue_ocean_visibility: visibility });
});

admin.delete('/entities/:slug', async (c) => {
  const res = await c.env.DB.prepare('DELETE FROM entities WHERE slug = ? OR id = ?')
    .bind(c.req.param('slug'), c.req.param('slug'))
    .run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ deleted: true });
});

/**
 * Rebuild the weekly feed by hand.
 *
 * This used to fetch from the source APIs and analyse inside the Worker. That
 * no longer works and no longer belongs here. Fetching one country now costs
 * well over a hundred Comtrade calls, because specific products have to be
 * requested one HS chapter at a time to stay inside the source's row cap, and
 * Workers cap outbound subrequests per invocation. Ingest and analysis run on
 * the machine you control (see local/pipeline.ts) and push finished results
 * through /api/admin/ingest/*.
 *
 * What is left here is the part that genuinely belongs in the cloud: turning
 * the stored signals into subscriber feeds. It touches personal data and needs
 * no outbound calls at all.
 */
admin.post('/runs', async (c) => {
  const { fanOutFeed } = await import('../agent/feed');

  const runId = uid('run_');
  await c.env.DB.prepare(
    `INSERT INTO analysis_runs (id, trigger, status, started_at)
     VALUES (?, 'manual', 'running', datetime('now'))`,
  )
    .bind(runId)
    .run();

  let feed = { subscribers: 0, subscriptions: 0, items_written: 0 };
  let feedError: string | null = null;
  try {
    feed = await fanOutFeed(c.env, runId);
  } catch (err) {
    feedError = err instanceof Error ? err.message : String(err);
  }

  await c.env.DB.prepare(
    `UPDATE analysis_runs
        SET finished_at = datetime('now'), status = ?, log = ?
      WHERE id = ?`,
  )
    .bind(
      feedError ? 'failed' : 'ok',
      JSON.stringify({ feed, feedError, note: 'feed rebuild only' }).slice(0, 8000),
      runId,
    )
    .run();

  return json({
    run_id: runId,
    status: feedError ? 'failed' : 'ok',
    feed,
    feedError,
    note: 'Rebuilt subscriber feeds from stored signals. Run `npm run pipeline` on the machine that holds the data to refresh the figures themselves.',
  });
});

admin.get('/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 25',
  ).all();
  return json({ runs: results ?? [] });
});

// ---------------------------------------------------------------------------
// Traditional vs non-traditional export classification.
//
// entity='*' reads/writes the universal defaults (see
// migrations/0006_export_classification.sql); any other entity slug
// reads/writes that one country's curated override, which always wins over
// the default and the dominant-commodity heuristic.
// ---------------------------------------------------------------------------

admin.get('/classifications', async (c) => {
  const slug = c.req.query('entity') ?? '*';
  let entityId = '*';
  if (slug !== '*') {
    const entity = await resolveEntity(c, slug);
    if (!entity) return bad(`Unknown entity: ${slug}`, 404);
    entityId = entity.id;
  }

  const resolved = await loadClassifications(c.env.DB, entityId);
  const overview =
    entityId === '*' ? null : await loadResult<Overview>(c.env.DB, entityId, 'overview');
  const settings = await loadSettings(c.env);

  return json({
    entity_id: entityId,
    rows: resolveAll(
      resolved,
      dominantCodes(overview?.export_chapter_shares, settings.dominantShareThreshold),
    ),
  });
});

admin.put('/classifications', async (c) => {
  const body = (await c.req.json()) as {
    entity?: string;
    hs_code: string;
    category: ExportCategory;
    note?: string | null;
    source_url?: string | null;
    source_label?: string | null;
  };

  const hsCode = String(body.hs_code ?? '').padStart(2, '0');
  if (!/^\d{2}$/.test(hsCode)) return bad('hs_code must be a 2-digit HS chapter code');
  if (!['traditional', 'non_traditional'].includes(body.category)) return bad('Invalid category');

  let entityId = '*';
  if (body.entity && body.entity !== '*') {
    const entity = await resolveEntity(c, body.entity);
    if (!entity) return bad(`Unknown entity: ${body.entity}`, 404);
    entityId = entity.id;
  }

  await c.env.DB.prepare(
    `INSERT INTO export_classifications (id, entity_id, hs_code, category, note, source_url, source_label)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (entity_id, hs_code) DO UPDATE SET
       category = excluded.category,
       note = excluded.note,
       source_url = excluded.source_url,
       source_label = excluded.source_label,
       updated_at = datetime('now')`,
  )
    .bind(
      uid('cls_'),
      entityId,
      hsCode,
      body.category,
      body.note ?? null,
      body.source_url ?? null,
      body.source_label ?? null,
    )
    .run();

  return json({ ok: true });
});

/** Remove a country-specific override, falling back to the default/heuristic. */
admin.delete('/classifications', async (c) => {
  const slug = c.req.query('entity');
  const hsCode = c.req.query('hs_code');
  if (!slug || slug === '*') return bad('entity (a country slug) is required');
  if (!hsCode) return bad('hs_code is required');
  const entity = await resolveEntity(c, slug);
  if (!entity) return bad(`Unknown entity: ${slug}`, 404);
  await c.env.DB.prepare('DELETE FROM export_classifications WHERE entity_id = ? AND hs_code = ?')
    .bind(entity.id, hsCode)
    .run();
  return json({ ok: true });
});

// ---------------------------------------------------------------------------
// Ingest: how the local pipeline publishes its results.
//
// Fetching and analysing happens on a machine you control, not on Workers.
// Workers cap subrequests per invocation (50 on the free plan), which limited a
// cloud run to two countries; locally there is no such cap and the whole
// registry finishes in one pass.
//
// The push is deliberately three small calls per country rather than one large
// one. A single request carrying 2,500 rows would burn Worker CPU time and risk
// a partial write; begin/facts/commit keeps every invocation cheap and makes
// the replace atomic from the reader's point of view.
// ---------------------------------------------------------------------------

interface IngestFact {
  year: number;
  flow: 'export' | 'import';
  stream: 'goods' | 'services';
  partner_iso3: string | null;
  partner_name: string | null;
  hs_code: string | null;
  product_name: string | null;
  sector: string | null;
  value_usd: number;
  qty?: number | null;
  qty_unit?: string | null;
  source_ref: string;
}

async function resolveEntity(c: { env: Env }, slug: string) {
  return c.env.DB.prepare(
    'SELECT id, slug, name FROM entities WHERE slug = ? OR id = ?',
  )
    .bind(slug, slug)
    .first<{ id: string; slug: string; name: string }>();
}

/**
 * Create the run row up front, decoupled from any one country's begin().
 *
 * Countries are checked for new data before anything expensive runs (see
 * local/pipeline.ts), so the very first country in the list might turn out
 * to be skipped -- the run still has to exist for that skip to be recorded
 * against, which the old lazy-create-on-first-begin() path couldn't guarantee.
 */
admin.post('/ingest/start', async (c) => {
  const runId = uid('run_');
  await c.env.DB.prepare(
    `INSERT INTO analysis_runs (id, trigger, status) VALUES (?, 'local', 'running')`,
  )
    .bind(runId)
    .run();
  return json({ run_id: runId });
});

/**
 * Per-product analytics for one country.
 *
 * Written after the analysis commits, so the product modal is a single indexed
 * read rather than an aggregation across every country. Replaces this
 * country's rows wholesale: a product it no longer reports should disappear,
 * not linger at its old value.
 */
admin.post('/ingest/product-analytics', async (c) => {
  const body = (await c.req.json()) as {
    slug: string;
    rows: {
      hs_code: string;
      flow: 'export' | 'import';
      year: number;
      value_usd: number;
      qty_kg: number | null;
      unit_value_usd_t: number | null;
      cagr_pct: number | null;
      share: number | null;
    }[];
  };

  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);

  const rows = body.rows ?? [];
  const stmts: D1PreparedStatement[] = [
    c.env.DB.prepare('DELETE FROM product_analytics WHERE entity_id = ?').bind(entity.id),
  ];

  // Nine columns, so seven rows keeps each statement under D1's 100 bound
  // parameter ceiling with room to spare.
  const CHUNK = 7;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    const values = chunk.map(() => '(?, ?, ?, ?, ?, ?, ?, ?, ?)').join(', ');
    const binds: unknown[] = [];
    for (const r of chunk) {
      binds.push(
        r.hs_code,
        entity.id,
        r.flow,
        r.year,
        r.value_usd,
        r.qty_kg,
        r.unit_value_usd_t,
        r.cagr_pct,
        r.share,
      );
    }
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO product_analytics
           (hs_code, entity_id, flow, year, value_usd, qty_kg, unit_value_usd_t, cagr_pct, share)
         VALUES ${values}
         ON CONFLICT (hs_code, entity_id, flow) DO UPDATE SET
           year = excluded.year,
           value_usd = excluded.value_usd,
           qty_kg = excluded.qty_kg,
           unit_value_usd_t = excluded.unit_value_usd_t,
           cagr_pct = excluded.cagr_pct,
           share = excluded.share,
           computed_at = datetime('now')`,
      ).bind(...binds),
    );
  }

  await c.env.DB.batch(stmts);
  return json({ written: rows.length });
});

/**
 * Settle the cross-country price comparison.
 *
 * A country's price only means something next to everybody else's, so this
 * runs once at the end of a pipeline pass rather than per country. It divides
 * each unit value by the median unit value for that product across every
 * country reporting one.
 */
admin.post('/ingest/price-ratios', async (c) => {
  const settings = await loadSettings(c.env);
  const floor = settings.pricingMinValueUsd;

  // Clear first, or a row that fell below the floor since the last pass would
  // keep the ratio it was given when it was still above it.
  await c.env.DB.prepare('UPDATE product_analytics SET price_ratio = NULL').run();

  // The floor sits on both sides deliberately. A country shipping a token
  // amount of a good can report a weight that implies almost any price, and
  // such a row is wrong twice over if it is left in: it gets classified as a
  // discount or a premium itself, and it drags the median that classifies
  // everybody else.
  await c.env.DB.prepare(
    `WITH ranked AS (
       SELECT hs_code, unit_value_usd_t,
              ROW_NUMBER() OVER (PARTITION BY hs_code ORDER BY unit_value_usd_t) AS rn,
              COUNT(*) OVER (PARTITION BY hs_code) AS n
         FROM product_analytics
        WHERE unit_value_usd_t IS NOT NULL AND unit_value_usd_t > 0
          AND value_usd >= ?1
     ),
     medians AS (
       SELECT hs_code, AVG(unit_value_usd_t) AS median_value
         FROM ranked
        WHERE rn IN ((n + 1) / 2, (n + 2) / 2)
        GROUP BY hs_code
     )
     UPDATE product_analytics
        SET price_ratio = (
          SELECT product_analytics.unit_value_usd_t / m.median_value
            FROM medians m
           WHERE m.hs_code = product_analytics.hs_code AND m.median_value > 0
        )
      WHERE unit_value_usd_t IS NOT NULL AND unit_value_usd_t > 0
        AND value_usd >= ?1`,
  )
    .bind(floor)
    .run();

  const counted = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM product_analytics WHERE price_ratio IS NOT NULL',
  ).first<{ n: number }>();

  // A ratio this far from the median is not a discount, it is a weight the
  // reporter got wrong: twelve million dollars of gold cannot weigh six
  // hundred tonnes. The value is still sound, so only the weight and
  // everything derived from it is dropped.
  const dropped = await c.env.DB.prepare(
    `UPDATE product_analytics
        SET qty_kg = NULL, unit_value_usd_t = NULL, price_ratio = NULL
      WHERE price_ratio IS NOT NULL
        AND (price_ratio > ?1 OR price_ratio < 1.0 / ?1)`,
  )
    .bind(settings.pricingMaxDeviation)
    .run();

  return json({
    priced: (counted?.n ?? 0) - (dropped.meta?.changes ?? 0),
    implausible_weights_dropped: dropped.meta?.changes ?? 0,
  });
});

/**
 * Read a country's stored facts back.
 *
 * This exists so an analysis bug can be fixed without re-fetching from the
 * source. Every figure the app shows is derived by analyse.ts from these rows,
 * so a change to the maths previously meant re-running the whole ingest, which
 * on the keyless Comtrade tier is rate limited to roughly one country an hour.
 * Correcting a share calculation should not cost four days.
 *
 * Paged, because a country holds several thousand rows and D1 will not return
 * them in one response.
 */
admin.get('/ingest/facts/:slug', async (c) => {
  const entity = await resolveEntity(c, c.req.param('slug'));
  if (!entity) return bad('Unknown entity', 404);

  const limit = Math.min(Number(c.req.query('limit') ?? 5000) || 5000, 10000);
  const offset = Number(c.req.query('offset') ?? 0) || 0;

  const { results } = await c.env.DB.prepare(
    `SELECT year, flow, stream, partner_iso3, partner_name, hs_code, product_name,
            sector, value_usd, qty, qty_unit, source_ref
       FROM trade_facts
      WHERE entity_id = ?
      ORDER BY rowid
      LIMIT ? OFFSET ?`,
  )
    .bind(entity.id, limit, offset)
    .all();

  const total = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM trade_facts WHERE entity_id = ?',
  )
    .bind(entity.id)
    .first<{ n: number }>();

  return json({
    slug: entity.slug,
    facts: results ?? [],
    offset,
    returned: results?.length ?? 0,
    total: total?.n ?? 0,
  });
});

/** A country was checked and had no new data -- record it, touch nothing else. */
admin.post('/ingest/skip', async (c) => {
  const body = (await c.req.json()) as { slug: string; fingerprint: string };
  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);
  await c.env.DB.prepare(
    `UPDATE entities SET last_checked_at = datetime('now'), last_fingerprint = ?, updated_at = datetime('now')
      WHERE id = ?`,
  )
    .bind(body.fingerprint, entity.id)
    .run();
  return json({ ok: true });
});

/** Open a run, or reuse the caller's, and clear the entity's existing facts. */
admin.post('/ingest/begin', async (c) => {
  const body = (await c.req.json()) as { slug: string; run_id?: string };
  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);

  let runId = body.run_id;
  if (!runId) {
    runId = uid('run_');
    await c.env.DB.prepare(
      `INSERT INTO analysis_runs (id, trigger, status) VALUES (?, 'local', 'running')`,
    )
      .bind(runId)
      .run();
  }

  await c.env.DB.prepare('DELETE FROM trade_facts WHERE entity_id = ?').bind(entity.id).run();
  return json({ run_id: runId, entity_id: entity.id, slug: entity.slug });
});

admin.post('/ingest/facts', async (c) => {
  const body = (await c.req.json()) as { slug: string; facts: IngestFact[] };
  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);
  if (!Array.isArray(body.facts)) return bad('facts[] required');
  if (body.facts.length > 1200) return bad('Send at most 1200 facts per request');

  /**
   * One INSERT carrying many rows, not many single-row INSERTs.
   *
   * Row-at-a-time took about three minutes per country, which is four hours
   * across the registry. Batching the VALUES brings it under ten seconds: the
   * cost here is per statement, not per row.
   *
   * D1 allows 100 bound parameters per statement, so with 13 columns that is
   * seven rows per statement. Values are bound, never interpolated.
   */
  const COLS = 13;
  const ROWS_PER_STATEMENT = Math.floor(D1_MAX_BOUND_PARAMS / COLS); // 7
  const tuple = `(${Array(COLS).fill('?').join(',')})`;

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < body.facts.length; i += ROWS_PER_STATEMENT) {
    const slice = body.facts.slice(i, i + ROWS_PER_STATEMENT);
    const binds: unknown[] = [];
    for (const f of slice) {
      binds.push(
        entity.id,
        f.year,
        f.flow,
        f.stream,
        f.partner_iso3 ?? null,
        f.partner_name ?? null,
        f.hs_code ?? null,
        f.product_name ?? null,
        f.sector ?? null,
        f.value_usd,
        f.qty ?? null,
        f.qty_unit ?? null,
        f.source_ref,
      );
    }
    statements.push(
      c.env.DB.prepare(
        `INSERT INTO trade_facts
           (entity_id, year, flow, stream, partner_iso3, partner_name,
            hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref)
         VALUES ${slice.map(() => tuple).join(',')}`,
      ).bind(...binds),
    );
  }

  const BATCH = 25;
  for (let i = 0; i < statements.length; i += BATCH) {
    await c.env.DB.batch(statements.slice(i, i + BATCH));
  }

  return json({ written: body.facts.length, statements: statements.length });
});

/** Write the computed payloads and mark the entity fresh. */
admin.post('/ingest/commit', async (c) => {
  const body = (await c.req.json()) as {
    slug: string;
    run_id: string;
    coverage_score?: number;
    fingerprint?: string;
    analysis: Record<string, unknown>;
    signals?: Record<string, unknown>[];
    source_attempts?: {
      source_id?: string | null;
      source_ref: string;
      role: 'primary' | 'fallback' | 'validator';
      parser_key: string;
      url: string;
      status: 'ok' | 'failed' | 'partial';
      rows_written?: number;
      note?: string | null;
    }[];
  };
  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);
  if (!body.analysis) return bad('analysis required');

  const stmts: D1PreparedStatement[] = [];

  for (const [kind, payload] of Object.entries(body.analysis)) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO analysis_results (id, entity_id, run_id, kind, payload, computed_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (entity_id, kind) DO UPDATE SET
           payload = excluded.payload,
           run_id = excluded.run_id,
           computed_at = excluded.computed_at`,
      ).bind(uid('res_'), entity.id, body.run_id, kind, JSON.stringify(payload)),
    );
  }

  stmts.push(
    c.env.DB.prepare('DELETE FROM opportunity_signals WHERE entity_id = ?').bind(entity.id),
  );
  for (const s of body.signals ?? []) {
    stmts.push(
      c.env.DB.prepare(
        `INSERT INTO opportunity_signals
           (id, entity_id, hs_code, product_name, flow, cagr_3y, momentum,
            current_rank, projected_rank, horizon_years, confidence, rationale, run_id,
            value_usd, share, year, best_market, best_market_iso3, best_market_value_usd,
            best_market_product_specific)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid('sig_'),
        entity.id,
        (s.hs_code as string) ?? null,
        s.product_name as string,
        s.flow as string,
        (s.cagr_3y as number) ?? null,
        s.momentum as number,
        (s.current_rank as number) ?? null,
        (s.projected_rank as number) ?? null,
        (s.horizon_years as number) ?? 4,
        (s.confidence as number) ?? null,
        (s.rationale as string) ?? null,
        body.run_id,
        (s.value_usd as number) ?? null,
        (s.share as number) ?? null,
        (s.year as number) ?? null,
        (s.best_market as string) ?? null,
        (s.best_market_iso3 as string) ?? null,
        (s.best_market_value_usd as number) ?? null,
        s.best_market_product_specific ? 1 : 0,
      ),
    );
  }

  stmts.push(
    c.env.DB.prepare(
      // COALESCE so a caller that omits the fingerprint (or a probe that
      // failed) never wipes a previously-good one.
      `UPDATE entities
          SET last_ingest_at = datetime('now'), last_checked_at = datetime('now'), last_error = NULL,
              coverage_score = ?, last_fingerprint = COALESCE(?, last_fingerprint), updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(body.coverage_score ?? 0, body.fingerprint ?? null, entity.id),
  );

  // D1 caps a batch, so apply in slices.
  const CHUNK = 20;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await c.env.DB.batch(stmts.slice(i, i + CHUNK));
  }

  for (const attempt of body.source_attempts ?? []) {
    await c.env.DB.prepare(
      `INSERT INTO source_attempts
         (id, entity_id, source_id, source_ref, role, parser_key, url, status, rows_written, note)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(
        uid('attempt_'),
        entity.id,
        attempt.source_id ?? null,
        attempt.source_ref,
        attempt.role,
        attempt.parser_key,
        attempt.url,
        attempt.status,
        attempt.rows_written ?? 0,
        attempt.note ?? null,
      )
      .run();
  }

  return json({ ok: true, results: Object.keys(body.analysis).length, signals: body.signals?.length ?? 0 });
});

/** Record a country the local run could not complete. */
admin.post('/ingest/fail', async (c) => {
  const body = (await c.req.json()) as { slug: string; error: string };
  const entity = await resolveEntity(c, body.slug);
  if (!entity) return bad(`Unknown entity: ${body.slug}`, 404);
  await c.env.DB.prepare(
    `UPDATE entities SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
  )
    .bind(String(body.error).slice(0, 500), entity.id)
    .run();
  return json({ ok: true });
});

/**
 * Close the run and fan the refreshed analysis into subscriber feeds.
 *
 * Fan-out stays in the cloud on purpose: it reads subscriptions and writes
 * feed items, which are personal data that should never leave the platform.
 */
admin.post('/ingest/finish', async (c) => {
  const body = (await c.req.json()) as {
    run_id: string;
    entities_total: number;
    entities_ok: number;
    entities_failed: number;
    entities_skipped?: number;
    facts_written: number;
    log?: unknown;
  };

  const { fanOutFeed } = await import('../agent/feed');
  let feed = { subscribers: 0, subscriptions: 0, items_written: 0 };
  let feedError: string | null = null;
  try {
    feed = await fanOutFeed(c.env, body.run_id);
  } catch (err) {
    feedError = err instanceof Error ? err.message : String(err);
  }

  const status =
    body.entities_failed === 0 ? 'ok' : body.entities_ok === 0 ? 'failed' : 'partial';

  await c.env.DB.prepare(
    `UPDATE analysis_runs
        SET finished_at = datetime('now'), status = ?, entities_total = ?,
            entities_ok = ?, entities_failed = ?, entities_skipped = ?, facts_written = ?, log = ?
      WHERE id = ?`,
  )
    .bind(
      status,
      body.entities_total,
      body.entities_ok,
      body.entities_failed,
      body.entities_skipped ?? 0,
      body.facts_written,
      JSON.stringify({ log: body.log ?? null, feed, feedError }).slice(0, 8000),
      body.run_id,
    )
    .run();

  return json({ status, feed, feedError });
});

/** Health-check every registered link so dead sources surface in the table. */
admin.post('/sources/check', async (c) => {
  const { checkAllLinks } = await import('../agent/linkcheck');
  const result = await checkAllLinks(c.env, Number(c.req.query('limit') ?? 200));
  return json(result);
});

// ===========================================================================
// Manual data upload
// ===========================================================================
// The owner is loading data by hand now rather than scraping it, so these
// routes take a CSV, tell the administrator exactly what is wrong with it, and
// only write anything once they have confirmed. Validate writes nothing.
// Upload records the file and its issues but no business data. Confirm is the
// single place rows land, and it lands them through env.DB.batch() so a failure
// leaves the target table as it was rather than half-filled.
//
// Trade rows go into the existing trade_facts table tagged
// source_ref = 'upload:<id>', which is what makes revert a single DELETE.
// Indicators and sectors go into indicator_observations and sector_observations
// from migration 0014.

interface ManualEntity {
  id: string;
  slug: string;
  name: string;
  iso3: string | null;
}

/** resolveEntity plus iso3, which the trade validator needs for expectIso3. */
async function resolveManualEntity(env: Env, slug: string): Promise<ManualEntity | null> {
  return env.DB.prepare('SELECT id, slug, name, iso3 FROM entities WHERE slug = ? OR id = ?')
    .bind(slug, slug)
    .first<ManualEntity>();
}

/** SHA-256 of the file text, hex. Used to catch a byte-identical re-upload. */
async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** The indicator catalogue the validator checks codes and bounds against. */
async function loadIndicatorDefs(env: Env): Promise<IndicatorDef[]> {
  const rows = await env.DB.prepare(
    'SELECT code, name, category, unit, min_value, max_value FROM indicator_definitions WHERE is_active = 1',
  ).all<IndicatorDef>();
  return rows.results ?? [];
}

/** Active sector codes, so an unknown sector is a warning not a silent accept. */
async function loadSectorCodes(env: Env): Promise<string[]> {
  const rows = await env.DB.prepare(
    'SELECT code FROM sector_definitions WHERE is_active = 1',
  ).all<{ code: string }>();
  return (rows.results ?? []).map((r) => r.code);
}

/** Run the shared validator with everything it needs to judge this country. */
async function validateForEntity(env: Env, entity: ManualEntity, dataset: DatasetCode, content: string) {
  const [indicators, sectorCodes] = await Promise.all([
    loadIndicatorDefs(env),
    loadSectorCodes(env),
  ]);
  return validateCsv(content, dataset, {
    expectIso3: entity.iso3 ?? undefined,
    entitySlug: entity.slug,
    indicators,
    sectorCodes,
  });
}

function asNumber(v: string | number | null | undefined): number | null {
  return typeof v === 'number' ? v : null;
}

function asText(v: string | number | null | undefined): string | null {
  if (v == null || v === '') return null;
  return typeof v === 'number' ? String(v) : v;
}

/** The target table a dataset writes into, derived from its spec. */
function targetTable(target: 'trade' | 'indicator' | 'sector'): string {
  if (target === 'trade') return 'trade_facts';
  if (target === 'indicator') return 'indicator_observations';
  return 'sector_observations';
}

// --- Templates -------------------------------------------------------------
// The readme path is registered before the bare template path on purpose:
// Hono matches in order, and ':dataset' would otherwise swallow '/readme'.

admin.get('/manual/template/:dataset/readme', (c) => {
  const dataset = c.req.param('dataset');
  const spec = datasetSpec(dataset);
  if (!spec) return bad(`Unknown dataset '${dataset}'.`, 404);
  return new Response(buildReadme(dataset as DatasetCode), {
    headers: {
      'content-type': 'text/markdown; charset=utf-8',
      'content-disposition': `attachment; filename="${dataset}-README.md"`,
    },
  });
});

admin.get('/manual/template/:dataset', (c) => {
  const dataset = c.req.param('dataset');
  const spec = datasetSpec(dataset);
  if (!spec) return bad(`Unknown dataset '${dataset}'.`, 404);
  return new Response(buildTemplate(dataset as DatasetCode), {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${dataset}-template.csv"`,
    },
  });
});

/** Everything the upload UI needs to render its dataset pickers and hints. */
admin.get('/manual/datasets', async (c) => {
  const [datasets, indicators, sectors] = await Promise.all([
    c.env.DB.prepare(
      'SELECT code, name, description, target, refresh_hint, sort_order FROM dataset_definitions WHERE is_active = 1 ORDER BY sort_order',
    ).all(),
    c.env.DB.prepare(
      'SELECT code, name, category, unit, min_value, max_value, description FROM indicator_definitions WHERE is_active = 1 ORDER BY category, code',
    ).all(),
    c.env.DB.prepare(
      'SELECT code, name, sort_order FROM sector_definitions WHERE is_active = 1 ORDER BY sort_order',
    ).all(),
  ]);
  return json({
    datasets: datasets.results ?? [],
    indicators: indicators.results ?? [],
    sectors: sectors.results ?? [],
  });
});

// --- Validate: reads the file, writes nothing -------------------------------

/**
 * Largest CSV the manual routes will read.
 *
 * These files are typed or exported by a person from a published table. A
 * country's full annual trade at HS6 is a few thousand rows and well under a
 * megabyte, so two is generous. Without a cap a 5 MB body validated in under
 * three seconds and would have been stored whole in a single D1 column, which
 * is a slow way to fill a database and an easy one to do by accident with a
 * spreadsheet that has a million empty rows below the data.
 */
const MAX_UPLOAD_BYTES = 2 * 1024 * 1024;

/** Bytes, not characters: a UTF-8 accent costs two and the limit is storage. */
function tooLarge(content: string): string | null {
  const bytes = new TextEncoder().encode(content).length;
  if (bytes <= MAX_UPLOAD_BYTES) return null;
  return (
    `That file is ${(bytes / 1024 / 1024).toFixed(1)} MB and the limit is ` +
    `${MAX_UPLOAD_BYTES / 1024 / 1024} MB. If it is genuinely that large, split it by year and ` +
    `upload each separately. If it is not, the file probably has empty rows below the data.`
  );
}

admin.post('/manual/validate', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return bad('Expected a JSON body.');
  const { slug, dataset, content } = body as { slug?: string; dataset?: string; content?: string };
  if (!slug || !dataset || typeof content !== 'string') {
    return bad('slug, dataset and content are all required.');
  }
  const oversize = tooLarge(content);
  if (oversize) return bad(oversize, 413);
  if (!datasetSpec(dataset)) return bad(`Unknown dataset '${dataset}'.`, 404);
  const entity = await resolveManualEntity(c.env, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);
  const report = await validateForEntity(c.env, entity, dataset as DatasetCode, content);
  return json({ report });
});

// --- Upload: records the file and its issues, no business data --------------

admin.post('/manual/upload', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return bad('Expected a JSON body.');
  const {
    slug,
    dataset,
    filename,
    content,
    period,
    source_name,
    source_url,
    import_mode,
  } = body as {
    slug?: string;
    dataset?: string;
    filename?: string;
    content?: string;
    period?: string;
    source_name?: string;
    source_url?: string;
    import_mode?: string;
  };
  if (!slug || !dataset || typeof content !== 'string') {
    return bad('slug, dataset and content are all required.');
  }
  const oversizeUpload = tooLarge(content);
  if (oversizeUpload) return bad(oversizeUpload, 413);
  const spec = datasetSpec(dataset);
  if (!spec) return bad(`Unknown dataset '${dataset}'.`, 404);
  // The mode is never inferred: replacing a period and appending to it are
  // different intentions and guessing wrong deletes real data.
  const mode = import_mode ?? 'append_period';
  if (mode !== 'append_period' && mode !== 'replace_period') {
    return bad("import_mode must be 'append_period' or 'replace_period'.");
  }
  const entity = await resolveManualEntity(c.env, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);

  const hash = await sha256Hex(content);
  const dup = await c.env.DB.prepare(
    `SELECT id, filename, uploaded_at FROM data_uploads
     WHERE entity_id = ? AND dataset_code = ? AND file_hash = ? AND import_status = 'imported'
     LIMIT 1`,
  )
    .bind(entity.id, dataset, hash)
    .first<{ id: string; filename: string; uploaded_at: string }>();
  if (dup) {
    return bad(
      `This exact file is already imported as upload ${dup.id} (${dup.filename}, ${dup.uploaded_at}). Revert that upload first if you mean to replace it.`,
      409,
    );
  }

  const report = await validateForEntity(c.env, entity, dataset as DatasetCode, content);
  const id = uid('upl_');
  const errorReport = JSON.stringify({
    status: report.status,
    summary: report.summary,
    years: report.years,
    periods: report.periods,
  });

  await c.env.DB.prepare(
    `INSERT INTO data_uploads
       (id, entity_id, dataset_code, filename, file_hash, file_bytes, content, content_stored,
        period, source_name, source_url, validation_status, import_mode,
        row_count, valid_rows, error_count, warning_count, notice_count, error_report)
     VALUES (?,?,?,?,?,?,?,1,?,?,?,?,?,?,?,?,?,?,?)`,
  )
    .bind(
      id,
      entity.id,
      dataset,
      filename ?? `${dataset}.csv`,
      hash,
      new TextEncoder().encode(content).length,
      content,
      period ?? null,
      source_name ?? null,
      source_url ?? null,
      report.status,
      mode,
      report.totalRows,
      report.validRows,
      report.errorCount,
      report.warningCount,
      report.noticeCount,
      errorReport,
    )
    .run();

  // Persist the issues so the history view can explain a rejection without
  // re-running the validator against a file that may since have changed.
  const issues = report.issues;
  if (issues.length) {
    const ISSUE_COLS = 7;
    const perStmt = Math.floor(D1_MAX_BOUND_PARAMS / ISSUE_COLS);
    const statements: D1PreparedStatement[] = [];
    for (let i = 0; i < issues.length; i += perStmt) {
      const slice = issues.slice(i, i + perStmt);
      const binds: (string | number | null)[] = [];
      for (const issue of slice) {
        binds.push(
          id,
          issue.severity,
          issue.row ?? null,
          issue.column ?? null,
          issue.code,
          issue.message,
          issue.value ?? null,
        );
      }
      const tuples = slice.map(() => '(?,?,?,?,?,?,?)').join(',');
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO upload_issues (upload_id, severity, row_number, column_name, code, message, raw_value) VALUES ${tuples}`,
        ).bind(...binds),
      );
    }
    const BATCH = 25;
    for (let i = 0; i < statements.length; i += BATCH) {
      await c.env.DB.batch(statements.slice(i, i + BATCH));
    }
  }

  return json({ id, report });
});

// --- Confirm: the one place rows land, transactionally ----------------------

admin.post('/manual/upload/:id/confirm', async (c) => {
  const id = c.req.param('id');
  const upload = await c.env.DB.prepare(
    `SELECT u.*, e.slug AS entity_slug, e.name AS entity_name, e.iso3 AS entity_iso3
       FROM data_uploads u JOIN entities e ON e.id = u.entity_id WHERE u.id = ?`,
  )
    .bind(id)
    .first<Record<string, unknown>>();
  if (!upload) return bad(`Unknown upload '${id}'.`, 404);
  if (upload.import_status === 'imported') {
    return bad('This upload is already imported. Revert it first to re-import.', 409);
  }
  if (upload.validation_status === 'invalid') {
    return bad('This file failed validation and cannot be imported. Fix the errors and upload again.');
  }

  const dataset = String(upload.dataset_code);
  const spec = datasetSpec(dataset);
  if (!spec) return bad(`Upload references unknown dataset '${dataset}'.`, 500);
  const entity: ManualEntity = {
    id: String(upload.entity_id),
    slug: String(upload.entity_slug),
    name: String(upload.entity_name),
    iso3: upload.entity_iso3 == null ? null : String(upload.entity_iso3),
  };
  const content = String(upload.content ?? '');
  const period = upload.period == null ? null : String(upload.period);
  const sourceName = upload.source_name == null ? null : String(upload.source_name);
  const sourceUrl = upload.source_url == null ? null : String(upload.source_url);
  const mode = String(upload.import_mode);
  const sourceRef = `upload:${id}`;

  // Rows are not persisted at upload time, so re-derive them from the stored
  // file. Same validator, same normalisation the writer relies on.
  const report = await validateForEntity(c.env, entity, dataset as DatasetCode, content);
  if (report.errorCount > 0) {
    return bad('The stored file no longer validates cleanly and will not be imported.');
  }
  const rows = report.rows;
  const years = [...new Set(rows.map((r) => asNumber(r.values.year)).filter((y): y is number => y != null))];

  const indicatorDefs = spec.target === 'indicator' ? await loadIndicatorDefs(c.env) : [];
  const indicatorByCode = new Map(indicatorDefs.map((d) => [d.code, d]));

  const table = targetTable(spec.target);
  const statements: D1PreparedStatement[] = [];
  let heldBackNoUsd = 0;

  // Count what replace_period will remove before removing it, so the
  // confirmation can state it honestly. append_period removes nothing.
  //
  // Years and codes are bound rather than pasted into the SQL. They are already
  // coerced upstream (asNumber for years, a validated column for codes) so this
  // is not currently exploitable, but a value's safety should be visible where
  // it is used rather than depending on a coercion three functions away that a
  // later refactor could quietly drop.
  //
  // D1 allows 100 bound parameters per statement. Years are bounded by a file's
  // span, but a demographics upload can carry ninety-odd indicator codes, so
  // the code list is chunked to stay under the ceiling.
  let rowsReplaced = 0;
  if (mode === 'replace_period' && years.length) {
    const yearHoles = years.map(() => '?').join(',');
    if (spec.target === 'trade') {
      const flow = spec.fixedFlow;
      const countRow = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n FROM trade_facts WHERE entity_id = ? AND flow = ? AND year IN (${yearHoles})`,
      )
        .bind(entity.id, flow, ...years)
        .first<{ n: number }>();
      rowsReplaced = countRow?.n ?? 0;
      statements.push(
        c.env.DB.prepare(
          `DELETE FROM trade_facts WHERE entity_id = ? AND flow = ? AND year IN (${yearHoles})`,
        ).bind(entity.id, flow, ...years),
      );
    } else {
      const isIndicator = spec.target === 'indicator';
      const codeColumn = isIndicator ? 'indicator_code' : 'sector_code';
      const targetName = isIndicator ? 'indicator_observations' : 'sector_observations';
      const field = isIndicator ? 'indicator_code' : 'sector_code';
      const codes = [
        ...new Set(rows.map((r) => asText(r.values[field])).filter((v): v is string => !!v)),
      ];
      // entity id, plus the years, plus this chunk of codes.
      const perChunk = Math.max(1, D1_MAX_BOUND_PARAMS - 1 - years.length);
      for (let i = 0; i < codes.length; i += perChunk) {
        const chunk = codes.slice(i, i + perChunk);
        const codeHoles = chunk.map(() => '?').join(',');
        const where = `entity_id = ? AND year IN (${yearHoles}) AND ${codeColumn} IN (${codeHoles})`;
        const countRow = await c.env.DB.prepare(
          `SELECT COUNT(*) AS n FROM ${targetName} WHERE ${where}`,
        )
          .bind(entity.id, ...years, ...chunk)
          .first<{ n: number }>();
        // Accumulated across chunks: each chunk counts a different set of codes,
        // so these add rather than replace.
        rowsReplaced += countRow?.n ?? 0;
        statements.push(
          c.env.DB.prepare(`DELETE FROM ${targetName} WHERE ${where}`).bind(
            entity.id,
            ...years,
            ...chunk,
          ),
        );
      }
    }
  }

  // Build the insert statements per target, packing rows to stay under D1's
  // 100 bound parameters per statement.
  let rowsWritten = 0;
  if (spec.target === 'trade') {
    const flow = spec.fixedFlow;
    const facts = rows
      .map((r) => r.values)
      .filter((v) => {
        // trade_facts.value_usd is NOT NULL. A row validated with only a local
        // value and currency has no USD figure, so it is held back rather than
        // stored as zero, which would be a fabricated number.
        if (asNumber(v.value_usd) == null) {
          heldBackNoUsd += 1;
          return false;
        }
        return true;
      });
    const COLS = 13;
    const perStmt = Math.floor(D1_MAX_BOUND_PARAMS / COLS);
    for (let i = 0; i < facts.length; i += perStmt) {
      const slice = facts.slice(i, i + perStmt);
      const binds: (string | number | null)[] = [];
      for (const v of slice) {
        binds.push(
          entity.id,
          asNumber(v.year),
          flow ?? asText(v.flow),
          asText(v.stream) ?? 'goods',
          asText(v.partner_iso3),
          asText(v.partner_name),
          asText(v.hs_code),
          asText(v.product_name),
          asText(v.sector_code) ?? asText(v.sector_name),
          asNumber(v.value_usd),
          asNumber(v.quantity),
          asText(v.quantity_unit),
          sourceRef,
        );
      }
      const tuples = slice.map(() => '(?,?,?,?,?,?,?,?,?,?,?,?,?)').join(',');
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO trade_facts
             (entity_id, year, flow, stream, partner_iso3, partner_name, hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref)
           VALUES ${tuples}`,
        ).bind(...binds),
      );
      rowsWritten += slice.length;
    }
  } else if (spec.target === 'indicator') {
    const COLS = 21;
    const perStmt = Math.floor(D1_MAX_BOUND_PARAMS / COLS);
    const list = rows.map((r) => r.values);
    for (let i = 0; i < list.length; i += perStmt) {
      const slice = list.slice(i, i + perStmt);
      const binds: (string | number | null)[] = [];
      for (const v of slice) {
        const code = asText(v.indicator_code);
        const def = code ? indicatorByCode.get(code) : undefined;
        binds.push(
          entity.id,
          code,
          asText(v.indicator_name) ?? def?.name ?? null,
          asText(v.category) ?? def?.category ?? null,
          asNumber(v.year),
          asText(v.period) ?? period,
          asNumber(v.value),
          asText(v.unit) ?? def?.unit ?? null,
          asText(v.currency),
          asText(v.price_basis),
          asText(v.sex),
          asText(v.age_group),
          asText(v.region),
          asText(v.urban_rural),
          asText(v.income_group),
          asText(v.source_name) ?? sourceName,
          asText(v.source_url) ?? sourceUrl,
          asNumber(v.confidence),
          asText(v.notes),
          id,
          sourceRef,
        );
      }
      const tuple = `(${new Array(COLS).fill('?').join(',')})`;
      const tuples = slice.map(() => tuple).join(',');
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO indicator_observations
             (entity_id, indicator_code, indicator_name, category, year, period, value, unit, currency, price_basis,
              sex, age_group, region, urban_rural, income_group, source_name, source_url, confidence, notes, upload_id, source_ref)
           VALUES ${tuples}`,
        ).bind(...binds),
      );
      rowsWritten += slice.length;
    }
  } else {
    const COLS = 20;
    const perStmt = Math.floor(D1_MAX_BOUND_PARAMS / COLS);
    const list = rows.map((r) => r.values);
    for (let i = 0; i < list.length; i += perStmt) {
      const slice = list.slice(i, i + perStmt);
      const binds: (string | number | null)[] = [];
      for (const v of slice) {
        binds.push(
          entity.id,
          asText(v.sector_code),
          asText(v.sector_name),
          asText(v.subsector_code),
          asText(v.subsector_name),
          asNumber(v.year),
          asNumber(v.value),
          asText(v.unit),
          asText(v.currency),
          asNumber(v.share_of_gdp),
          asNumber(v.growth_rate),
          asNumber(v.employment),
          asNumber(v.employment_share),
          asNumber(v.exports_value),
          asNumber(v.imports_value),
          asText(v.source_name) ?? sourceName,
          asText(v.source_url) ?? sourceUrl,
          asText(v.notes),
          id,
          sourceRef,
        );
      }
      const tuple = `(${new Array(COLS).fill('?').join(',')})`;
      const tuples = slice.map(() => tuple).join(',');
      statements.push(
        c.env.DB.prepare(
          `INSERT INTO sector_observations
             (entity_id, sector_code, sector_name, subsector_code, subsector_name, year, value, unit, currency,
              share_of_gdp, growth_rate, employment, employment_share, exports_value, imports_value, source_name, source_url, notes, upload_id, source_ref)
           VALUES ${tuples}`,
        ).bind(...binds),
      );
      rowsWritten += slice.length;
    }
  }

  await c.env.DB.prepare("UPDATE data_uploads SET import_status = 'importing' WHERE id = ?").bind(id).run();

  // env.DB.batch() is atomic per call but not across calls, so if a later
  // batch throws we clean up by source_ref rather than trusting a rollback
  // that only covers the batch that failed.
  const BATCH = 25;
  try {
    for (let i = 0; i < statements.length; i += BATCH) {
      await c.env.DB.batch(statements.slice(i, i + BATCH));
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE source_ref = ?`).bind(sourceRef).run();
    await c.env.DB.prepare(
      "UPDATE data_uploads SET import_status = 'failed', note = ? WHERE id = ?",
    )
      .bind(`Import failed after writing 0 rows (cleaned up). ${message}`.slice(0, 2000), id)
      .run();
    return bad(`Import failed and was rolled back: ${message}`, 500);
  }

  const noteParts: string[] = [];
  if (heldBackNoUsd > 0) {
    noteParts.push(
      `${heldBackNoUsd} trade row(s) had no USD value and were held back rather than stored as zero.`,
    );
  }
  const note = noteParts.length ? noteParts.join(' ') : null;

  try {
    await c.env.DB.prepare(
      `UPDATE data_uploads
         SET import_status = 'imported', imported_at = datetime('now'),
             rows_written = ?, rows_replaced = ?, note = ?
       WHERE id = ?`,
    )
      .bind(rowsWritten, rowsReplaced, note, id)
      .run();
  } catch (err) {
    // The partial unique index on (entity, dataset, hash) WHERE imported can
    // only trip here if an identical file was imported between upload and
    // confirm. Undo the rows and name the earlier upload.
    await c.env.DB.prepare(`DELETE FROM ${table} WHERE source_ref = ?`).bind(sourceRef).run();
    await c.env.DB.prepare("UPDATE data_uploads SET import_status = 'failed', note = ? WHERE id = ?")
      .bind('An identical file was already imported. This upload was rolled back.', id)
      .run();
    const other = await c.env.DB.prepare(
      `SELECT id, filename FROM data_uploads
       WHERE entity_id = ? AND dataset_code = ? AND file_hash = ? AND import_status = 'imported' LIMIT 1`,
    )
      .bind(entity.id, dataset, String(upload.file_hash))
      .first<{ id: string; filename: string }>();
    return bad(
      other
        ? `This exact file is already imported as upload ${other.id} (${other.filename}). Nothing was written.`
        : 'This file duplicates an already-imported upload. Nothing was written.',
      409,
    );
  }

  return json({ id, rows_written: rowsWritten, rows_replaced: rowsReplaced, held_back_no_usd: heldBackNoUsd });
});

// --- Upload history and retrieval -------------------------------------------

admin.get('/manual/uploads', async (c) => {
  const slug = c.req.query('slug');
  if (!slug) return bad('slug is required.');
  const entity = await resolveManualEntity(c.env, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);
  const rows = await c.env.DB.prepare(
    `SELECT id, dataset_code, filename, period, source_name, uploaded_at, validation_status,
            import_status, import_mode, row_count, valid_rows, error_count, warning_count,
            notice_count, rows_written, rows_replaced, imported_at, reverted_at, note
       FROM data_uploads WHERE entity_id = ? ORDER BY uploaded_at DESC`,
  )
    .bind(entity.id)
    .all();
  return json({ entity: { slug: entity.slug, name: entity.name }, uploads: rows.results ?? [] });
});

admin.get('/manual/upload/:id/download', async (c) => {
  const id = c.req.param('id');
  const upload = await c.env.DB.prepare(
    'SELECT filename, content FROM data_uploads WHERE id = ?',
  )
    .bind(id)
    .first<{ filename: string; content: string | null }>();
  if (!upload || upload.content == null) return bad(`No stored file for upload '${id}'.`, 404);
  return new Response(upload.content, {
    headers: {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename="${upload.filename}"`,
    },
  });
});

admin.get('/manual/upload/:id', async (c) => {
  const id = c.req.param('id');
  const upload = await c.env.DB.prepare(
    `SELECT id, entity_id, dataset_code, filename, file_bytes, period, source_name, source_url,
            uploaded_at, validation_status, import_status, import_mode, row_count, valid_rows,
            error_count, warning_count, notice_count, rows_written, rows_replaced, imported_at,
            reverted_at, note FROM data_uploads WHERE id = ?`,
  )
    .bind(id)
    .first();
  if (!upload) return bad(`Unknown upload '${id}'.`, 404);
  const issues = await c.env.DB.prepare(
    'SELECT severity, row_number, column_name, code, message, raw_value FROM upload_issues WHERE upload_id = ? ORDER BY id',
  )
    .bind(id)
    .all();
  return json({ upload, issues: issues.results ?? [] });
});

// --- Revert: undo one upload's rows -----------------------------------------

admin.post('/manual/upload/:id/revert', async (c) => {
  const id = c.req.param('id');
  const upload = await c.env.DB.prepare(
    'SELECT id, dataset_code, import_status FROM data_uploads WHERE id = ?',
  )
    .bind(id)
    .first<{ id: string; dataset_code: string; import_status: string }>();
  if (!upload) return bad(`Unknown upload '${id}'.`, 404);
  if (upload.import_status !== 'imported') {
    return bad(`Only an imported upload can be reverted (this one is '${upload.import_status}').`);
  }
  const spec = datasetSpec(upload.dataset_code);
  if (!spec) return bad(`Upload references unknown dataset '${upload.dataset_code}'.`, 500);
  const table = targetTable(spec.target);
  const result = await c.env.DB.prepare(`DELETE FROM ${table} WHERE source_ref = ?`)
    .bind(`upload:${id}`)
    .run();
  const removed = result.meta?.changes ?? 0;
  await c.env.DB.prepare(
    "UPDATE data_uploads SET import_status = 'reverted', reverted_at = datetime('now') WHERE id = ?",
  )
    .bind(id)
    .run();
  return json({ id, rows_removed: removed });
});

// --- Analyse stored data ----------------------------------------------------

admin.post('/manual/analyse', async (c) => {
  const body = await c.req.json().catch(() => null);
  const slug = body?.slug as string | undefined;
  if (!slug) return bad('slug is required.');
  const entity = await resolveManualEntity(c.env, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);
  const settings = await loadSettings(c.env);

  const tradeRows = await c.env.DB.prepare(
    `SELECT year, flow, stream, partner_iso3, partner_name, hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref
       FROM trade_facts WHERE entity_id = ?`,
  )
    .bind(entity.id)
    .all<FactRow>();
  const facts = tradeRows.results ?? [];

  // No World Bank fetch. This phase is human uploads only, so trade is analysed
  // on what is stored with an empty external context.
  let tradeBundle = null;
  if (facts.length) {
    tradeBundle = analyse(
      entity.name,
      facts,
      {
        gdp_by_year: {},
        services_export_by_year: {},
        services_import_by_year: {},
        gns_export_by_year: {},
        gns_import_by_year: {},
      },
      ['manual-upload'],
      [],
      settings,
      entity.iso3 ?? null,
    );
  }

  const indRows = await c.env.DB.prepare(
    `SELECT indicator_code, indicator_name, category, year, value, unit, currency, price_basis, confidence
       FROM indicator_observations WHERE entity_id = ?`,
  )
    .bind(entity.id)
    .all<IndicatorRow>();
  const secRows = await c.env.DB.prepare(
    `SELECT sector_code, sector_name, year, value, unit, currency, share_of_gdp, growth_rate, employment, employment_share, exports_value, imports_value
       FROM sector_observations WHERE entity_id = ?`,
  )
    .bind(entity.id)
    .all<SectorRow>();

  const manual = analyseCountryData({
    entityName: entity.name,
    indicators: indRows.results ?? [],
    sectors: secRows.results ?? [],
    tradeBundle,
    settings,
  });

  // Record a manual run so the write has a lineage the dashboards can show.
  const runId = uid('run_');
  await c.env.DB.prepare(
    "INSERT INTO analysis_runs (id, trigger, status, started_at, finished_at) VALUES (?, 'manual', 'ok', datetime('now'), datetime('now'))",
  )
    .bind(runId)
    .run();

  const written: string[] = [];
  const writeKind = async (kind: string, payload: unknown) => {
    await c.env.DB.prepare(
      `INSERT INTO analysis_results (id, entity_id, kind, payload, run_id, computed_at)
       VALUES (?,?,?,?,?, datetime('now'))
       ON CONFLICT (entity_id, kind) DO UPDATE SET payload = excluded.payload, run_id = excluded.run_id, computed_at = excluded.computed_at`,
    )
      .bind(uid('res_'), entity.id, kind, JSON.stringify(payload), runId)
      .run();
    written.push(kind);
  };

  await writeKind('manual_analysis', manual);
  if (tradeBundle) {
    await writeKind('overview', tradeBundle.overview);
    await writeKind('top_exports', tradeBundle.top_exports);
    await writeKind('top_imports', tradeBundle.top_imports);
    await writeKind('partners_export', tradeBundle.partners_export);
    await writeKind('partners_import', tradeBundle.partners_import);
    await writeKind('yearly_trend', tradeBundle.yearly_trend);
    await writeKind('recommendations', tradeBundle.recommendations);
  }

  return json({ entity: { slug: entity.slug, name: entity.name }, run_id: runId, kinds_written: written, manual });
});

// --- Status: what is loaded, per dataset ------------------------------------

admin.get('/manual/status', async (c) => {
  const slug = c.req.query('slug');
  if (!slug) return bad('slug is required.');
  const entity = await resolveManualEntity(c.env, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);

  const defs = await c.env.DB.prepare(
    'SELECT code, name, target, refresh_hint FROM dataset_definitions WHERE is_active = 1 ORDER BY sort_order',
  ).all<{ code: string; name: string; target: string; refresh_hint: string | null }>();

  const status = [];
  for (const def of defs.results ?? []) {
    const spec = datasetSpec(def.code);
    let rowCount = 0;
    let latestYear: number | null = null;
    if (spec?.target === 'trade') {
      const flow = spec.fixedFlow;
      const r = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n, MAX(year) AS y FROM trade_facts WHERE entity_id = ? AND flow = ?',
      )
        .bind(entity.id, flow)
        .first<{ n: number; y: number | null }>();
      rowCount = r?.n ?? 0;
      latestYear = r?.y ?? null;
    } else if (spec?.target === 'indicator') {
      // Indicator datasets share a table, so scope the count to the categories
      // that dataset writes would carry is not reliable. Report the upload-based
      // count instead: rows this dataset has imported for this country.
      const r = await c.env.DB.prepare(
        `SELECT COUNT(*) AS n, MAX(io.year) AS y FROM indicator_observations io
           JOIN data_uploads u ON u.id = io.upload_id
         WHERE io.entity_id = ? AND u.dataset_code = ?`,
      )
        .bind(entity.id, def.code)
        .first<{ n: number; y: number | null }>();
      rowCount = r?.n ?? 0;
      latestYear = r?.y ?? null;
    } else {
      const r = await c.env.DB.prepare(
        'SELECT COUNT(*) AS n, MAX(year) AS y FROM sector_observations WHERE entity_id = ?',
      )
        .bind(entity.id)
        .first<{ n: number; y: number | null }>();
      rowCount = r?.n ?? 0;
      latestYear = r?.y ?? null;
    }

    const lastUpload = await c.env.DB.prepare(
      `SELECT id, filename, uploaded_at, import_status, imported_at, rows_written
         FROM data_uploads WHERE entity_id = ? AND dataset_code = ?
       ORDER BY uploaded_at DESC LIMIT 1`,
    )
      .bind(entity.id, def.code)
      .first();

    status.push({
      dataset: def.code,
      name: def.name,
      target: def.target,
      refresh_hint: def.refresh_hint,
      row_count: rowCount,
      latest_year: latestYear,
      loaded: rowCount > 0,
      last_upload: lastUpload ?? null,
    });
  }

  return json({ entity: { slug: entity.slug, name: entity.name }, status });
});

// --- Social posts -----------------------------------------------------------
//
// Tereflow does not talk to Facebook, Instagram, Threads or LinkedIn. Ananse
// News already holds those tokens, already handles their quirks, and already
// staggers what it sends. Building a second publisher here would mean a second
// set of credentials to keep alive and a second thing to blame when a post does
// not appear. This composes a post and hands it over.

/** Signals with the market columns the shared type does not carry. */
async function loadSignals(env: Env, entityId: string): Promise<SignalWithMarket[]> {
  const { results } = await env.DB.prepare(
    `SELECT id, hs_code, product_name, flow, cagr_3y, momentum,
            current_rank, projected_rank, horizon_years, confidence, rationale,
            value_usd, share, year, best_market, best_market_iso3,
            best_market_product_specific
       FROM opportunity_signals
      WHERE entity_id = ?
      ORDER BY momentum DESC
      LIMIT 40`,
  )
    .bind(entityId)
    .all<Record<string, unknown>>();
  return (results ?? []).map((r) => ({
    ...r,
    // SQLite has no boolean. Left as 0 or 1 this is truthy either way, and the
    // whole point of the flag is that a 0 must stop a sentence being written.
    best_market_product_specific: r.best_market_product_specific === 1,
  })) as unknown as SignalWithMarket[];
}

function siteBase(c: { req: { url: string } }, env: Env): string {
  return env.PUBLIC_SITE_URL ?? new URL(c.req.url).origin;
}

/**
 * What would go out, without sending it.
 *
 * Separate from publishing on purpose. These posts carry claims about somebody
 * else's economy under somebody else's masthead, so there has to be a way to
 * read one, and its evidence, before it leaves.
 */
admin.get('/social/preview', async (c) => {
  const slug = c.req.query('slug');
  if (!slug) return bad('slug is required.');
  const entity = await getEntityBySlug(c.env.DB, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);

  const signals = await loadSignals(c.env, entity.id);
  const post = buildSocialPost({
    countryName: entity.name,
    countrySlug: entity.slug,
    signals,
    siteBase: siteBase(c, c.env),
    year: null,
  });

  if (!post) {
    return json({
      entity: { slug: entity.slug, name: entity.name },
      post: null,
      // Say which test it failed. "Nothing to post" with no reason is the kind
      // of answer that gets read as a broken feature.
      reason:
        signals.length === 0
          ? 'No opportunity signals stored for this country. Run the analysis first.'
          : 'Signals exist but none clears the bar for a public post: too small, too uncertain, or a growth figure that reads as an error.',
      signals_considered: signals.length,
    });
  }
  return json({ entity: { slug: entity.slug, name: entity.name }, post, signals_considered: signals.length });
});

/**
 * Hand the post to Ananse News, which owns the platform tokens.
 *
 * Refuses rather than half-works when it is not configured. A publish endpoint
 * that quietly does nothing is worse than one that is plainly switched off,
 * because the schedule keeps running and nobody finds out for a week.
 */
admin.post('/social/publish', async (c) => {
  const body = await c.req.json().catch(() => null);
  if (!body) return bad('Expected a JSON body.');
  const { slug, platforms, dry_run } = body as {
    slug?: string;
    platforms?: string[];
    dry_run?: boolean;
  };
  if (!slug) return bad('slug is required.');

  const entity = await getEntityBySlug(c.env.DB, slug);
  if (!entity) return bad(`Unknown country '${slug}'.`, 404);

  const signals = await loadSignals(c.env, entity.id);
  const post = buildSocialPost({
    countryName: entity.name,
    countrySlug: entity.slug,
    signals,
    siteBase: siteBase(c, c.env),
    year: null,
  });
  if (!post) return bad('Nothing worth posting for this country this week.', 422);

  // Checked before the dry-run branch so a preview surfaces the problem too. A
  // link nobody outside this machine can open is not a post, it is an
  // embarrassment that cannot be recalled.
  const linkOk = isPublishableLink(post.link);
  if (!linkOk.ok) {
    return bad(`Refusing to publish: ${linkOk.reason}`, 422);
  }

  if (dry_run) return json({ dry_run: true, post });

  const endpoint = c.env.ANANSE_ENDPOINT;
  const key = c.env.ANANSE_KEY;
  if (!endpoint || !key) {
    return bad(
      'Social publishing is not configured. Set ANANSE_ENDPOINT and ANANSE_KEY before calling this.',
      503,
    );
  }

  let res: Response;
  try {
    res = await fetch(`${endpoint.replace(/\/+$/, '')}/api/wire/partner-post`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-ananse-key': key },
      body: JSON.stringify({
        partner: 'tereflow',
        title: post.title,
        caption: post.caption,
        link: post.link,
        platforms: platforms ?? undefined,
        dedupe_key: post.dedupeKey,
      }),
      signal: AbortSignal.timeout(20_000),
    });
  } catch (err) {
    return bad(`Could not reach Ananse News: ${err instanceof Error ? err.message : String(err)}`, 502);
  }

  const text = await res.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = { raw: text.slice(0, 400) };
  }
  if (!res.ok) {
    return json({ ok: false, status: res.status, response: payload, post }, res.status === 401 ? 502 : 502);
  }
  return json({ ok: true, post, response: payload });
});
