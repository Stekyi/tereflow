import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { currentUser } from '../lib/session';
import { rateLimit, tooMany } from '../lib/ratelimit';

/**
 * Following, business posts and saved opportunities. Every route needs a
 * signed-in user, and anything private (notes, links, the shortlist) is
 * scoped by the caller's id in SQL, so another user's row is simply not found.
 */
export const social = new Hono<{ Bindings: Env }>();

export const SAVED_STATUSES = ['new', 'researching', 'contacted', 'negotiating', 'won', 'dropped'] as const;
const SLUG = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ISO3 = /^[A-Z]{3}$/;
const HS = /^\d{2,10}$/;
const PAGE = 20;

/** A people-follow target must be somebody with a published card. */
async function publishedUser(env: Env, userId: string): Promise<boolean> {
  const r = await env.DB.prepare('SELECT 1 AS ok FROM business_cards WHERE user_id = ? AND is_published = 1')
    .bind(userId).first<{ ok: number }>();
  return !!r;
}

function cleanLinks(raw: unknown): string[] | null {
  if (raw == null) return [];
  if (!Array.isArray(raw) || raw.length > 10) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v !== 'string' || v.length > 500) return null;
    let u: URL;
    try { u = new URL(v); } catch { return null; }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return null;
    out.push(u.toString());
  }
  return out;
}

// --- following --------------------------------------------------------------

social.post('/follow/:userId', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const target = c.req.param('userId');
  if (target === user.id) return bad('You cannot follow yourself');
  if (!(await publishedUser(c.env, target))) return bad('That profile does not exist', 404);
  await c.env.DB.prepare('INSERT OR IGNORE INTO follows (follower_id, followee_id) VALUES (?, ?)')
    .bind(user.id, target).run();
  return json({ following: true });
});

social.delete('/follow/:userId', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  await c.env.DB.prepare('DELETE FROM follows WHERE follower_id = ? AND followee_id = ?')
    .bind(user.id, c.req.param('userId')).run();
  return json({ following: false });
});

social.get('/following', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const { results } = await c.env.DB.prepare(
    `SELECT b.user_id, b.display_name, b.company, b.headline, b.country_iso3, f.created_at
       FROM follows f JOIN business_cards b ON b.user_id = f.followee_id AND b.is_published = 1
      WHERE f.follower_id = ? ORDER BY f.created_at DESC LIMIT 200`,
  ).bind(user.id).all();
  return json({ following: results });
});

social.get('/profile/:userId/stats', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const id = c.req.param('userId');
  if (!(await publishedUser(c.env, id))) return bad('That profile does not exist', 404);
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM follows WHERE followee_id = ?1) AS followers,
            (SELECT COUNT(*) FROM follows WHERE follower_id = ?1) AS following,
            (SELECT COUNT(*) FROM posts WHERE author_id = ?1) AS posts,
            (SELECT COUNT(*) FROM follows WHERE follower_id = ?2 AND followee_id = ?1) AS am_following`,
  ).bind(id, user.id).first<{ followers: number; following: number; posts: number; am_following: number }>();
  return json({ followers: row?.followers ?? 0, following: row?.following ?? 0, posts: row?.posts ?? 0, am_following: !!row?.am_following });
});

// --- business posts and the activity feed -----------------------------------

social.post('/posts', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);
  if (!(await publishedUser(c.env, user.id))) return bad('Publish your business card before posting', 403);
  const body = (await c.req.json().catch(() => null)) as { body?: string; hs_code?: string } | null;
  const text = String(body?.body ?? '').trim();
  if (!text) return bad('Write something first');
  if (text.length > 2000) return bad('Posts are limited to 2000 characters');
  const hs = String(body?.hs_code ?? '').replace(/[\s.]/g, '');
  if (hs && !HS.test(hs)) return bad('hs_code must be 2 to 10 digits');
  const id = uid('pst_');
  await c.env.DB.prepare('INSERT INTO posts (id, author_id, body, hs_code) VALUES (?, ?, ?, ?)')
    .bind(id, user.id, text, hs || null).run();
  return json({ id }, 201);
});

social.delete('/posts/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const res = await c.env.DB.prepare('DELETE FROM posts WHERE id = ? AND author_id = ?')
    .bind(c.req.param('id'), user.id).run();
  if (!res.meta.changes) return bad('Post not found', 404);
  return json({ deleted: true });
});

/** Posts by the people you follow plus your own, newest first. `before` pages by timestamp. */
social.get('/feed', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const before = c.req.query('before') ?? '9999-12-31 00:00:00';
  const { results } = await c.env.DB.prepare(
    `SELECT p.id, p.author_id, p.body, p.hs_code, p.created_at, b.display_name, b.company
       FROM posts p JOIN business_cards b ON b.user_id = p.author_id AND b.is_published = 1
      WHERE (p.author_id = ?1 OR p.author_id IN (SELECT followee_id FROM follows WHERE follower_id = ?1))
        AND p.created_at < ?2
      ORDER BY p.created_at DESC, p.id DESC LIMIT ?3`,
  ).bind(user.id, before, PAGE + 1).all<{ created_at: string }>();
  const page = results.slice(0, PAGE);
  return json({ posts: page, next_before: results.length > PAGE ? page[page.length - 1].created_at : null });
});

social.get('/posts', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const author = c.req.query('user') ?? '';
  if (!author || !(await publishedUser(c.env, author))) return bad('That profile does not exist', 404);
  const { results } = await c.env.DB.prepare(
    'SELECT id, author_id, body, hs_code, created_at FROM posts WHERE author_id = ? ORDER BY created_at DESC, id DESC LIMIT 50',
  ).bind(author).all();
  return json({ posts: results });
});

// --- saved opportunities (private) -------------------------------------------

interface SavedRow {
  id: string; country_slug: string; partner_iso3: string; hs_code: string; flow: string; title: string;
  status: string; notes: string | null; research_links: string | null; created_at: string; updated_at: string;
}

function toSaved(r: SavedRow) {
  let links: string[] = [];
  try { const v = JSON.parse(r.research_links ?? '[]'); if (Array.isArray(v)) links = v.map(String); } catch { /* keep empty */ }
  return { ...r, research_links: links };
}

social.get('/saved', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const { results } = await c.env.DB.prepare(
    'SELECT * FROM saved_opportunities WHERE user_id = ? ORDER BY updated_at DESC, id DESC LIMIT 200',
  ).bind(user.id).all<SavedRow>();
  return json({ saved: results.map(toSaved) });
});

social.post('/saved', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  const country = String(b?.country_slug ?? '').trim().toLowerCase();
  const partner = String(b?.partner_iso3 ?? '').trim().toUpperCase();
  const hs = String(b?.hs_code ?? '').replace(/[\s.]/g, '');
  const flow = String(b?.flow ?? '').trim().toLowerCase();
  const title = String(b?.title ?? '').trim();
  if (!SLUG.test(country)) return bad('country_slug is not valid');
  if (partner && !ISO3.test(partner)) return bad('partner_iso3 is not valid');
  if (hs && !HS.test(hs)) return bad('hs_code must be 2 to 10 digits');
  if (flow && flow !== 'import' && flow !== 'export') return bad('flow must be import or export');
  if (!title || title.length > 200) return bad('title is required, up to 200 characters');
  const count = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM saved_opportunities WHERE user_id = ?')
    .bind(user.id).first<{ n: number }>();
  if ((count?.n ?? 0) >= 500) return bad('You have reached the limit of 500 saved opportunities', 409);
  const id = uid('sav_');
  const res = await c.env.DB.prepare(
    `INSERT OR IGNORE INTO saved_opportunities (id, user_id, country_slug, partner_iso3, hs_code, flow, title)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user.id, country, partner, hs, flow, title).run();
  if (!res.meta.changes) return bad('Already saved', 409);
  return json({ id }, 201);
});

social.patch('/saved/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return bad('Send a JSON body');
  const sets: string[] = [];
  const vals: unknown[] = [];
  if ('status' in b) {
    if (!SAVED_STATUSES.includes(b.status as (typeof SAVED_STATUSES)[number])) return bad('status is not valid');
    sets.push('status = ?'); vals.push(b.status);
  }
  if ('notes' in b) {
    const n = b.notes == null ? '' : String(b.notes);
    if (n.length > 5000) return bad('notes are limited to 5000 characters');
    sets.push('notes = ?'); vals.push(n || null);
  }
  if ('research_links' in b) {
    const links = cleanLinks(b.research_links);
    if (!links) return bad('research_links must be up to 10 http or https URLs');
    sets.push('research_links = ?'); vals.push(JSON.stringify(links));
  }
  if (!sets.length) return bad('Nothing to update');
  const res = await c.env.DB.prepare(
    `UPDATE saved_opportunities SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND user_id = ?`,
  ).bind(...vals, c.req.param('id'), user.id).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ updated: true });
});

social.delete('/saved/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const res = await c.env.DB.prepare('DELETE FROM saved_opportunities WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ deleted: true });
});
