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

/** Kick the weekly agent by hand instead of waiting for Friday. */
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

/** Health-check every registered link so dead sources surface in the table. */
admin.post('/sources/check', async (c) => {
  const { checkAllLinks } = await import('../agent/linkcheck');
  const result = await checkAllLinks(c.env, Number(c.req.query('limit') ?? 200));
  return json(result);
});
