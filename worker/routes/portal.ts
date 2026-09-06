import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { json } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { linkHealth, type SourceFmt } from '../../shared/types';

/**
 * The owner portal's read side.
 *
 * One request per section rather than one giant payload: the portal opens on
 * Overview and most sections are never looked at in a given visit, so loading
 * every table on mount would be paying for all of them to see one.
 *
 * Everything here is admin only and nothing is cached.
 */
export const portal = new Hono<{ Bindings: Env }>();

portal.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

/** Small helper: first row of a one-row aggregate query. */
async function row<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T | null> {
  return db
    .prepare(sql)
    .bind(...binds)
    .first<T>();
}

async function all<T>(db: D1Database, sql: string, ...binds: unknown[]): Promise<T[]> {
  const { results } = await db
    .prepare(sql)
    .bind(...binds)
    .all<T>();
  return results ?? [];
}

/**
 * Overview: the numbers somebody accountable for this checks first, plus the
 * things that are actually wrong. "Needs attention" is deliberately computed
 * here rather than in the UI so the rule for what counts as a problem lives in
 * one place.
 */
portal.get('/overview', async (c) => {
  const db = c.env.DB;

  const counts = await row<{
    countries: number;
    countries_active: number;
    orgs: number;
    regional: number;
    sources: number;
    facts: number;
    signals: number;
    users: number;
    premium_users: number;
    cards: number;
    messages: number;
    ratings: number;
    subscriptions: number;
    playbooks: number;
    feedback_new: number;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM entities WHERE kind='country')                    AS countries,
       (SELECT COUNT(*) FROM entities WHERE kind='country' AND is_active=1)    AS countries_active,
       (SELECT COUNT(*) FROM entities WHERE kind='intl_org')                   AS orgs,
       (SELECT COUNT(*) FROM entities WHERE kind='regional_body')              AS regional,
       (SELECT COUNT(*) FROM entity_sources)                                   AS sources,
       (SELECT COUNT(*) FROM trade_facts)                                      AS facts,
       (SELECT COUNT(*) FROM opportunity_signals)                              AS signals,
       (SELECT COUNT(*) FROM users)                                            AS users,
       (SELECT COUNT(*) FROM users WHERE tier <> 'free')                       AS premium_users,
       (SELECT COUNT(*) FROM business_cards)                                   AS cards,
       (SELECT COUNT(*) FROM messages)                                         AS messages,
       (SELECT COUNT(*) FROM ratings)                                          AS ratings,
       (SELECT COUNT(*) FROM subscriptions)                                    AS subscriptions,
       (SELECT COUNT(*) FROM playbooks)                                        AS playbooks,
       (SELECT COUNT(*) FROM feedback WHERE status='new')                      AS feedback_new`,
  );

  const lastRun = await row<{
    id: string;
    trigger: string;
    status: string;
    started_at: string;
    finished_at: string | null;
    entities_ok: number;
    entities_failed: number;
    entities_skipped: number;
    facts_written: number;
  }>(db, `SELECT * FROM analysis_runs ORDER BY started_at DESC LIMIT 1`);

  // Countries that are switched on but have never produced figures. This is
  // the single most common reason the app looks empty, so it is surfaced
  // rather than left to be discovered.
  const activeNeverRun = await row<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM entities
      WHERE kind='country' AND is_active=1 AND last_ingest_at IS NULL`,
  );

  const stale = await row<{ n: number }>(
    db,
    `SELECT COUNT(*) AS n FROM entities
      WHERE kind='country' AND is_active=1
        AND last_ingest_at IS NOT NULL
        AND julianday('now') - julianday(last_ingest_at) > 14`,
  );

  const withErrors = await all<{ slug: string; name: string; last_error: string }>(
    db,
    `SELECT slug, name, last_error FROM entities
      WHERE last_error IS NOT NULL AND is_active=1
      ORDER BY name LIMIT 20`,
  );

  // Link health is classified by the shared linkHealth() helper rather than by
  // a second set of SQL rules. An earlier version did the buckets in SQL and
  // silently dropped every source whose probe failed to connect at all
  // (status 0), so the four counts did not add up to the number of sources.
  // One definition, used by the portal and the country page alike.
  const sourceRows = await all<{ last_status: number | null; fmt: SourceFmt }>(
    db,
    `SELECT last_status, fmt FROM entity_sources`,
  );
  const linkHealthCounts = { ok: 0, gated: 0, dead: 0, unknown: 0 };
  for (const s of sourceRows) linkHealthCounts[linkHealth(s.last_status, s.fmt)]++;

  return json({
    counts: counts ?? {},
    last_run: lastRun,
    attention: {
      active_never_run: activeNeverRun?.n ?? 0,
      stale_over_14_days: stale?.n ?? 0,
      countries_with_errors: withErrors,
      dead_links: linkHealthCounts.dead,
      feedback_new: counts?.feedback_new ?? 0,
    },
    link_health: linkHealthCounts,
  });
});

/** Pipeline: run history and per-country ingest state. */
portal.get('/pipeline', async (c) => {
  const db = c.env.DB;

  const runs = await all(
    db,
    `SELECT id, trigger, status, started_at, finished_at,
            entities_total, entities_ok, entities_failed, entities_skipped, facts_written
       FROM analysis_runs ORDER BY started_at DESC LIMIT 25`,
  );

  const countries = await all(
    db,
    `SELECT e.slug, e.name, e.iso3, e.continent, e.is_active, e.coverage_score,
            e.last_ingest_at, e.last_checked_at, e.last_error,
            (SELECT COUNT(*) FROM opportunity_signals s WHERE s.entity_id = e.id) AS signals,
            (SELECT COUNT(*) FROM trade_facts f WHERE f.entity_id = e.id)         AS facts
       FROM entities e
      WHERE e.kind = 'country'
      ORDER BY e.is_active DESC, e.last_ingest_at IS NULL DESC, e.name`,
  );

  return json({ runs, countries });
});

/** Accounts. No password material is selected, ever. */
portal.get('/users', async (c) => {
  const db = c.env.DB;
  const q = (c.req.query('q') ?? '').trim();

  const users = await all(
    db,
    `SELECT u.id, u.email, u.full_name, u.country_iso3, u.role, u.tier,
            u.tier_expires_at, u.email_verified, u.created_at, u.last_seen_at,
            (SELECT COUNT(*) FROM business_cards b WHERE b.user_id = u.id)  AS cards,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id)   AS follows
       FROM users u
      ${q ? 'WHERE u.email LIKE ? OR u.full_name LIKE ?' : ''}
      ORDER BY u.created_at DESC
      LIMIT 200`,
    ...(q ? [`%${q}%`, `%${q}%`] : []),
  );

  const byTier = await all(db, `SELECT tier, COUNT(*) AS n FROM users GROUP BY tier`);
  const signupsByDay = await all(
    db,
    `SELECT substr(created_at, 1, 10) AS day, COUNT(*) AS n
       FROM users
      WHERE julianday('now') - julianday(created_at) <= 30
      GROUP BY day ORDER BY day`,
  );

  return json({ users, by_tier: byTier, signups_by_day: signupsByDay });
});

/** The network side: cards, conversations, ratings. */
portal.get('/network', async (c) => {
  const db = c.env.DB;

  const cards = await all(
    db,
    `SELECT b.id, b.display_name, b.company, b.headline, b.country_iso3,
            b.is_published, b.is_verified, b.rating_avg, b.rating_count, b.created_at,
            u.email AS owner_email, u.full_name AS owner_name
       FROM business_cards b
       LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT 100`,
  );

  const activity = await row<{
    conversations: number;
    messages: number;
    messages_7d: number;
    ratings: number;
  }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM conversations) AS conversations,
       (SELECT COUNT(*) FROM messages)      AS messages,
       (SELECT COUNT(*) FROM messages WHERE julianday('now') - julianday(created_at) <= 7) AS messages_7d,
       (SELECT COUNT(*) FROM ratings)       AS ratings`,
  );

  // ratings.rater_id and subject_id reference users(id), not business_cards(id):
  // a reputation belongs to the person, not to whichever card they currently
  // publish. Joining these to card ids returns nothing but nulls.
  const recentRatings = await all(
    db,
    `SELECT r.id, r.score, r.comment, r.dealt_in, r.created_at,
            subject.full_name AS rated_name,
            subject.email AS rated_email,
            rater.full_name AS rater_name,
            subject_card.headline AS rated_headline
       FROM ratings r
       LEFT JOIN users subject ON subject.id = r.subject_id
       LEFT JOIN users rater ON rater.id = r.rater_id
       LEFT JOIN business_cards subject_card ON subject_card.user_id = r.subject_id
      ORDER BY r.created_at DESC LIMIT 40`,
  );

  return json({ cards, activity: activity ?? {}, recent_ratings: recentRatings });
});

/** Premium: who follows what, and what billing has recorded. */
portal.get('/premium', async (c) => {
  const db = c.env.DB;

  const byKind = await all(
    db,
    `SELECT kind, COUNT(*) AS n FROM subscriptions GROUP BY kind ORDER BY n DESC`,
  );

  const topFollowed = await all(
    db,
    `SELECT kind, value, MAX(label) AS label, COUNT(*) AS followers
       FROM subscriptions
      GROUP BY kind, value
      ORDER BY followers DESC, label
      LIMIT 40`,
  );

  const feed = await row<{ items: number; unread: number; premium_items: number }>(
    db,
    `SELECT
       (SELECT COUNT(*) FROM feed_items) AS items,
       (SELECT COUNT(*) FROM feed_items WHERE read_at IS NULL) AS unread,
       (SELECT COUNT(*) FROM feed_items WHERE premium_only = 1) AS premium_items`,
  );

  const billing = await all(
    db,
    `SELECT b.id, b.kind, b.provider, b.plan, b.amount_minor, b.currency,
            b.period_end, b.created_at, u.email AS user_email
       FROM billing_events b
       LEFT JOIN users u ON u.id = b.user_id
      ORDER BY b.created_at DESC LIMIT 40`,
  );

  return json({ by_kind: byKind, top_followed: topFollowed, feed: feed ?? {}, billing });
});

/** Source links, so dead citations are visible rather than discovered. */
portal.get('/sources', async (c) => {
  const db = c.env.DB;
  const health = (c.req.query('health') ?? '').trim();

  const sources = await all<{
    id: string;
    url: string;
    label: string | null;
    category: string;
    slot: number;
    fmt: SourceFmt;
    last_status: number | null;
    last_checked_at: string | null;
    tls_warning: number | null;
    slug: string;
    entity_name: string;
    kind: string;
    is_active: number;
  }>(
    db,
    `SELECT s.id, s.url, s.label, s.category, s.slot, s.fmt, s.last_status,
            s.last_checked_at, s.tls_warning,
            e.slug, e.name AS entity_name, e.kind, e.is_active
       FROM entity_sources s
       JOIN entities e ON e.id = s.entity_id
      ORDER BY e.name, s.category, s.slot`,
  );

  // Filtered in JS against the shared classifier for the same reason the
  // overview counts are: a second definition in SQL drifts from the first.
  const withHealth = sources.map((s) => ({ ...s, health: linkHealth(s.last_status, s.fmt) }));
  const filtered = health ? withHealth.filter((s) => s.health === health) : withHealth;

  return json({ sources: filtered.slice(0, 400), count: filtered.length });
});

/** Playbook library. */
portal.get('/content', async (c) => {
  const playbooks = await all(
    c.env.DB,
    `SELECT slug, title, sector, country_iso3, hs_code, premium_only,
            reading_minutes, published_at, updated_at,
            length(body_md) AS body_chars
       FROM playbooks ORDER BY sector, title`,
  );
  return json({ playbooks });
});

/**
 * Setup: what is configured and what is not.
 *
 * Reports only whether a secret is present, never its value. A portal that
 * prints keys is a portal that leaks them into screenshots.
 */
portal.get('/setup', async (c) => {
  const env = c.env as unknown as Record<string, unknown>;
  const present = (k: string) => Boolean(env[k]);

  const rowCounts = await row<{ facts: number; results: number; migrations: number }>(
    c.env.DB,
    `SELECT
       (SELECT COUNT(*) FROM trade_facts)      AS facts,
       (SELECT COUNT(*) FROM analysis_results) AS results,
       (SELECT COUNT(*) FROM d1_migrations)    AS migrations`,
  );

  return json({
    config: [
      {
        key: 'ADMIN_TOKEN',
        set: present('ADMIN_TOKEN'),
        why: 'Gates this portal and the ingest endpoints the local pipeline pushes to.',
        required: true,
      },
      {
        key: 'COMTRADE_API_KEY',
        set: present('COMTRADE_API_KEY'),
        why: 'Lifts the 500-row cap. Without it the pipeline fetches products one HS chapter at a time, which works but takes about seven minutes per country instead of seconds.',
        required: false,
      },
      {
        key: 'STRIPE_SECRET_KEY',
        set: present('STRIPE_SECRET_KEY'),
        why: 'Required before anybody can actually pay. Premium gating works without it; taking money does not.',
        required: false,
      },
      {
        key: 'STRIPE_WEBHOOK_SECRET',
        set: present('STRIPE_WEBHOOK_SECRET'),
        why: 'Verifies billing callbacks. Without it a webhook cannot be trusted and is rejected.',
        required: false,
      },
      {
        key: 'CACHE',
        set: present('CACHE'),
        why: 'KV namespace backing rate limits. If absent the limiters fail open.',
        required: true,
      },
    ],
    db: rowCounts ?? {},
    notes: [
      'Ingest and analysis run on your machine, not on Workers. Start a run with `npm run pipeline`.',
      'There is no scheduled() handler by design. The Worker serves readers; it does not fetch.',
    ],
  });
});

/**
 * The tunable numbers, grouped for editing.
 *
 * These were constants scattered across the analysis code. Moving them into a
 * table means the person who has to defend a figure can change what produced
 * it without a deploy, and can see what it was before they touched it.
 */
portal.get('/config', async (c) => {
  const rows = await all<{
    code: string;
    name: string;
    description: string | null;
    value: string;
    default_value: string;
    kind: string;
    category: string;
    updated_at: string | null;
  }>(
    c.env.DB,
    `SELECT code, name, description, value, default_value, kind, category, updated_at
       FROM code_setup
      ORDER BY category, name`,
  );

  const categories = [...new Set(rows.map((r) => r.category))];
  return json({
    settings: rows.map((r) => ({ ...r, changed: r.value !== r.default_value })),
    categories,
    note:
      'Changing a threshold changes what the analysis produces, not what is displayed on top of it. '
      + 'Run `npm run pipeline -- --reanalyse` afterwards to recompute from stored facts without refetching.',
  });
});

/**
 * Write one setting.
 *
 * Values are validated against the kind before they land, because a threshold
 * that fails to parse would silently fall back to its default and the portal
 * would keep showing the number somebody thought they had set.
 */
portal.put('/config/:code', async (c) => {
  const code = c.req.param('code');
  const body = await c.req
    .json<{ value?: unknown }>()
    .catch(() => ({}) as { value?: unknown });
  const raw = body.value;

  if (typeof raw !== 'string' && typeof raw !== 'number') {
    return json({ error: 'value must be a string or a number' }, 400);
  }
  const value = String(raw).trim();

  const existing = await row<{ kind: string; default_value: string }>(
    c.env.DB,
    'SELECT kind, default_value FROM code_setup WHERE code = ?',
    code,
  );
  if (!existing) return json({ error: 'no such setting' }, 404);

  if (existing.kind !== 'text') {
    const n = Number(value);
    if (!Number.isFinite(n)) return json({ error: `${code} must be a number` }, 400);
    if (existing.kind === 'percent' && n < 0) {
      return json({ error: 'a percent threshold cannot be negative' }, 400);
    }
    if ((existing.kind === 'usd' || existing.kind === 'count') && n < 0) {
      return json({ error: `${code} cannot be negative` }, 400);
    }
  }

  await c.env.DB.prepare(
    `UPDATE code_setup SET value = ?, updated_at = datetime('now') WHERE code = ?`,
  )
    .bind(value, code)
    .run();

  return json({ code, value, reverted: value === existing.default_value });
});

/** Put one setting back to what the code shipped with. */
portal.post('/config/:code/reset', async (c) => {
  const code = c.req.param('code');
  const existing = await row<{ default_value: string }>(
    c.env.DB,
    'SELECT default_value FROM code_setup WHERE code = ?',
    code,
  );
  if (!existing) return json({ error: 'no such setting' }, 404);

  await c.env.DB.prepare(
    `UPDATE code_setup SET value = default_value, updated_at = datetime('now') WHERE code = ?`,
  )
    .bind(code)
    .run();

  return json({ code, value: existing.default_value });
});
