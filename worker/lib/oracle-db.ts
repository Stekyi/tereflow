import { RENAMED_BACK, toOracle } from '../../shared/sql-oracle';
import { APP_TABLES } from '../../shared/app-tables';
import type { Env } from './db';

/**
 * The application's data layer on Oracle.
 *
 * `OracleDB` has the same shape as the part of D1 the app uses (prepare, bind, first, all, run, batch) but sends each
 * statement, translated to Oracle's dialect, to the ORDS gateway at /app/sql. `HybridDB` sits in front of it as `env.DB`:
 * statements on application tables go to Oracle, statements on the old trade and analysis tables that have not been retired
 * yet go to D1 (read only in practice). A statement or batch that mixes the two is refused, so it is rewritten rather than
 * run half in each place.
 *
 * Empty strings: Oracle stores '' as NULL, so '' crosses the gateway as the one-character sentinel U+0001 and is turned
 * back into '' on the way out. Literal '' in SQL becomes CHR(1) in the translator.
 */
const EMPTY = '\u0001';
const APP_SET: ReadonlySet<string> = new Set(APP_TABLES);

export interface AppDbConfig {
  base: string;
  clientId: string;
  clientSecret: string;
  kv: KVNamespace;
  prefix: string;
}

export function appDbConfig(env: Env): AppDbConfig | null {
  if (env.APP_DB !== 'oracle') return null;
  if (!env.ORACLE_ORDS_URL || !env.ORACLE_APP_CLIENT_ID || !env.ORACLE_APP_CLIENT_SECRET) return null;
  return {
    base: env.ORACLE_ORDS_URL.replace(/\/$/, ''),
    clientId: env.ORACLE_APP_CLIENT_ID,
    clientSecret: env.ORACLE_APP_CLIENT_SECRET,
    kv: env.CACHE,
    prefix: env.APP_TABLE_PREFIX || 'app_',
  };
}

const TOKEN_KEY = 'oracle:app-token';
let memoryToken: { value: string; expires: number } | null = null;

async function appToken(cfg: AppDbConfig, force = false): Promise<string> {
  const now = Date.now();
  if (!force && memoryToken && memoryToken.expires > now) return memoryToken.value;
  if (!force) {
    const cached = await cfg.kv.get(TOKEN_KEY + cfg.prefix).catch(() => null);
    if (cached) {
      memoryToken = { value: cached, expires: now + 60_000 };
      return cached;
    }
  }
  const res = await fetch(`${cfg.base}/oauth/token`, {
    method: 'POST',
    headers: { authorization: `Basic ${btoa(`${cfg.clientId}:${cfg.clientSecret}`)}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=client_credentials',
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`oracle app token ${res.status}`);
  const body = (await res.json()) as { access_token: string; expires_in?: number };
  const ttl = Math.max(120, (body.expires_in ?? 3600) - 300);
  memoryToken = { value: body.access_token, expires: now + ttl * 1000 };
  await cfg.kv.put(TOKEN_KEY + cfg.prefix, body.access_token, { expirationTtl: ttl }).catch(() => undefined);
  return body.access_token;
}

interface GatewayStmt { sql: string; binds: unknown[]; ignore_dup?: boolean }
interface GatewayResult { rows: Array<Record<string, unknown>>; changes: number }

async function gateway(cfg: AppDbConfig, stmts: GatewayStmt[]): Promise<GatewayResult[]> {
  const send = async (force: boolean) => fetch(`${cfg.base}/app/sql`, {
    method: 'POST',
    headers: { authorization: `Bearer ${await appToken(cfg, force)}`, 'content-type': 'application/json' },
    body: JSON.stringify({ stmts }),
    signal: AbortSignal.timeout(20_000),
  });
  let res = await send(false);
  if (res.status === 401) {
    memoryToken = null;
    await cfg.kv.delete(TOKEN_KEY + cfg.prefix).catch(() => undefined);
    res = await send(true);
  }
  const text = await res.text();
  let body: { results?: GatewayResult[]; error?: string } = {};
  try { body = JSON.parse(text); } catch { /* handled below */ }
  if (!res.ok || !body.results) throw new Error(`oracle app db: ${body.error ?? `HTTP ${res.status}`}`);
  return body.results;
}

const outValue = (v: unknown) => (v === EMPTY ? '' : v);
function mapRow<T>(row: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[RENAMED_BACK[k] ?? k] = outValue(v);
  return out as T;
}

export class OracleStatement {
  constructor(readonly db: OracleDB, readonly sql: string, readonly values: unknown[] = []) {}
  bind(...values: unknown[]): OracleStatement { return new OracleStatement(this.db, this.sql, values); }
  toGateway(): GatewayStmt {
    const t = toOracle(this.sql, this.values, APP_SET, this.db.cfg.prefix);
    return { sql: t.sql, binds: t.binds.map((v) => (v === '' ? EMPTY : v)), ignore_dup: t.ignoreDup || undefined };
  }
  async all<T = Record<string, unknown>>(): Promise<{ results: T[]; success: true; meta: { changes: number } }> {
    const [r] = await gateway(this.db.cfg, [this.toGateway()]);
    return { results: r.rows.map((row) => mapRow<T>(row)), success: true, meta: { changes: r.changes } };
  }
  async first<T = Record<string, unknown>>(column?: string): Promise<T | null> {
    const { results } = await this.all<Record<string, unknown>>();
    const row = results[0];
    if (!row) return null;
    return (column ? row[column] : row) as T;
  }
  async run(): Promise<{ success: true; meta: { changes: number; last_row_id: number } }> {
    const [r] = await gateway(this.db.cfg, [this.toGateway()]);
    return { success: true, meta: { changes: r.changes, last_row_id: 0 } };
  }
}

export class OracleDB {
  constructor(readonly cfg: AppDbConfig) {}
  prepare(sql: string): OracleStatement { return new OracleStatement(this, sql); }
  /** One call, one transaction: every statement or none. */
  async batch<T = unknown>(stmts: OracleStatement[]): Promise<Array<{ results: T[]; success: true; meta: { changes: number } }>> {
    if (!stmts.length) return [];
    const rs = await gateway(this.cfg, stmts.map((s) => s.toGateway()));
    return rs.map((r) => ({ results: r.rows.map((row) => mapRow<T>(row)), success: true as const, meta: { changes: r.changes } }));
  }
}

// --- the router ---------------------------------------------------------------------------------------------------------

type Backend = 'oracle' | 'd1';

function tablesIn(sql: string): string[] {
  const names = [...sql.matchAll(/\b(?:FROM|JOIN|INTO|UPDATE|MERGE\s+INTO)\s+([a-z_][a-z0-9_]*)/gi)].map((m) => m[1].toLowerCase());
  return [...new Set(names.filter((n) => !['dual', 'select', 'set', 'values', 'only'].includes(n)))];
}

function backendFor(sql: string): Backend {
  const tables = tablesIn(sql);
  const app = tables.filter((t) => APP_SET.has(t));
  const other = tables.filter((t) => !APP_SET.has(t));
  if (app.length && other.length) throw new Error(`one statement mixes application tables (${app.join(', ')}) and legacy tables (${other.join(', ')}); rewrite it`);
  return app.length ? 'oracle' : 'd1';
}

class HybridStatement {
  constructor(readonly backend: Backend, readonly inner: OracleStatement | D1PreparedStatement) {}
  bind(...values: unknown[]): HybridStatement {
    return new HybridStatement(this.backend, (this.inner as OracleStatement).bind(...values) as OracleStatement | D1PreparedStatement);
  }
  first<T = unknown>(column?: string): Promise<T | null> {
    return (column === undefined ? (this.inner as D1PreparedStatement).first<T>() : (this.inner as D1PreparedStatement).first<T>(column)) as Promise<T | null>;
  }
  all<T = unknown>() { return (this.inner as D1PreparedStatement).all<T>(); }
  run() { return (this.inner as D1PreparedStatement).run(); }
}

export class HybridDB {
  constructor(private readonly oracle: OracleDB, private readonly d1: D1Database) {}
  prepare(sql: string): HybridStatement {
    const backend = backendFor(sql);
    return new HybridStatement(backend, backend === 'oracle' ? this.oracle.prepare(sql) : this.d1.prepare(sql));
  }
  async batch<T = unknown>(stmts: HybridStatement[]) {
    if (!stmts.length) return [];
    const backends = new Set(stmts.map((s) => s.backend));
    if (backends.size > 1) throw new Error('a batch mixes application and legacy tables; split it');
    if (stmts[0].backend === 'oracle') return this.oracle.batch<T>(stmts.map((s) => s.inner as OracleStatement));
    return this.d1.batch<T>(stmts.map((s) => s.inner as D1PreparedStatement));
  }
  exec(sql: string) { return this.d1.exec(sql); }
}

/** `env` with DB replaced by the router when the app is switched to Oracle (APP_DB=oracle). Otherwise unchanged. */
export function withAppDb(env: Env): Env {
  const cfg = appDbConfig(env);
  if (!cfg) return env;
  return { ...env, DB: new HybridDB(new OracleDB(cfg), env.DB) as unknown as D1Database };
}
