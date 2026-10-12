import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { currentUser } from '../lib/session';

/** A user's own notifications. Every query is scoped by the caller's id. */
export const notifications = new Hono<{ Bindings: Env }>();

notifications.get('/', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, kind, ref_id, body, read_at, created_at FROM notifications
      WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT 50`,
  ).bind(user.id).all();
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM notifications WHERE user_id = ? AND read_at IS NULL')
    .bind(user.id).first<{ n: number }>();
  return json({ notifications: results, unread: n?.n ?? 0 });
});

/** One cheap call for the nav badge: unread notifications and unread messages. */
notifications.get('/count', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const row = await c.env.DB.prepare(
    `SELECT (SELECT COUNT(*) FROM notifications WHERE user_id = ?1 AND read_at IS NULL) AS notifications,
            (SELECT COUNT(*) FROM messages m JOIN conversations c ON c.id = m.conversation_id
              WHERE (c.a_user_id = ?1 OR c.b_user_id = ?1) AND m.sender_id <> ?1 AND m.read_at IS NULL) AS messages`,
  ).bind(user.id).first<{ notifications: number; messages: number }>();
  return json({ notifications: row?.notifications ?? 0, messages: row?.messages ?? 0 });
});

notifications.post('/read', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const b = (await c.req.json().catch(() => null)) as { ids?: unknown } | null;
  if (Array.isArray(b?.ids)) {
    const ids = (b!.ids as unknown[]).filter((x): x is string => typeof x === 'string').slice(0, 100);
    if (!ids.length) return bad('No ids given');
    const marks = ids.map(() => '?').join(',');
    await c.env.DB.prepare(
      `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL AND id IN (${marks})`,
    ).bind(user.id, ...ids).run();
  } else {
    await c.env.DB.prepare(`UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL`)
      .bind(user.id).run();
  }
  return json({ ok: true });
});
