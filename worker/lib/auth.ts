import type { Env } from './db';

/**
 * Admin gate.
 *
 * Phase 1 uses a shared bearer token so the console is usable immediately:
 *   wrangler secret put ADMIN_TOKEN
 *
 * Phase 2 swaps this for the session cookie + users.role = 'admin'. The call
 * sites do not change.
 */
export function isAdmin(req: Request, env: Env): boolean {
  const token = env.ADMIN_TOKEN;
  if (!token) return false;

  const header = req.headers.get('authorization') ?? '';
  if (header.startsWith('Bearer ') && safeEqual(header.slice(7).trim(), token)) return true;

  const cookie = req.headers.get('cookie') ?? '';
  const match = /(?:^|;\s*)ta_admin=([^;]+)/.exec(cookie);
  if (match && safeEqual(decodeURIComponent(match[1]), token)) return true;

  return false;
}

/** Constant-time-ish compare so the token is not guessable byte by byte. */
function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function requireAdmin(req: Request, env: Env): Response | null {
  if (isAdmin(req, env)) return null;
  return new Response(JSON.stringify({ error: 'Admin authorisation required' }), {
    status: 401,
    headers: { 'content-type': 'application/json' },
  });
}
