import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import {
  clearCookie,
  createSession,
  currentUser,
  destroySession,
  hashPassword,
  isEntitled,
  passwordProblem,
  isSecureRequest,
  sessionCookie,
  validEmail,
  verifyPassword,
} from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';

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
  const limited = await rateLimit(c.env, 'register', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);

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
        tier_expires_at: null,
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

  // Two limits with different jobs. The account limit is the one that stops
  // credential stuffing; the IP limit is a loose backstop that will not lock
  // out everyone sharing a connection.
  const byAccount = await rateLimit(c.env, 'loginAccount', `email:${email}`);
  if (!byAccount.ok) return tooMany(byAccount);
  const byIp = await rateLimit(c.env, 'loginIp', clientKey(c.req.raw));
  if (!byIp.ok) return tooMany(byIp);

  const row = await c.env.DB.prepare(
    `SELECT id, email, full_name, role, tier, tier_expires_at, country_iso3,
            password_hash, password_salt
       FROM users WHERE email = ?`,
  )
    .bind(email)
    .first<{
      id: string;
      email: string;
      full_name: string;
      role: 'member' | 'admin';
      tier: 'free' | 'premium';
      tier_expires_at: string | null;
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
        tier_expires_at: row.tier_expires_at,
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

/**
 * Close your account and remove your data.
 *
 * Somebody who publishes a phone number and a city has to be able to take them
 * back. There was previously no way to do that at all, which is a problem on
 * its own and a legal one in most of the places this app is aimed at.
 *
 * Requires the current password, because a hijacked session should not be able
 * to destroy the account it borrowed.
 *
 * What goes: the card, subscriptions, feed items, sessions, ratings, and the
 * account itself. Conversations cascade from the users table, so private
 * threads this person was part of go too, including the other party's copy.
 * That is the right call for a two-party thread: keeping half a conversation
 * whose sender no longer exists leaves the remaining person with messages
 * from nobody, which they can neither reply to nor report.
 *
 * What stays: nothing tied to this person. Aggregate counts in the portal
 * fall accordingly rather than being backfilled.
 */
auth.post('/close', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  // Counted per account. This route takes a password and destroys data on a
  // correct one, which makes it a password oracle if nobody is counting.
  const limited = await rateLimit(c.env, 'closeAccount', `close:${user.id}`);
  if (!limited.ok) return tooMany(limited);

  const body = (await c.req.json().catch(() => null)) as { password?: string } | null;
  if (!body?.password) return bad('Confirm your password to close the account');

  const row = await c.env.DB.prepare(
    'SELECT password_hash, password_salt FROM users WHERE id = ?',
  )
    .bind(user.id)
    .first<{ password_hash: string; password_salt: string }>();
  if (!row) return bad('Account not found', 404);

  const ok = await verifyPassword(body.password, row.password_hash, row.password_salt);
  if (!ok) return bad('That password is not right', 403);

  await c.env.DB.batch([
    c.env.DB.prepare('DELETE FROM business_cards WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM subscriptions WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM feed_items WHERE user_id = ?').bind(user.id),
    c.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(user.id),
    // Ratings reference users with ON DELETE CASCADE, so ratings *about* this
    // person would go automatically. Ratings *by* them are removed explicitly
    // here too: an unattributable score nobody can question is worse than no
    // score, since the person rated can no longer see who said it.
    c.env.DB.prepare('DELETE FROM ratings WHERE rater_id = ? OR subject_id = ?').bind(
      user.id,
      user.id,
    ),
    c.env.DB.prepare('DELETE FROM users WHERE id = ?').bind(user.id),
  ]);

  return json({ closed: true }, 200, { 'set-cookie': clearCookie(isSecureRequest(c.req.raw)) });
});

/** Who am I, plus card state, unread messages and unread feed items. */
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

  const feed = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM feed_items WHERE user_id = ? AND read_at IS NULL',
  )
    .bind(user.id)
    .first<{ n: number }>();

  const subs = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ n: number }>();

  return json({
    user,
    entitled: isEntitled(user),
    has_card: Boolean(card),
    card_published: card?.is_published === 1,
    unread: unread?.n ?? 0,
    feed_unread: feed?.n ?? 0,
    subscriptions: subs?.n ?? 0,
  });
});

/**
 * Development-only tier switch.
 *
 * This grants premium to whoever calls it, so it must be opened deliberately
 * rather than by accident. It used to refuse only when STRIPE_SECRET_KEY was
 * present, which asks the wrong question: "is a payment provider configured"
 * is not "is this a development environment". Deploying before wiring up
 * Stripe, which is exactly the state this app is in, left premium free to
 * anybody who found the endpoint.
 *
 * Now it is off unless ALLOW_DEV_TIER_SWITCH is explicitly "true", and still
 * refuses outright once a payment provider exists.
 */
auth.post('/tier', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  if (c.env.STRIPE_SECRET_KEY) {
    return bad('Use /api/premium/billing/checkout, a payment provider is configured', 403);
  }
  if (c.env.ALLOW_DEV_TIER_SWITCH !== 'true') {
    return bad('Tier cannot be changed from the client', 403);
  }

  // Counted per account, not per address. This route hands out entitlement, and
  // a route that hands out entitlement should not be the one route nobody is
  // counting, even behind two other gates.
  const limited = await rateLimit(c.env, 'tierSwitch', `tier:${user.id}`);
  if (!limited.ok) return tooMany(limited);

  const body = (await c.req.json().catch(() => null)) as { tier: 'free' | 'premium' } | null;
  if (!body || !['free', 'premium'].includes(body.tier)) return bad('tier must be free or premium');

  const expires =
    body.tier === 'premium' ? new Date(Date.now() + 30 * 86_400_000).toISOString() : null;
  await c.env.DB.prepare('UPDATE users SET tier = ?, tier_expires_at = ? WHERE id = ?')
    .bind(body.tier, expires, user.id)
    .run();
  return json({ tier: body.tier, tier_expires_at: expires });
});
