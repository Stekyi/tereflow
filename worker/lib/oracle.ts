import type { Env } from './db';

/**
 * Read access to the Oracle trade data.
 *
 * Two ways in, chosen by configuration:
 *   ords  Oracle REST Data Services on the Autonomous Database itself. Free, stable
 *         HTTPS address, OAuth2 client credentials. This is the production path.
 *   api   The FastAPI service in oracle/tereflow_oracle/api.py behind a bearer token.
 *         Kept for local development.
 *
 * Both return the same JSON for the same route, so callers do not care which is in use.
 */
export type OracleConfig =
  | { mode: 'ords'; base: string; clientId: string; clientSecret: string; kv: KVNamespace }
  | { mode: 'api'; base: string; token: string };

export function oracleConfig(env: Env): OracleConfig | null {
  if (env.ORACLE_ORDS_URL && env.ORACLE_CLIENT_ID && env.ORACLE_CLIENT_SECRET) {
    return {
      mode: 'ords',
      base: env.ORACLE_ORDS_URL.replace(/\/$/, ''),
      clientId: env.ORACLE_CLIENT_ID,
      clientSecret: env.ORACLE_CLIENT_SECRET,
      kv: env.CACHE,
    };
  }
  if (env.ORACLE_API_URL && env.ORACLE_API_TOKEN) {
    return { mode: 'api', base: env.ORACLE_API_URL.replace(/\/$/, ''), token: env.ORACLE_API_TOKEN };
  }
  return null;
}

export type OracleRoute =
  | { route: 'dashboard'; iso3: string }
  | { route: 'blue-oceans'; iso3: string; limit?: number }
  | { route: 'lines'; iso3: string; flow: 'X' | 'M' }
  | { route: 'products'; iso3: string }
  | { route: 'product'; iso3: string; flow: 'X' | 'M'; code: string }
  | { route: 'stats' }
  | { route: 'sandbox'; primary: string; partners: string[]; exclude?: string[] };

const TOKEN_KEY = 'oracle:ords-token';
let memoryToken: { value: string; expires: number } | null = null;

/** A bearer token for ORDS, cached in memory and in KV so most requests never ask for one. */
async function ordsToken(cfg: Extract<OracleConfig, { mode: 'ords' }>, force = false): Promise<string> {
  const now = Date.now();
  if (!force && memoryToken && memoryToken.expires > now) return memoryToken.value;
  if (!force) {
    const cached = await cfg.kv.get(TOKEN_KEY).catch(() => null);
    if (cached) {
      memoryToken = { value: cached, expires: now + 60_000 };
      return cached;
    }
  }
  const res = await fetch(`${cfg.base}/oauth/token`, {
    method: 'POST',
    headers: {
      authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`,
      'content-type': 'application/x-www-form-urlencoded',
    },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`oracle token ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  const ttl = Math.max(120, (body.expires_in ?? 3600) - 300);
  memoryToken = { value: body.access_token, expires: now + ttl * 1000 };
  await cfg.kv.put(TOKEN_KEY, body.access_token, { expirationTtl: ttl }).catch(() => undefined);
  return body.access_token;
}

function target(cfg: OracleConfig, r: OracleRoute): { url: string; init: RequestInit } {
  const enc = encodeURIComponent;
  if (cfg.mode === 'ords') {
    switch (r.route) {
      case 'dashboard': return { url: `${cfg.base}/tf/dashboard/${enc(r.iso3)}`, init: {} };
      case 'blue-oceans': return { url: `${cfg.base}/tf/blue-oceans/${enc(r.iso3)}`, init: {} };
      case 'lines': return { url: `${cfg.base}/tf/lines/${enc(r.iso3)}?flow=${r.flow}`, init: {} };
      case 'products': return { url: `${cfg.base}/tf/products/${enc(r.iso3)}`, init: {} };
      case 'product': return { url: `${cfg.base}/tf/product/${enc(r.iso3)}/${r.flow}/${enc(r.code)}`, init: {} };
      case 'stats': return { url: `${cfg.base}/tf/stats`, init: {} };
      case 'sandbox': {
        const ex = r.exclude?.length ? `&exclude=${enc(r.exclude.join(','))}` : '';
        return { url: `${cfg.base}/tf/sandbox?primary=${enc(r.primary)}&partners=${enc(r.partners.join(','))}${ex}`, init: {} };
      }
    }
  }
  switch (r.route) {
    case 'dashboard': return { url: `${cfg.base}/api/dashboard/${enc(r.iso3)}`, init: {} };
    case 'blue-oceans': return { url: `${cfg.base}/api/blue-oceans/${enc(r.iso3)}?limit=${r.limit ?? 12}`, init: {} };
    case 'lines': return { url: `${cfg.base}/api/lines/${enc(r.iso3)}?flow=${r.flow}`, init: {} };
    case 'products': return { url: `${cfg.base}/api/products/${enc(r.iso3)}`, init: {} };
    case 'product': return { url: `${cfg.base}/api/product/${enc(r.iso3)}/${r.flow}/${enc(r.code)}`, init: {} };
    case 'stats': return { url: `${cfg.base}/api/stats`, init: {} };
    case 'sandbox':
      return {
        url: `${cfg.base}/api/trade/sandbox`,
        init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primary: r.primary, partners: r.partners }) },
      };
  }
}

/**
 * Fetches one route. The response is returned unread so a large body (the sandbox can be
 * tens of megabytes) can be streamed straight through rather than held in memory.
 */
export async function oracleFetch(cfg: OracleConfig, r: OracleRoute, timeoutMs = 25_000): Promise<Response> {
  const { url, init } = target(cfg, r);
  const send = async (force: boolean) => {
    const auth = cfg.mode === 'ords' ? await ordsToken(cfg, force) : cfg.token;
    return fetch(url, {
      ...init,
      headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${auth}` },
      signal: AbortSignal.timeout(timeoutMs),
    });
  };
  const res = await send(false);
  // A token revoked or rotated since it was cached: fetch a fresh one once.
  if (res.status === 401 && cfg.mode === 'ords') {
    memoryToken = null;
    await cfg.kv.delete(TOKEN_KEY).catch(() => undefined);
    return send(true);
  }
  return res;
}

const jsonCache = new Map<string, { at: number; value: unknown }>();
const JSON_TTL_MS = 120_000;

/**
 * A cached JSON read. The country feeds are precomputed in Oracle and change only after an ingest,
 * so a short in-memory cache spares Oracle repeated round trips when several pages ask in a row.
 * Returns null when Oracle has nothing for the country (404) and throws on a service failure.
 */
export async function oracleJson<T>(cfg: OracleConfig, r: OracleRoute): Promise<T | null> {
  const key = JSON.stringify([cfg.base, r]);
  const hit = jsonCache.get(key);
  if (hit && Date.now() - hit.at < JSON_TTL_MS) return hit.value as T | null;
  const res = await oracleFetch(cfg, r);
  if (res.status === 404) {
    jsonCache.set(key, { at: Date.now(), value: null });
    return null;
  }
  if (!res.ok) throw new Error(`oracle ${res.status}`);
  const value = (await res.json()) as T;
  jsonCache.set(key, { at: Date.now(), value });
  return value;
}
