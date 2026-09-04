import type { Env } from './db';

/**
 * KV-backed fixed-window rate limiter.
 *
 * Login, registration and message send are the three endpoints worth
 * protecting: the first two against credential stuffing and account
 * enumeration, the third against spamming the network. A fixed window is
 * coarse but it is one KV read and one write, which matters on Workers.
 */
export interface Limit {
  /** Requests permitted inside the window. */
  max: number;
  /** Window length in seconds. */
  windowSeconds: number;
}

/**
 * Thresholds.
 *
 * These are deliberately not aggressive. A lot of the intended audience sits
 * behind carrier-grade NAT or a shared office connection, where hundreds of
 * legitimate people present the same IP. Locking an IP after a handful of
 * signups would block a whole neighbourhood to stop one script.
 *
 * So: IP limits are loose enough not to catch real users, and the tight limit
 * on login is keyed to the *account* being attacked rather than the source,
 * which is what actually stops credential stuffing.
 */
export const LIMITS = {
  loginAccount: { max: 8, windowSeconds: 900 },
  loginIp: { max: 40, windowSeconds: 900 },
  register: { max: 20, windowSeconds: 3600 },
  message: { max: 40, windowSeconds: 300 },
  checkout: { max: 10, windowSeconds: 3600 },
} satisfies Record<string, Limit>;

export interface LimitResult {
  ok: boolean;
  remaining: number;
  retryAfter: number;
}

/** Prefer the real client IP; Cloudflare sets this and clients cannot forge it. */
export function clientKey(req: Request): string {
  return (
    req.headers.get('cf-connecting-ip') ??
    req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() ??
    'unknown'
  );
}

export async function rateLimit(
  env: Env,
  bucket: keyof typeof LIMITS,
  identity: string,
): Promise<LimitResult> {
  const limit = LIMITS[bucket];
  const window = Math.floor(Date.now() / 1000 / limit.windowSeconds);
  const key = `rl:${bucket}:${identity}:${window}`;

  // KV is eventually consistent, so this is a deterrent rather than a hard
  // guarantee. That is the right trade for auth abuse; it is not a paywall.
  let count = 0;
  try {
    const current = await env.CACHE.get(key);
    count = current ? Number(current) : 0;
  } catch {
    // If KV is unavailable, fail open rather than locking everyone out.
    return { ok: true, remaining: limit.max, retryAfter: 0 };
  }

  if (count >= limit.max) {
    const nextWindow = (window + 1) * limit.windowSeconds;
    return {
      ok: false,
      remaining: 0,
      retryAfter: Math.max(1, nextWindow - Math.floor(Date.now() / 1000)),
    };
  }

  await env.CACHE.put(key, String(count + 1), {
    expirationTtl: limit.windowSeconds + 60,
  }).catch(() => undefined);

  return { ok: true, remaining: limit.max - count - 1, retryAfter: 0 };
}

export function tooMany(result: LimitResult): Response {
  return new Response(
    JSON.stringify({
      error: `Too many attempts. Try again in ${Math.ceil(result.retryAfter / 60)} minute(s).`,
    }),
    {
      status: 429,
      headers: {
        'content-type': 'application/json',
        'retry-after': String(result.retryAfter),
      },
    },
  );
}
