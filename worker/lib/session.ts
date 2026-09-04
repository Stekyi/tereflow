import type { Env } from './db';
import { uid } from './db';

const SESSION_COOKIE = 'ta_session';
const SESSION_DAYS = 30;
const PBKDF2_ITERATIONS = 100_000;

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  role: 'member' | 'admin';
  tier: 'free' | 'premium';
  tier_expires_at: string | null;
  country_iso3: string | null;
}

/**
 * Entitlement is the tier AND an unexpired period. Reading `tier` alone would
 * keep someone premium forever after a cancelled subscription lapses.
 */
export function isEntitled(user: SessionUser | null): boolean {
  if (!user || user.tier !== 'premium') return false;
  if (!user.tier_expires_at) return true; // no expiry set = comped or lifetime
  return new Date(user.tier_expires_at).getTime() > Date.now();
}

// --- password hashing -------------------------------------------------------

/**
 * PBKDF2-SHA256 via WebCrypto. Workers have no native bcrypt/argon2, and
 * 100k iterations is the standard recommendation for PBKDF2-SHA256.
 */
export async function hashPassword(
  password: string,
  saltHex?: string,
): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ? hexToBytes(saltHex) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PBKDF2_ITERATIONS, hash: 'SHA-256' },
    key,
    256,
  );
  return { hash: bytesToHex(new Uint8Array(bits)), salt: bytesToHex(salt) };
}

export async function verifyPassword(
  password: string,
  storedHash: string,
  storedSalt: string,
): Promise<boolean> {
  const { hash } = await hashPassword(password, storedSalt);
  return timingSafeEqual(hash, storedHash);
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

function bytesToHex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

function hexToBytes(hex: string): Uint8Array {
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

// --- sessions ---------------------------------------------------------------

export async function createSession(env: Env, userId: string): Promise<string> {
  const id = uid('ses_') + crypto.randomUUID().replace(/-/g, '');
  const expires = new Date(Date.now() + SESSION_DAYS * 86_400_000).toISOString();
  await env.DB.prepare('INSERT INTO sessions (id, user_id, expires_at) VALUES (?, ?, ?)')
    .bind(id, userId, expires)
    .run();
  return id;
}

export function sessionCookie(id: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return [
    `${SESSION_COOKIE}=${id}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    `Max-Age=${maxAgeSeconds}`,
  ].join('; ');
}

export function clearCookie(secure: boolean): string {
  return [
    `${SESSION_COOKIE}=`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    ...(secure ? ['Secure'] : []),
    'Max-Age=0',
  ].join('; ');
}

/** Secure cookies are dropped over plain http, which breaks local dev. */
export function isSecureRequest(req: Request): boolean {
  return new URL(req.url).protocol === 'https:';
}

function readCookie(req: Request): string | null {
  const raw = req.headers.get('cookie') ?? '';
  const m = new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`).exec(raw);
  return m ? decodeURIComponent(m[1]) : null;
}

/** Resolve the signed-in user, or null. Expired sessions are cleaned up. */
export async function currentUser(req: Request, env: Env): Promise<SessionUser | null> {
  const sid = readCookie(req);
  if (!sid) return null;

  const row = await env.DB.prepare(
    `SELECT u.id, u.email, u.full_name, u.role, u.tier, u.tier_expires_at,
            u.country_iso3, s.expires_at
       FROM sessions s
       JOIN users u ON u.id = s.user_id
      WHERE s.id = ?`,
  )
    .bind(sid)
    .first<SessionUser & { expires_at: string }>();

  if (!row) return null;
  if (new Date(row.expires_at).getTime() < Date.now()) {
    await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
    return null;
  }

  return {
    id: row.id,
    email: row.email,
    full_name: row.full_name,
    role: row.role,
    tier: row.tier,
    tier_expires_at: row.tier_expires_at,
    country_iso3: row.country_iso3,
  };
}

export async function destroySession(req: Request, env: Env): Promise<void> {
  const sid = readCookie(req);
  if (sid) await env.DB.prepare('DELETE FROM sessions WHERE id = ?').bind(sid).run();
}

// --- validation -------------------------------------------------------------

export function validEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email.trim());
}

/**
 * Deliberately gentle. The brief asked for simple registration, so this rejects
 * only what is genuinely unsafe rather than demanding symbols and mixed case.
 */
export function passwordProblem(password: string): string | null {
  if (password.length < 8) return 'Password must be at least 8 characters';
  if (password.length > 200) return 'Password is too long';
  if (/^\d+$/.test(password)) return 'Password cannot be only numbers';
  const weak = ['password', '12345678', 'qwertyui', 'letmein1', 'iloveyou'];
  if (weak.includes(password.toLowerCase())) return 'That password is too common';
  return null;
}
