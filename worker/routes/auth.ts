import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import {
  clearCookie,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  passwordProblem,
  isSecureRequest,
  sessionCookie,
  validEmail,
  verifyPassword,
} from '../lib/session';

export const auth = new Hono<{ Bindings: Env }>();

interface RegisterBody {
  email: string;
  password: string;
  full_name: string;
  country_iso3?: string;
}

/**
 * Registration is deliberately three fields. The brief asked for simple, easy
 * registration; the business card is a separate, optional step afterwards.
 */
auth.post('/register', async (c) => {
  const body = (await c.req.json().catch(() => null)) as RegisterBody | null;
  if (!body) return bad('Invalid request');

  const email = (body.email ?? '').trim().toLowerCase();
  const name = (body.full_name ?? '').trim();

  if (!validEmail(email)) return bad('Enter a valid email address');
  if (name.length < 2) return bad('Enter your name');
  const pwProblem = passwordProblem(body.password ?? '');
  if (pwProblem) return bad(pwProblem);

  const existing = await c.env.DB.prepare('SELECT id FROM users WHERE email = ?')
    .bind(email)
    .first<{ id: string }>();
  if (existing) return bad('An account with that email already exists', 409);

  const { hash, salt } = await hashPassword(body.password);
  const id = uid('usr_');

  await c.env.DB.prepare(
    `INSERT INTO users (id, email, password_hash, password_salt, full_name, country_iso3)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, email, hash, salt, name, body.country_iso3?.toUpperCase() ?? null)
    .run();

  const sid = await createSession(c.env, id);
  return json(
    {
      user: {
        id,
        email,
        full_name: name,
        role: 'member',
        tier: 'free',
        country_iso3: body.country_iso3?.toUpperCase() ?? null,
      },
    },
    201,
    { 'set-cookie': sessionCookie(sid, isSecureRequest(c.req.raw)) },
  );
});

auth.post('/login', async (c) => {
  const body = (await c.req.json().catch(() => null)) as {
    email: string;
    password: string;
  } | null;
  if (!body) return bad('Invalid request');

  const email = (body.email ?? '').trim().toLowerCase();
  const row = await c.env.DB.prepare(
    `SELECT id, email, full_name, role, tier, country_iso3, password_hash, password_salt
       FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      full_name: string;
      role: 'member' | 'admin';
      tier: 'free' | 'premium';
      country_iso3: string | null;
      password_hash: string;
      password_salt: string;
    }>();

  // Same message either way so the form cannot be used to enumerate accounts.
  const generic = 'Email or password is not right';
  if (!row) {
    // Burn comparable time so a missing account is not detectably faster.
    await hashPassword(body.password ?? '');
    return bad(generic, 401);
  }

  const okPassword = await verifyPassword(
    body.password ?? '',
    row.password_hash,
    row.password_salt,
  );
  if (!okPassword) return bad(generic, 401);

  await c.env.DB.prepare("UPDATE users SET last_seen_at = datetime('now') WHERE id = ?")
    .bind(row.id)
    .run();

  const sid = await createSession(c.env, row.id);
  return json(
    {
      user: {
        id: row.id,
        email: row.email,
        full_name: row.full_name,
        role: row.role,
        tier: row.tier,
        country_iso3: row.country_iso3,
      },
    },
    200,
    { 'set-cookie': sessionCookie(sid, isSecureRequest(c.req.raw)) },
  );
});

auth.post('/logout', async (c) => {
  await destroySession(c.req.raw, c.env);
  return json({ ok: true }, 200, { 'set-cookie': clearCookie(isSecureRequest(c.req.raw)) });
});

/** Who am I, plus whether I have a card yet and how many unread messages. */
auth.get('/me', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return json({ user: null });

  const card = await c.env.DB.prepare(
    'SELECT id, is_published FROM business_cards WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ id: string; is_published: 0 | 1 }>();

  const unread = await c.env.DB.prepare(
    `SELECT COUNT(*) AS n
       FROM messages m
       JOIN conversations c ON c.id = m.conversation_id
      WHERE m.sender_id <> ?
        AND m.read_at IS NULL
        AND (c.a_user_id = ? OR c.b_user_id = ?)`,
  )
    .bind(user.id, user.id, user.id)
    .first<{ n: number }>();

  return json({
    user,
    has_card: Boolean(card),
    card_published: card?.is_published === 1,
    unread: unread?.n ?? 0,
  });
});

/** Premium toggle stands in for billing until Phase 3. */
auth.post('/tier', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const body = (await c.req.json().catch(() => null)) as { tier: 'free' | 'premium' } | null;
  if (!body || !['free', 'premium'].includes(body.tier)) return bad('tier must be free or premium');
  await c.env.DB.prepare('UPDATE users SET tier = ? WHERE id = ?').bind(body.tier, user.id).run();
  return json({ tier: body.tier });
});
