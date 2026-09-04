import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { attachSources, bad, getEntityBySlug, json, slugify, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import {
  ENTITY_KINDS,
  SOURCE_CATEGORIES,
  SOURCE_FMTS,
  type Entity,
  type EntityInput,
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
    if (s.url && !/^https?:\/\//i.test(s.url)) return `Link must start with http(s): ${s.url}`;
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
          `INSERT INTO entity_sources (id, entity_id, category, slot, url, label, fmt)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(uid('src_'), entityId, s.category, s.slot, url, s.label ?? null, s.fmt ?? 'html'),
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

/** Kick the analysis agent by hand. Local-only in normal operation. */
admin.post('/runs', async (c) => {
  const { runAnalysis } = await import('../agent/run');
  const only = c.req.query('slug') ?? undefined;
  const result = await runAnalysis(c.env, 'manual', only);
  return json(result);
});

admin.get('/runs', async (c) => {
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 25',
  ).all();
  return json({ runs: results ?? [] });
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
    analysis: Record<string, unknown>;
    signals?: Record<string, unknown>[];
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
            current_rank, projected_rank, horizon_years, confidence, rationale, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ),
    );
  }

  stmts.push(
    c.env.DB.prepare(
      `UPDATE entities
          SET last_ingest_at = datetime('now'), last_error = NULL,
              coverage_score = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(body.coverage_score ?? 0, entity.id),
  );

  // D1 caps a batch, so apply in slices.
  const CHUNK = 20;
  for (let i = 0; i < stmts.length; i += CHUNK) {
    await c.env.DB.batch(stmts.slice(i, i + CHUNK));
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
            entities_ok = ?, entities_failed = ?, facts_written = ?, log = ?
      WHERE id = ?`,
  )
    .bind(
      status,
      body.entities_total,
      body.entities_ok,
      body.entities_failed,
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
