import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import type { FeedbackInput, FeedbackKind } from '../../shared/types';

export const feedback = new Hono<{ Bindings: Env }>();

const KINDS: FeedbackKind[] = ['problem', 'request', 'other'];

/** Long enough for a real report, short enough that nobody pastes a novel. */
const MAX_MESSAGE = 2000;
const MIN_MESSAGE = 4;

/**
 * Anyone can send feedback, signed in or not.
 *
 * Requiring an account to report a broken page is how you stop hearing about
 * broken pages, so this is deliberately open and rate limited instead. When
 * the sender is signed in their id is recorded so a reply is possible without
 * asking for an email they already gave once.
 */
feedback.post('/', async (c) => {
  const limit = await rateLimit(c.env, 'feedback', clientKey(c.req.raw));
  if (!limit.ok) return tooMany(limit);

  let body: Partial<FeedbackInput>;
  try {
    body = (await c.req.json()) as Partial<FeedbackInput>;
  } catch {
    return bad('Expected a JSON body', 400);
  }

  const message = (body.message ?? '').trim();
  if (message.length < MIN_MESSAGE) return bad('Tell us a little more than that', 400);
  if (message.length > MAX_MESSAGE) {
    return bad(`Keep it under ${MAX_MESSAGE} characters`, 400);
  }

  const kind = KINDS.includes(body.kind as FeedbackKind) ? (body.kind as FeedbackKind) : 'other';
  const user = await currentUser(c.req.raw, c.env);

  // A signed-in sender is already reachable, so their account wins over
  // whatever was typed in the contact box.
  const contact = user ? null : (body.contact ?? '').trim().slice(0, 200) || null;

  await c.env.DB.prepare(
    `INSERT INTO feedback (id, user_id, kind, message, path, contact)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      uid('fbk_'),
      user?.id ?? null,
      kind,
      message,
      (body.path ?? '').trim().slice(0, 300) || null,
      contact,
    )
    .run();

  return json({ received: true });
});

/** Admin inbox. Nothing here is public. */
feedback.get('/', async (c) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;

  const status = c.req.query('status');
  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.kind, f.message, f.path, f.contact, f.status, f.created_at,
            u.full_name AS user_name, u.email AS user_email
       FROM feedback f
       LEFT JOIN users u ON u.id = f.user_id
      ${status ? 'WHERE f.status = ?' : ''}
      ORDER BY f.created_at DESC
      LIMIT 200`,
  )
    .bind(...(status ? [status] : []))
    .all();

  return json({ feedback: results ?? [], count: results?.length ?? 0 });
});

feedback.patch('/:id', async (c) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => ({}))) as { status?: string };
  if (!['new', 'read', 'done'].includes(body.status ?? '')) {
    return bad('status must be new, read or done', 400);
  }

  await c.env.DB.prepare('UPDATE feedback SET status = ? WHERE id = ?')
    .bind(body.status, c.req.param('id'))
    .run();

  return json({ updated: true });
});
