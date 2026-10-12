import type { Env } from './db';
import { uid } from './db';

export type NotificationKind = 'message' | 'enquiry' | 'outbid' | 'auction_won' | 'auction_sold' | 'auction_ended';

/**
 * Writes one in-app notification. A message notification is folded into the
 * recipient's existing unread one for the same conversation, so a burst of
 * messages is one line, not twenty.
 */
export async function notify(env: Env, userId: string, kind: NotificationKind, refId: string, body: string): Promise<void> {
  const text = body.slice(0, 200);
  if (kind === 'message') {
    const res = await env.DB.prepare(
      `UPDATE notifications SET body = ?, created_at = datetime('now')
        WHERE user_id = ? AND kind = 'message' AND ref_id = ? AND read_at IS NULL`,
    ).bind(text, userId, refId).run();
    if (res.meta.changes) return;
  }
  await env.DB.prepare('INSERT INTO notifications (id, user_id, kind, ref_id, body) VALUES (?, ?, ?, ?, ?)')
    .bind(uid('ntf_'), userId, kind, refId, text).run();
}

/** Marks a user's unread notifications for one reference as read (opening a thread clears its alert). */
export async function clearFor(env: Env, userId: string, kind: NotificationKind, refId: string): Promise<void> {
  await env.DB.prepare(
    `UPDATE notifications SET read_at = datetime('now') WHERE user_id = ? AND kind = ? AND ref_id = ? AND read_at IS NULL`,
  ).bind(userId, kind, refId).run();
}
