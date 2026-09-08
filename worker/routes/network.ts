import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { currentUser } from '../lib/session';
import { rateLimit, tooMany } from '../lib/ratelimit';
import { INTENTS, type BusinessCard, type BusinessCardInput, type Intent } from '../../shared/types';

export const network = new Hono<{ Bindings: Env }>();

interface CardRow {
  id: string;
  user_id: string;
  display_name: string;
  company: string | null;
  headline: string | null;
  bio: string | null;
  country_iso3: string;
  city: string | null;
  website: string | null;
  whatsapp: string | null;
  intents: string;
  sectors: string | null;
  hs_codes: string | null;
  target_markets: string | null;
  is_published: 0 | 1;
  is_verified: 0 | 1;
  rating_avg: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
}

function parseList(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.map(String) : [];
  } catch {
    return [];
  }
}

function toCard(r: CardRow): BusinessCard {
  return {
    ...r,
    intents: parseList(r.intents) as Intent[],
    sectors: parseList(r.sectors),
    hs_codes: parseList(r.hs_codes),
    target_markets: parseList(r.target_markets),
  };
}

// --- my card ----------------------------------------------------------------

network.get('/cards/me', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const row = await c.env.DB.prepare('SELECT * FROM business_cards WHERE user_id = ?')
    .bind(user.id)
    .first<CardRow>();
  return json({ card: row ? toCard(row) : null });
});

/**
 * Remove your own card.
 *
 * Unpublishing hides a card but leaves the row, and the row holds a phone
 * number, a website and a city. Somebody who put those in must be able to take
 * them out again.
 *
 * Ratings are deliberately not touched: they are keyed on users, not cards,
 * because a reputation belongs to the person and deleting a card should not be
 * a way to shed it.
 */
network.delete('/cards/me', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const result = await c.env.DB.prepare('DELETE FROM business_cards WHERE user_id = ?')
    .bind(user.id)
    .run();

  if (!result.meta.changes) return bad('You do not have a card', 404);
  return json({ deleted: true });
});

/** Upsert. One card per user, so this is a PUT rather than a POST. */
network.put('/cards/me', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const input = (await c.req.json().catch(() => null)) as BusinessCardInput | null;
  if (!input) return bad('Invalid request');
  if (!input.display_name?.trim()) return bad('Add a display name');
  if (!/^[A-Za-z]{3}$/.test(input.country_iso3 ?? '')) return bad('Pick your country');

  const intents = (input.intents ?? []).filter((i) => INTENTS.includes(i));
  if (intents.length === 0) return bad('Pick at least one thing you are here to do');

  const clean = (list: string[] | undefined, cap: number) =>
    JSON.stringify([...new Set((list ?? []).map((s) => s.trim()).filter(Boolean))].slice(0, cap));

  const existing = await c.env.DB.prepare('SELECT id FROM business_cards WHERE user_id = ?')
    .bind(user.id)
    .first<{ id: string }>();
  const id = existing?.id ?? uid('card_');

  const fields = [
    input.display_name.trim(),
    input.company?.trim() || null,
    input.headline?.trim() || null,
    input.bio?.trim() || null,
    input.country_iso3.toUpperCase(),
    input.city?.trim() || null,
    input.website?.trim() || null,
    input.whatsapp?.trim() || null,
    JSON.stringify(intents),
    clean(input.sectors, 8),
    clean(input.hs_codes, 12),
    clean(input.target_markets, 12),
    input.is_published ? 1 : 0,
  ];

  if (existing) {
    await c.env.DB.prepare(
      `UPDATE business_cards SET
         display_name=?, company=?, headline=?, bio=?, country_iso3=?, city=?,
         website=?, whatsapp=?, intents=?, sectors=?, hs_codes=?, target_markets=?,
         is_published=?, updated_at=datetime('now')
       WHERE id=?`,
    )
      .bind(...fields, id)
      .run();
  } else {
    await c.env.DB.prepare(
      `INSERT INTO business_cards
         (id, user_id, display_name, company, headline, bio, country_iso3, city,
          website, whatsapp, intents, sectors, hs_codes, target_markets, is_published)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
      .bind(id, user.id, ...fields)
      .run();
  }

  await reindexCard(c.env, id);

  const row = await c.env.DB.prepare('SELECT * FROM business_cards WHERE id = ?')
    .bind(id)
    .first<CardRow>();
  return json({ card: row ? toCard(row) : null });
});

/** Keep the FTS table in step. Manual because fts5 here is not external-content. */
async function reindexCard(env: Env, cardId: string) {
  const row = await env.DB.prepare('SELECT * FROM business_cards WHERE id = ?')
    .bind(cardId)
    .first<CardRow>();
  await env.DB.prepare('DELETE FROM business_cards_fts WHERE card_id = ?').bind(cardId).run();
  if (!row || row.is_published !== 1) return;
  await env.DB.prepare(
    `INSERT INTO business_cards_fts (card_id, display_name, company, headline, bio, sectors, hs_codes)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      cardId,
      row.display_name,
      row.company ?? '',
      row.headline ?? '',
      row.bio ?? '',
      parseList(row.sectors).join(' '),
      parseList(row.hs_codes).join(' '),
    )
    .run();
}

// --- discovery --------------------------------------------------------------

network.get('/cards', async (c) => {
  const q = (c.req.query('q') ?? '').trim();
  const intent = c.req.query('intent');
  const sector = c.req.query('sector');
  const country = c.req.query('country');
  const limit = Math.min(Number(c.req.query('limit') ?? 40), 100);

  // Filters are kept separate from the text search so the fallback path can
  // reuse them without fragile index arithmetic.
  const filters: string[] = ['bc.is_published = 1'];
  const filterBinds: unknown[] = [];

  if (intent && INTENTS.includes(intent as Intent)) {
    filters.push('bc.intents LIKE ?');
    filterBinds.push(`%"${intent}"%`);
  }
  if (sector) {
    filters.push('bc.sectors LIKE ?');
    filterBinds.push(`%${sector}%`);
  }
  if (country) {
    filters.push('bc.country_iso3 = ?');
    filterBinds.push(country.toUpperCase());
  }

  const order = 'ORDER BY bc.is_verified DESC, bc.rating_avg DESC, bc.updated_at DESC LIMIT ?';
  let results: CardRow[] = [];

  const ftsTerm = q.replace(/["*()^:-]/g, ' ').trim();
  if (ftsTerm) {
    try {
      const r = await c.env.DB.prepare(
        `SELECT bc.* FROM business_cards bc
          WHERE ${filters.join(' AND ')}
            AND bc.id IN (SELECT card_id FROM business_cards_fts WHERE business_cards_fts MATCH ?)
          ${order}`,
      )
        .bind(...filterBinds, `${ftsTerm}*`, limit)
        .all<CardRow>();
      results = r.results ?? [];
    } catch {
      results = [];
    }
    // Nothing matched the index, or fts5 rejected the term — fall back to LIKE
    // so a search never returns a hard failure or a misleading empty list.
    if (results.length === 0) {
      const like = `%${q}%`;
      const r = await c.env.DB.prepare(
        `SELECT bc.* FROM business_cards bc
          WHERE ${filters.join(' AND ')}
            AND (bc.display_name LIKE ? OR bc.company LIKE ? OR bc.headline LIKE ?
                 OR bc.bio LIKE ? OR bc.sectors LIKE ? OR bc.hs_codes LIKE ?)
          ${order}`,
      )
        .bind(...filterBinds, like, like, like, like, like, like, limit)
        .all<CardRow>();
      results = r.results ?? [];
    }
  } else {
    const r = await c.env.DB.prepare(
      `SELECT bc.* FROM business_cards bc WHERE ${filters.join(' AND ')} ${order}`,
    )
      .bind(...filterBinds, limit)
      .all<CardRow>();
    results = r.results ?? [];
  }

  return json({ cards: results.map(toCard), count: results.length });
});

network.get('/cards/:id', async (c) => {
  const row = await c.env.DB.prepare(
    'SELECT * FROM business_cards WHERE (id = ? OR user_id = ?) AND is_published = 1',
  )
    .bind(c.req.param('id'), c.req.param('id'))
    .first<CardRow>();
  if (!row) return bad('Not found', 404);

  const { results: ratings } = await c.env.DB.prepare(
    `SELECT r.id, r.rater_id, r.score, r.dealt_in, r.comment, r.created_at,
            COALESCE(bc.display_name, u.full_name) AS rater_name
       FROM ratings r
       JOIN users u ON u.id = r.rater_id
       LEFT JOIN business_cards bc ON bc.user_id = r.rater_id
      WHERE r.subject_id = ?
      ORDER BY r.created_at DESC
      LIMIT 20`,
  )
    .bind(row.user_id)
    .all();

  return json({ card: toCard(row), ratings: ratings ?? [] });
});

// --- conversations ----------------------------------------------------------

/** Deterministic pair key so A->B and B->A never create two threads. */
function pair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

network.post('/conversations', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);

  const body = (await c.req.json().catch(() => null)) as {
    to_user_id: string;
    subject?: string;
    body?: string;
  } | null;
  if (!body?.to_user_id) return bad('to_user_id required');
  if (body.to_user_id === user.id) return bad('You cannot message yourself');

  const target = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(body.to_user_id)
    .first<{ id: string }>();
  if (!target) return bad('That person does not exist', 404);

  const [a, b] = pair(user.id, body.to_user_id);
  let convo = await c.env.DB.prepare(
    'SELECT id FROM conversations WHERE a_user_id = ? AND b_user_id = ?',
  )
    .bind(a, b)
    .first<{ id: string }>();

  if (!convo) {
    const id = uid('con_');
    await c.env.DB.prepare(
      'INSERT INTO conversations (id, a_user_id, b_user_id, subject) VALUES (?, ?, ?, ?)',
    )
      .bind(id, a, b, body.subject?.trim() || null)
      .run();
    convo = { id };
  }

  if (body.body?.trim()) {
    await sendMessage(c.env, convo.id, user.id, body.body);
  }

  return json({ conversation_id: convo.id }, 201);
});

network.get('/conversations', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const { results } = await c.env.DB.prepare(
    `SELECT
       c.id,
       CASE WHEN c.a_user_id = ?1 THEN c.b_user_id ELSE c.a_user_id END AS other_user_id,
       COALESCE(bc.display_name, u.full_name)                          AS other_name,
       bc.company                                                      AS other_company,
       COALESCE(bc.country_iso3, u.country_iso3)                       AS other_country,
       (SELECT body FROM messages m WHERE m.conversation_id = c.id
         ORDER BY m.created_at DESC LIMIT 1)                           AS last_message,
       c.last_message_at,
       (SELECT COUNT(*) FROM messages m WHERE m.conversation_id = c.id
          AND m.sender_id <> ?1 AND m.read_at IS NULL)                 AS unread
     FROM conversations c
     JOIN users u ON u.id = CASE WHEN c.a_user_id = ?1 THEN c.b_user_id ELSE c.a_user_id END
     LEFT JOIN business_cards bc ON bc.user_id = u.id
    WHERE c.a_user_id = ?1 OR c.b_user_id = ?1
    ORDER BY COALESCE(c.last_message_at, c.created_at) DESC
    LIMIT 60`,
  )
    .bind(user.id)
    .all();

  return json({ conversations: results ?? [] });
});

network.get('/conversations/:id/messages', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const cid = c.req.param('id');

  const convo = await c.env.DB.prepare(
    'SELECT id, a_user_id, b_user_id FROM conversations WHERE id = ? AND (a_user_id = ? OR b_user_id = ?)',
  )
    .bind(cid, user.id, user.id)
    .first<{ id: string; a_user_id: string; b_user_id: string }>();
  if (!convo) return bad('Not found', 404);

  const { results } = await c.env.DB.prepare(
    `SELECT id, conversation_id, sender_id, body, read_at, created_at
       FROM messages WHERE conversation_id = ? ORDER BY created_at ASC LIMIT 300`,
  )
    .bind(cid)
    .all<{ id: string; sender_id: string }>();

  // Mark the other side's messages read as soon as the thread is opened.
  await c.env.DB.prepare(
    `UPDATE messages SET read_at = datetime('now')
      WHERE conversation_id = ? AND sender_id <> ? AND read_at IS NULL`,
  )
    .bind(cid, user.id)
    .run();

  const otherId = convo.a_user_id === user.id ? convo.b_user_id : convo.a_user_id;
  const other = await c.env.DB.prepare(
    `SELECT COALESCE(bc.display_name, u.full_name) AS name, bc.company, u.id
       FROM users u LEFT JOIN business_cards bc ON bc.user_id = u.id WHERE u.id = ?`,
  )
    .bind(otherId)
    .first();

  return json({
    messages: (results ?? []).map((m) => ({ ...m, mine: m.sender_id === user.id })),
    other,
  });
});

network.post('/conversations/:id/messages', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);

  const cid = c.req.param('id');

  const convo = await c.env.DB.prepare(
    'SELECT id FROM conversations WHERE id = ? AND (a_user_id = ? OR b_user_id = ?)',
  )
    .bind(cid, user.id, user.id)
    .first<{ id: string }>();
  if (!convo) return bad('Not found', 404);

  const body = (await c.req.json().catch(() => null)) as { body: string } | null;
  if (!body?.body?.trim()) return bad('Write something first');

  const message = await sendMessage(c.env, cid, user.id, body.body);
  return json({ message }, 201);
});

async function sendMessage(env: Env, conversationId: string, senderId: string, raw: string) {
  const body = raw.trim().slice(0, 4000);
  const id = uid('msg_');
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO messages (id, conversation_id, sender_id, body) VALUES (?, ?, ?, ?)',
    ).bind(id, conversationId, senderId, body),
    env.DB.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").bind(
      conversationId,
    ),
  ]);
  return { id, conversation_id: conversationId, sender_id: senderId, body, mine: true };
}

// --- ratings ----------------------------------------------------------------

network.post('/ratings', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  // Reputation is the thing on this platform worth faking, so the route that
  // writes it gets a brake. Twenty an hour is far more than anybody rates in
  // good faith and low enough that a score cannot be moved in one sitting.
  const rateLimited = await rateLimit(c.env, 'rating', `rating:${user.id}`);
  if (!rateLimited.ok) return tooMany(rateLimited);

  const body = (await c.req.json().catch(() => null)) as {
    subject_id: string;
    score: number;
    dealt_in?: string;
    comment?: string;
  } | null;
  if (!body?.subject_id) return bad('subject_id required');
  if (body.subject_id === user.id) return bad('You cannot rate yourself');
  const score = Math.round(Number(body.score));
  if (!(score >= 1 && score <= 5)) return bad('Score must be 1 to 5');

  const subject = await c.env.DB.prepare('SELECT id FROM users WHERE id = ?')
    .bind(body.subject_id)
    .first<{ id: string }>();
  if (!subject) return bad('That person does not exist', 404);

  // Only people who have actually spoken can rate. Stops drive-by scoring.
  const hasDealt = await c.env.DB.prepare(
    `SELECT 1 AS ok FROM conversations
      WHERE (a_user_id = ?1 AND b_user_id = ?2) OR (a_user_id = ?2 AND b_user_id = ?1)`,
  )
    .bind(user.id, body.subject_id)
    .first<{ ok: number }>();
  if (!hasDealt) return bad('You can only rate someone you have dealt with', 403);

  await c.env.DB.prepare(
    `INSERT INTO ratings (id, rater_id, subject_id, score, dealt_in, comment)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (rater_id, subject_id) DO UPDATE SET
       score = excluded.score,
       dealt_in = excluded.dealt_in,
       comment = excluded.comment,
       created_at = datetime('now')`,
  )
    .bind(
      uid('rat_'),
      user.id,
      body.subject_id,
      score,
      body.dealt_in?.trim() || null,
      body.comment?.trim() || null,
    )
    .run();

  await recomputeRating(c.env, body.subject_id);
  return json({ ok: true }, 201);
});

async function recomputeRating(env: Env, subjectId: string) {
  const agg = await env.DB.prepare(
    'SELECT AVG(score) AS avg, COUNT(*) AS n FROM ratings WHERE subject_id = ?',
  )
    .bind(subjectId)
    .first<{ avg: number | null; n: number }>();
  await env.DB.prepare(
    'UPDATE business_cards SET rating_avg = ?, rating_count = ? WHERE user_id = ?',
  )
    .bind(Math.round((agg?.avg ?? 0) * 100) / 100, agg?.n ?? 0, subjectId)
    .run();
}
