import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { currentUser, isEntitled } from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';

export const premium = new Hono<{ Bindings: Env }>();

const SUB_KINDS = ['product', 'sector', 'country', 'hs_code'] as const;
type SubKind = (typeof SUB_KINDS)[number];

// --- subscriptions ----------------------------------------------------------

premium.get('/subscriptions', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const { results } = await c.env.DB.prepare(
    'SELECT id, kind, value, label, created_at FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC',
  )
    .bind(user.id)
    .all();
  return json({ subscriptions: results ?? [] });
});

/**
 * Following is free. The analysis that lands in the feed is what is gated, so
 * a free user can build a watchlist and see exactly what they are missing.
 */
premium.post('/subscriptions', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  // Following is cheap for a person and cheap to automate, and each one writes
  // a row that later drives a feed.
  const limited = await rateLimit(c.env, 'subscription', `sub:${user.id}`);
  if (!limited.ok) return tooMany(limited);

  const body = (await c.req.json().catch(() => null)) as {
    kind: SubKind;
    value: string;
    label?: string;
  } | null;
  if (!body || !SUB_KINDS.includes(body.kind)) return bad(`kind must be one of ${SUB_KINDS.join(', ')}`);
  const value = (body.value ?? '').trim();
  if (!value) return bad('value required');

  const count = await c.env.DB.prepare(
    'SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?',
  )
    .bind(user.id)
    .first<{ n: number }>();
  if ((count?.n ?? 0) >= 40) return bad('You can follow at most 40 things', 400);

  await c.env.DB.prepare(
    `INSERT INTO subscriptions (id, user_id, kind, value, label)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT (user_id, kind, value) DO UPDATE SET label = excluded.label`,
  )
    .bind(uid('sub_'), user.id, body.kind, value, body.label?.trim() || value)
    .run();

  return json({ ok: true, kind: body.kind, value }, 201);
});

premium.delete('/subscriptions/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const res = await c.env.DB.prepare('DELETE FROM subscriptions WHERE id = ? AND user_id = ?')
    .bind(c.req.param('id'), user.id)
    .run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ deleted: true });
});

// --- feed -------------------------------------------------------------------

interface FeedRow {
  id: string;
  kind: string;
  title: string;
  body: string | null;
  payload: string | null;
  entity_id: string | null;
  entity_slug: string | null;
  entity_name: string | null;
  premium_only: 0 | 1;
  read_at: string | null;
  created_at: string;
}

premium.get('/feed', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const entitled = isEntitled(user);

  const { results } = await c.env.DB.prepare(
    `SELECT f.id, f.kind, f.title, f.body, f.payload, f.entity_id,
            e.slug AS entity_slug, e.name AS entity_name,
            f.premium_only, f.read_at, f.created_at
       FROM feed_items f
       LEFT JOIN entities e ON e.id = f.entity_id
      WHERE f.user_id = ?
      ORDER BY f.created_at DESC
      LIMIT 60`,
  )
    .bind(user.id)
    .all<FeedRow>();

  // Locked items keep their title so the value is visible, but the analysis
  // body and payload are withheld.
  const items = (results ?? []).map((f) => {
    const locked = f.premium_only === 1 && !entitled;
    return {
      id: f.id,
      kind: f.kind,
      title: f.title,
      body: locked ? null : f.body,
      payload: locked || !f.payload ? null : safeParse(f.payload),
      entity_slug: f.entity_slug,
      entity_name: f.entity_name,
      premium_only: f.premium_only === 1,
      locked,
      read_at: f.read_at,
      created_at: f.created_at,
    };
  });

  const unread = items.filter((i) => !i.read_at).length;
  return json({ items, unread, entitled, locked_count: items.filter((i) => i.locked).length });
});

function safeParse(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

premium.post('/feed/read', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const body = (await c.req.json().catch(() => null)) as { id?: string } | null;

  if (body?.id) {
    await c.env.DB.prepare(
      "UPDATE feed_items SET read_at = datetime('now') WHERE id = ? AND user_id = ?",
    )
      .bind(body.id, user.id)
      .run();
  } else {
    await c.env.DB.prepare(
      "UPDATE feed_items SET read_at = datetime('now') WHERE user_id = ? AND read_at IS NULL",
    )
      .bind(user.id)
      .run();
  }
  return json({ ok: true });
});

// --- playbooks --------------------------------------------------------------

premium.get('/playbooks', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  const entitled = isEntitled(user);
  const sector = c.req.query('sector');
  const country = c.req.query('country');

  const clauses = ['published_at IS NOT NULL'];
  const binds: unknown[] = [];
  if (sector) {
    clauses.push('(sector = ? OR sector IS NULL)');
    binds.push(sector);
  }
  if (country) {
    clauses.push('(country_iso3 = ? OR country_iso3 IS NULL)');
    binds.push(country.toUpperCase());
  }

  const { results } = await c.env.DB.prepare(
    `SELECT id, slug, title, sector, hs_code, country_iso3, summary,
            author_name, premium_only, reading_minutes, published_at
       FROM playbooks
      WHERE ${clauses.join(' AND ')}
      ORDER BY premium_only ASC, title ASC`,
  )
    .bind(...binds)
    .all();

  return json({
    playbooks: (results ?? []).map((p) => ({
      ...p,
      locked: (p as { premium_only: number }).premium_only === 1 && !entitled,
    })),
    entitled,
  });
});

premium.get('/playbooks/:slug', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  const entitled = isEntitled(user);

  const row = await c.env.DB.prepare(
    'SELECT * FROM playbooks WHERE slug = ? AND published_at IS NOT NULL',
  )
    .bind(c.req.param('slug'))
    .first<{
      slug: string;
      title: string;
      summary: string | null;
      body_md: string;
      sources: string | null;
      premium_only: number;
      author_name: string | null;
      author_credential: string | null;
      reading_minutes: number;
      sector: string | null;
      country_iso3: string | null;
    }>();
  if (!row) return bad('Not found', 404);

  const locked = row.premium_only === 1 && !entitled;
  // Free readers get the opening section so they can judge whether the rest is
  // worth paying for, rather than hitting a blank wall.
  const preview = locked ? firstSection(row.body_md) : row.body_md;

  return json({
    playbook: {
      slug: row.slug,
      title: row.title,
      summary: row.summary,
      sector: row.sector,
      country_iso3: row.country_iso3,
      author_name: row.author_name,
      author_credential: row.author_credential,
      reading_minutes: row.reading_minutes,
      body_md: preview,
      sources: row.sources ? safeParse(row.sources) : [],
      premium_only: row.premium_only === 1,
      locked,
    },
    entitled,
  });
});

/** Everything up to the second heading. */
function firstSection(md: string): string {
  const parts = md.split(/\n(?=## )/);
  return parts.length > 1 ? `${parts[0]}\n${parts[1]}` : parts[0];
}

// --- billing ----------------------------------------------------------------

const PLANS = {
  monthly: { label: 'Premium monthly', amount_minor: 1200, currency: 'USD', days: 30 },
  annual: { label: 'Premium annual', amount_minor: 11000, currency: 'USD', days: 365 },
} as const;
type PlanId = keyof typeof PLANS;

premium.get('/billing/plans', (c) =>
  json({
    plans: Object.entries(PLANS).map(([id, p]) => ({ id, ...p })),
    provider: c.env.STRIPE_SECRET_KEY ? 'stripe' : 'stub',
  }),
);

/**
 * Provider-agnostic checkout.
 *
 * With STRIPE_SECRET_KEY set this creates a real Stripe Checkout Session and
 * entitlement only moves when the signed webhook arrives. Without it, the stub
 * provider activates immediately so the whole premium path is testable — that
 * is a development affordance and is refused when STRIPE_SECRET_KEY is present.
 */
premium.post('/billing/checkout', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);

  const limited = await rateLimit(c.env, 'checkout', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);

  const body = (await c.req.json().catch(() => null)) as { plan?: PlanId } | null;
  const planId = (body?.plan ?? 'monthly') as PlanId;
  const plan = PLANS[planId];
  if (!plan) return bad('Unknown plan');

  const origin = new URL(c.req.url).origin;

  if (c.env.STRIPE_SECRET_KEY) {
    const form = new URLSearchParams({
      mode: 'subscription',
      'line_items[0][price_data][currency]': plan.currency.toLowerCase(),
      'line_items[0][price_data][product_data][name]': plan.label,
      'line_items[0][price_data][unit_amount]': String(plan.amount_minor),
      'line_items[0][price_data][recurring][interval]': planId === 'annual' ? 'year' : 'month',
      'line_items[0][quantity]': '1',
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${origin}/me?upgraded=1`,
      cancel_url: `${origin}/me`,
      'metadata[user_id]': user.id,
      'metadata[plan]': planId,
    });

    const res = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: {
        authorization: `Bearer ${c.env.STRIPE_SECRET_KEY}`,
        'content-type': 'application/x-www-form-urlencoded',
      },
      body: form,
    });
    const session = (await res.json()) as { id?: string; url?: string; error?: { message: string } };
    if (!res.ok || !session.url) {
      return bad(session.error?.message ?? 'Could not start checkout', 502);
    }

    await recordBilling(c.env, {
      user_id: user.id,
      provider: 'stripe',
      kind: 'checkout_started',
      plan: planId,
      amount_minor: plan.amount_minor,
      currency: plan.currency,
      provider_ref: session.id ?? null,
    });

    return json({ provider: 'stripe', checkout_url: session.url });
  }

  // Stub provider.
  //
  // This grants premium with no payment, so it is gated on an explicit opt-in
  // rather than on the absence of Stripe. "No payment provider configured" is
  // the normal state of a deploy that has not wired up billing yet, and in
  // that state this branch would hand premium to anybody who asked.
  if (c.env.ALLOW_DEV_TIER_SWITCH !== 'true') {
    return bad(
      'Payments are not available yet. No payment provider is configured on this deployment.',
      503,
    );
  }

  const periodEnd = new Date(Date.now() + plan.days * 86_400_000).toISOString();
  await recordBilling(c.env, {
    user_id: user.id,
    provider: 'stub',
    kind: 'checkout_started',
    plan: planId,
    amount_minor: plan.amount_minor,
    currency: plan.currency,
    provider_ref: uid('stub_'),
  });
  await activate(c.env, user.id, periodEnd, 'stub', planId, plan.amount_minor, plan.currency);

  return json({
    provider: 'stub',
    activated: true,
    period_end: periodEnd,
    note: 'No payment provider configured, so premium was granted directly. Set STRIPE_SECRET_KEY to take real payments.',
  });
});

premium.post('/billing/cancel', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  await c.env.DB.prepare(
    "UPDATE users SET tier = 'free', tier_expires_at = NULL WHERE id = ?",
  )
    .bind(user.id)
    .run();
  await recordBilling(c.env, {
    user_id: user.id,
    provider: c.env.STRIPE_SECRET_KEY ? 'stripe' : 'stub',
    kind: 'cancelled',
  });
  return json({ tier: 'free' });
});

premium.get('/billing/history', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, kind, plan, amount_minor, currency, period_end, created_at
       FROM billing_events WHERE user_id = ? ORDER BY created_at DESC LIMIT 25`,
  )
    .bind(user.id)
    .all();
  return json({
    events: results ?? [],
    tier: user.tier,
    tier_expires_at: user.tier_expires_at,
    entitled: isEntitled(user),
  });
});

/**
 * Stripe webhook. Entitlement is granted here, never from the browser, because
 * the browser can be told anything.
 */
premium.post('/billing/webhook', async (c) => {
  const secret = c.env.STRIPE_WEBHOOK_SECRET;
  const raw = await c.req.text();

  if (!secret) return bad('Webhooks are not configured', 503);
  const signature = c.req.header('stripe-signature') ?? '';
  if (!(await verifyStripeSignature(raw, signature, secret))) {
    return bad('Bad signature', 400);
  }

  const event = safeParse(raw) as {
    id?: string;
    type?: string;
    data?: { object?: Record<string, unknown> };
  } | null;
  if (!event?.type) return bad('Malformed event', 400);

  const obj = event.data?.object ?? {};
  const userId =
    (obj.client_reference_id as string) ??
    ((obj.metadata as Record<string, string> | undefined)?.user_id ?? null);

  switch (event.type) {
    case 'checkout.session.completed':
    case 'invoice.payment_succeeded': {
      if (!userId) break;
      const plan = ((obj.metadata as Record<string, string> | undefined)?.plan ?? 'monthly') as PlanId;
      const days = PLANS[plan]?.days ?? 30;
      const periodEnd = new Date(Date.now() + days * 86_400_000).toISOString();
      await activate(
        c.env,
        userId,
        periodEnd,
        'stripe',
        plan,
        Number(obj.amount_total ?? 0),
        String(obj.currency ?? 'usd').toUpperCase(),
        event.id ?? null,
      );
      break;
    }
    case 'customer.subscription.deleted':
    case 'invoice.payment_failed': {
      if (!userId) break;
      await c.env.DB.prepare("UPDATE users SET tier = 'free' WHERE id = ?").bind(userId).run();
      await recordBilling(c.env, {
        user_id: userId,
        provider: 'stripe',
        kind: event.type.endsWith('failed') ? 'failed' : 'cancelled',
        provider_ref: event.id ?? null,
      });
      break;
    }
  }

  return json({ received: true });
});

async function activate(
  env: Env,
  userId: string,
  periodEnd: string,
  provider: 'stub' | 'stripe',
  plan: string,
  amountMinor: number,
  currency: string,
  providerRef: string | null = null,
) {
  await env.DB.prepare(
    "UPDATE users SET tier = 'premium', tier_expires_at = ? WHERE id = ?",
  )
    .bind(periodEnd, userId)
    .run();
  await recordBilling(env, {
    user_id: userId,
    provider,
    kind: 'activated',
    plan,
    amount_minor: amountMinor,
    currency,
    period_end: periodEnd,
    provider_ref: providerRef,
  });
}

async function recordBilling(
  env: Env,
  e: {
    user_id: string;
    provider: 'stub' | 'stripe';
    kind: string;
    plan?: string;
    amount_minor?: number;
    currency?: string;
    period_end?: string;
    provider_ref?: string | null;
  },
) {
  await env.DB.prepare(
    `INSERT OR IGNORE INTO billing_events
       (id, user_id, provider, kind, plan, amount_minor, currency, period_end, provider_ref)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      uid('bil_'),
      e.user_id,
      e.provider,
      e.kind,
      e.plan ?? null,
      e.amount_minor ?? null,
      e.currency ?? null,
      e.period_end ?? null,
      e.provider_ref ?? null,
    )
    .run();
}

/** Stripe's v1 scheme: HMAC-SHA256 over `${timestamp}.${payload}`. */
async function verifyStripeSignature(
  payload: string,
  header: string,
  secret: string,
): Promise<boolean> {
  const parts = Object.fromEntries(
    header.split(',').map((kv) => {
      const i = kv.indexOf('=');
      return [kv.slice(0, i).trim(), kv.slice(i + 1).trim()];
    }),
  );
  const timestamp = parts['t'];
  const provided = parts['v1'];
  if (!timestamp || !provided) return false;

  // Reject anything older than five minutes so a captured request cannot be
  // replayed later.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp));
  if (!isFinite(age) || age > 300) return false;

  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const mac = await crypto.subtle.sign(
    'HMAC',
    key,
    new TextEncoder().encode(`${timestamp}.${payload}`),
  );
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, '0')).join('');

  if (expected.length !== provided.length) return false;
  let diff = 0;
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ provided.charCodeAt(i);
  return diff === 0;
}
