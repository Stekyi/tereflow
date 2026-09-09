import type {
  Entity,
  EntitySource,
  EntityWithSources,
  SourceCategory,
} from '../../shared/types';

export interface Env {
  DB: D1Database;
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  APP_NAME: string;
  ADMIN_EMAILS: string;
  ADMIN_TOKEN?: string;
  COMTRADE_API_KEY?: string;
  CENSUS_API_KEY?: string;
  SESSION_SECRET?: string;
  STRIPE_SECRET_KEY?: string;
  STRIPE_WEBHOOK_SECRET?: string;
  /**
   * Opens POST /api/auth/tier, which hands the caller premium with no payment.
   * Must be the literal string "true". Absent means closed, so a deploy that
   * has not configured billing yet does not give premium away.
   */
  ALLOW_DEV_TIER_SWITCH?: string;
  /**
   * Where a reader lands from a social post.
   *
   * Falls back to the request origin, which is right in development and wrong
   * behind a proxy or a custom domain, so production sets it explicitly rather
   * than publishing a workers.dev link to strangers.
   */
  PUBLIC_SITE_URL?: string;
  /**
   * Ananse News, which owns the social platform tokens and does the posting.
   * Both must be set for publishing to work; absent means the feature is off
   * and says so rather than failing quietly on a schedule.
   */
  ANANSE_ENDPOINT?: string;
  ANANSE_KEY?: string;
}

export function uid(prefix = ''): string {
  return prefix + crypto.randomUUID().replace(/-/g, '').slice(0, 22);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
}

const EMPTY_SOURCES = (): Record<SourceCategory, EntitySource[]> => ({
  export: [],
  import: [],
  commerce: [],
});

/**
 * Attach the three link slots per category to a set of entities.
 * D1 caps bound parameters at 100 per statement, so the IN clause is chunked.
 */
export async function attachSources(
  db: D1Database,
  entities: Entity[],
): Promise<EntityWithSources[]> {
  if (entities.length === 0) return [];

  const bucket = new Map<string, Record<SourceCategory, EntitySource[]>>();
  for (const e of entities) bucket.set(e.id, EMPTY_SOURCES());

  const CHUNK = 90;
  const ids = entities.map((e) => e.id);
  for (let i = 0; i < ids.length; i += CHUNK) {
    const slice = ids.slice(i, i + CHUNK);
    const placeholders = slice.map(() => '?').join(',');
    const { results } = await db
      .prepare(
        `SELECT * FROM entity_sources
          WHERE entity_id IN (${placeholders})
          ORDER BY category, slot`,
      )
      .bind(...slice)
      .all<EntitySource>();
    for (const s of results ?? []) {
      bucket.get(s.entity_id)?.[s.category].push(s);
    }
  }

  return entities.map((e) => ({ ...e, sources: bucket.get(e.id) ?? EMPTY_SOURCES() }));
}

export async function getEntityBySlug(
  db: D1Database,
  slug: string,
): Promise<EntityWithSources | null> {
  const entity = await db
    .prepare('SELECT * FROM entities WHERE slug = ? OR id = ? OR lower(iso3) = lower(?)')
    .bind(slug, slug, slug)
    .first<Entity>();
  if (!entity) return null;
  const [withSources] = await attachSources(db, [entity]);
  return withSources;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', ...headers },
  });
}

export function bad(message: string, status = 400): Response {
  return json({ error: message }, status);
}
