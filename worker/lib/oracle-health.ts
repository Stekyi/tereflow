import type { Env } from './db';
import { oracleConfig, oracleFetch } from './oracle';

/**
 * Keeps Oracle awake and says whether it is answering, so ORDS can be the primary source for trade data with D1 behind
 * it. Autonomous Database stops a database that has seen no activity for a while; a light read every few minutes is
 * activity, and it also keeps the ORDS login token and the first connection warm.
 */
const HEALTH_KEY = 'oracle:health';

export interface OracleHealth {
  ok: boolean;
  checked_at: string;
  ms: number | null;
  error: string | null;
  /** Consecutive failed checks, so one blip is not mistaken for an outage. */
  failures: number;
}

/** One cheap ORDS read (a count over a small table). Never throws. */
export async function pingOracle(env: Env): Promise<OracleHealth> {
  const cfg = oracleConfig(env);
  const started = Date.now();
  const previous = await readHealth(env);
  if (!cfg) return { ok: false, checked_at: new Date().toISOString(), ms: null, error: 'Oracle is not configured', failures: (previous?.failures ?? 0) + 1 };
  try {
    const res = await oracleFetch(cfg, { route: 'stats' }, 15_000);
    await res.arrayBuffer();
    if (!res.ok) throw new Error(`ORDS answered ${res.status}`);
    return { ok: true, checked_at: new Date().toISOString(), ms: Date.now() - started, error: null, failures: 0 };
  } catch (e) {
    return {
      ok: false,
      checked_at: new Date().toISOString(),
      ms: Date.now() - started,
      error: e instanceof Error ? e.message.slice(0, 200) : 'unknown error',
      failures: (previous?.failures ?? 0) + 1,
    };
  }
}

export async function recordHealth(env: Env, h: OracleHealth): Promise<void> {
  await env.CACHE.put(HEALTH_KEY, JSON.stringify(h), { expirationTtl: 3600 }).catch(() => undefined);
}

export async function readHealth(env: Env): Promise<OracleHealth | null> {
  try {
    const raw = await env.CACHE.get(HEALTH_KEY);
    return raw ? (JSON.parse(raw) as OracleHealth) : null;
  } catch {
    return null;
  }
}

/**
 * A short-lived, per-isolate breaker. After Oracle fails once, requests in the next minute go straight to D1 instead of
 * each waiting out a timeout. It closes on its own, so a recovered Oracle is used again within a minute.
 */
let downUntil = 0;
export const oracleBreakerOpen = () => Date.now() < downUntil;
export const openOracleBreaker = (seconds = 60) => {
  downUntil = Date.now() + seconds * 1000;
};
export const closeOracleBreaker = () => {
  downUntil = 0;
};

/** The same environment with every Oracle setting removed, which makes each route take its D1 path. */
export function withoutOracle(env: Env): Env {
  return {
    ...env,
    ORACLE_ORDS_URL: undefined,
    ORACLE_CLIENT_ID: undefined,
    ORACLE_CLIENT_SECRET: undefined,
    ORACLE_API_URL: undefined,
    ORACLE_API_TOKEN: undefined,
  };
}
