import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { attachSources, bad, getEntityBySlug, json, slugify, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { loadSettings } from '../lib/settings';
import { dominantCodes, loadClassifications, resolveAll } from '../lib/classify';
import { loadResult } from './public';
import {
  ENTITY_KINDS,
  SOURCE_CATEGORIES,
  SOURCE_ENDPOINT_TYPES,
  SOURCE_FMTS,
  SOURCE_PARSERS,
  type Entity,
  type EntityInput,
  type ExportCategory,
  type Overview,
} from '../../shared/types';

export const admin = new Hono<{ Bindings: Env }>();

admin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

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
  const ROWS_PER_STATEMENT = Math.floor(100 / COLS); // 7
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
