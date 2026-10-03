import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream, existsSync, readFileSync } from 'node:fs';
import { mkdir, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import type { FactRow } from '../worker/agent/types';

const D1_API_BASE = 'https://api.cloudflare.com/client/v4';
const MAX_IMPORT_BYTES = 5 * 1024 * 1024 * 1024;
const MAX_SQL_STATEMENT_BYTES = 100_000;
const TARGET_STATEMENT_BYTES = 80_000;
const POLL_MS = 5_000;

interface D1Response<T> {
  success: boolean;
  errors?: { code: number; message: string }[];
  messages?: string[];
  result: T;
}

interface ImportInitResult {
  upload_url: string;
  filename: string;
  at_bookmark?: string;
}

interface ImportIngestResult {
  at_bookmark?: string;
  filename?: string;
}

interface ImportPollResult {
  status?: 'complete' | 'error';
  at_bookmark?: string;
  error?: string;
  messages?: string[];
  result?: {
    final_bookmark?: string;
    num_queries?: number;
    meta?: {
      changed_db?: boolean;
      changes?: number;
      duration?: number;
      rows_read?: number;
      rows_written?: number;
      size_after?: number;
      timings?: { sql_duration_ms?: number };
    };
  };
}

interface QueryResult<T = Record<string, unknown>> {
  results?: T[];
  meta?: {
    duration?: number;
    rows_read?: number;
    rows_written?: number;
    timings?: { sql_duration_ms?: number };
  };
}

export interface BulkImportConfig {
  accountId: string;
  databaseId: string;
  apiToken: string;
  tempDir?: string;
}

export interface BulkImportStats {
  filename: string;
  bytes: number;
  statements: number;
  rows: number;
  etag: string;
  bookmark: string | null;
  durationMs: number | null;
  sqlDurationMs: number | null;
  rowsWritten: number | null;
  sizeAfter: number | null;
  numQueries: number | null;
}

export interface ExpectedTradeSummary {
  rows: number;
  valueUsd: number;
}

function sqlString(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

function sqlValue(value: unknown): string {
  if (value === null || value === undefined) return 'NULL';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error(`Non-finite numeric value: ${value}`);
    return String(value);
  }
  if (typeof value === 'boolean') return value ? '1' : '0';
  return sqlString(String(value));
}

function readWranglerConfig(): { accountId: string; databaseId: string } {
  const path = join(process.cwd(), 'wrangler.toml');
  if (!existsSync(path)) throw new Error(`wrangler.toml not found at ${path}`);
  const text = readFileSync(path, 'utf8');
  const accountId = text.match(/^account_id\s*=\s*["']([^"']+)["']/m)?.[1];
  const databaseId = text.match(/^database_id\s*=\s*["']([^"']+)["']/m)?.[1];
  if (!accountId || !databaseId) {
    throw new Error('wrangler.toml must contain account_id and database_id for D1 bulk import.');
  }
  return { accountId, databaseId };
}

export function readBulkImportConfig(): BulkImportConfig {
  const fromWrangler = readWranglerConfig();
  const apiToken = process.env.CLOUDFLARE_API_TOKEN ?? process.env.TEREFLOW_D1_API_TOKEN ?? '';
  if (!apiToken) {
    throw new Error(
      'CLOUDFLARE_API_TOKEN is not set. Create a Cloudflare API token with D1 Edit permission and put it in local/.env.',
    );
  }
  return {
    accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? fromWrangler.accountId,
    databaseId: process.env.TEREFLOW_D1_DATABASE_ID ?? fromWrangler.databaseId,
    apiToken,
    tempDir: process.env.TEREFLOW_D1_IMPORT_DIR ?? join(process.cwd(), 'local', '.d1-import'),
  };
}

async function d1Fetch<T>(config: BulkImportConfig, path: string, init: RequestInit): Promise<T> {
  const response = await fetch(`${D1_API_BASE}/accounts/${config.accountId}/d1/database/${config.databaseId}${path}`, {
    ...init,
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${config.apiToken}`,
      ...(init.body ? { 'content-type': 'application/json' } : {}),
      ...(init.headers ?? {}),
    },
  });
  const text = await response.text();
  let payload: D1Response<T> | null = null;
  try {
    payload = text ? JSON.parse(text) as D1Response<T> : null;
  } catch {
    throw new Error(`Cloudflare D1 API returned non-JSON HTTP ${response.status}: ${text.slice(0, 500)}`);
  }
  if (!response.ok || !payload?.success) {
    const detail = payload?.errors?.map((e) => `${e.code}: ${e.message}`).join('; ') || text.slice(0, 500);
    throw new Error(`Cloudflare D1 API ${path} -> HTTP ${response.status}: ${detail}`);
  }
  return payload.result;
}

function insertPrefix(): string {
  return `INSERT INTO trade_facts (entity_id, year, flow, stream, partner_iso3, partner_name, hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref) VALUES `;
}

function factTuple(entityId: string, fact: FactRow): string {
  return `(${[
    entityId,
    fact.year,
    fact.flow,
    fact.stream,
    fact.partner_iso3,
    fact.partner_name,
    fact.hs_code,
    fact.product_name,
    fact.sector,
    fact.value_usd,
    fact.qty ?? null,
    fact.qty_unit ?? null,
    fact.source_ref,
  ].map(sqlValue).join(',')})`;
}

function deleteStatement(entityId: string, years: number[]): string {
  if (years.length === 0) throw new Error('At least one changed year is required for bulk replacement.');
  return `DELETE FROM trade_facts WHERE entity_id = ${sqlString(entityId)} AND year IN (${years.join(',')});\n`;
}

/**
 * Validate the changed-year dataset locally before touching remote D1.
 *
 * This deliberately mirrors the invariants that matter to the published
 * partner-level trade_facts table. It does not contact Cloudflare.
 */
export function validateFactsForBulkImport(
  entityId: string,
  years: number[],
  facts: FactRow[],
): void {
  if (!entityId) throw new Error('Bulk import validation failed: entity id is empty.');
  if (years.length === 0) throw new Error('Bulk import validation failed: no changed years.');

  const allowedYears = new Set(years);
  const seenKeys = new Set<string>();
  const yearCounts = new Map<number, number>();
  let totalValue = 0;

  for (const fact of facts) {
    if (!allowedYears.has(fact.year)) throw new Error(`Bulk import validation failed: fact year ${fact.year} is not in changed years.`);
    if (!Number.isInteger(fact.year)) throw new Error(`Bulk import validation failed: invalid fact year ${fact.year}.`);
    if (fact.flow !== 'export' && fact.flow !== 'import') throw new Error(`Bulk import validation failed: invalid flow ${String(fact.flow)}.`);
    if (fact.stream !== 'goods' && fact.stream !== 'services') throw new Error(`Bulk import validation failed: invalid stream ${String(fact.stream)}.`);
    if (!Number.isFinite(fact.value_usd)) throw new Error(`Bulk import validation failed: invalid value_usd for ${fact.year}.`);
    if (fact.qty != null && !Number.isFinite(fact.qty)) throw new Error(`Bulk import validation failed: invalid qty for ${fact.year}.`);
    if (fact.partner_iso3 != null && !/^[A-Z]{3}$/.test(fact.partner_iso3)) {
      throw new Error(`Bulk import validation failed: invalid partner ISO3 ${fact.partner_iso3}.`);
    }
    if (fact.hs_code != null && !/^\d{2}(?:\d{2}){0,4}$/.test(fact.hs_code)) {
      throw new Error(`Bulk import validation failed: invalid HS code ${fact.hs_code}.`);
    }
    if (fact.partner_iso3 === 'WLD') {
      throw new Error(`Bulk import validation failed: WLD aggregate row found for ${fact.year} ${fact.flow}.`);
    }

    if (fact.partner_iso3 && fact.hs_code) {
      const key = `${fact.year}|${fact.flow}|${fact.partner_iso3}|${fact.hs_code}`;
      if (seenKeys.has(key)) {
        throw new Error(`Bulk import validation failed: duplicate partner-product key ${key}.`);
      }
      seenKeys.add(key);
    }

    yearCounts.set(fact.year, (yearCounts.get(fact.year) ?? 0) + 1);
    totalValue += fact.value_usd;
  }

  for (const year of years) {
    if ((yearCounts.get(year) ?? 0) === 0) {
      throw new Error(`Bulk import validation failed: no facts for changed year ${year}.`);
    }
  }

  if (!Number.isFinite(totalValue)) {
    throw new Error('Bulk import validation failed: total trade value is non-finite.');
  }
}

/**
 * Generate D1-compatible SQL without BEGIN/COMMIT. Cloudflare documents a
 * 100KB maximum SQL statement and recommends splitting large INSERTs.
 * We target 80KB to leave safety margin for encoding differences.
 */
async function writeSqlFile(
  config: BulkImportConfig,
  entityId: string,
  years: number[],
  facts: FactRow[],
): Promise<{ path: string; bytes: number; statements: number; rows: number }> {
  await mkdir(config.tempDir!, { recursive: true });
  const filename = `trade-${entityId}-${years.join('-')}-${Date.now()}.sql`;
  const path = join(config.tempDir!, filename);
  const out = createWriteStream(path, { encoding: 'utf8' });

  let bytes = 0;
  let statements = 0;
  let rows = 0;

  const write = async (chunk: string) => {
    const data = Buffer.from(chunk, 'utf8');
    bytes += data.byteLength;
    if (bytes > MAX_IMPORT_BYTES) {
      throw new Error(`D1 import file exceeds the 5 GiB limit: ${bytes} bytes`);
    }
    if (!out.write(data)) await new Promise<void>((resolve) => out.once('drain', resolve));
  };

  try {
    await write(deleteStatement(entityId, years));
    statements++;

    let statement = insertPrefix();
    let statementRows = 0;

    for (const fact of facts) {
      const tuple = factTuple(entityId, fact);
      const candidate = statementRows === 0 ? `${statement}${tuple}` : `${statement},${tuple}`;
      const candidateBytes = Buffer.byteLength(candidate, 'utf8');

      if (statementRows > 0 && candidateBytes > TARGET_STATEMENT_BYTES) {
        if (Buffer.byteLength(statement, 'utf8') >= MAX_SQL_STATEMENT_BYTES) {
          throw new Error('Generated INSERT statement exceeded D1 100KB limit.');
        }
        await write(`${statement};\n`);
        statements++;
        statement = insertPrefix() + tuple;
        statementRows = 1;
      } else {
        statement = candidate;
        statementRows++;
      }
      rows++;
    }

    if (statementRows > 0) {
      if (Buffer.byteLength(statement, 'utf8') >= MAX_SQL_STATEMENT_BYTES) {
        throw new Error('Generated final INSERT statement exceeded D1 100KB limit.');
      }
      await write(`${statement};\n`);
      statements++;
    }
  } finally {
    out.end();
    await new Promise<void>((resolve) => out.once('close', resolve));
  }

  return { path, bytes, statements, rows };
}

async function md5File(path: string): Promise<string> {
  const hash = createHash('md5');
  await new Promise<void>((resolve, reject) => {
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', resolve);
    stream.on('error', reject);
  });
  return hash.digest('hex');
}

async function uploadFile(url: string, path: string, expectedEtag: string): Promise<void> {
  const response = await fetch(url, {
    method: 'PUT',
    body: createReadStream(path) as never,
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  if (!response.ok) throw new Error(`D1 R2 upload failed: HTTP ${response.status} ${await response.text()}`);
  const etag = response.headers.get('etag')?.replaceAll('"', '');
  if (!etag || etag.toLowerCase() !== expectedEtag.toLowerCase()) {
    throw new Error(`D1 R2 upload ETag mismatch: expected ${expectedEtag}, received ${etag ?? 'missing'}`);
  }
}

async function pollImport(config: BulkImportConfig, bookmark: string): Promise<ImportPollResult> {
  let current = bookmark;
  for (;;) {
    const result = await d1Fetch<ImportPollResult>(config, '/import', {
      method: 'POST',
      body: JSON.stringify({ action: 'poll', current_bookmark: current }),
    });
    if (result.status === 'complete') return result;
    if (result.status === 'error') throw new Error(`D1 bulk import failed: ${result.error ?? 'unknown import error'}`);
    if (result.at_bookmark) current = result.at_bookmark;
    for (const message of result.messages ?? []) console.log(`  D1: ${message}`);
    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }
}

export async function bulkReplaceTradeFacts(
  config: BulkImportConfig,
  entityId: string,
  years: number[],
  facts: FactRow[],
): Promise<BulkImportStats> {
  const started = Date.now();
  console.log(`  D1 bulk: local validation for ${facts.length.toLocaleString()} changed-year rows`);
  validateFactsForBulkImport(entityId, years, facts);
  const generated = await writeSqlFile(config, entityId, years, facts);
  const etag = await md5File(generated.path);

  console.log(`  D1 bulk: SQL generated locally — ${(generated.bytes / 1024 / 1024).toFixed(1)} MiB, ${generated.rows.toLocaleString()} rows, ${generated.statements.toLocaleString()} statements`);
  console.log(`  D1 bulk: initializing import (${etag})`);

  try {
    const init = await d1Fetch<ImportInitResult>(config, '/import', {
      method: 'POST',
      body: JSON.stringify({ action: 'init', etag }),
    });

    await uploadFile(init.upload_url, generated.path, etag);
    console.log(`  D1 bulk: SQL uploaded to Cloudflare's temporary R2 import endpoint as ${init.filename}`);

    const ingest = await d1Fetch<ImportIngestResult>(config, '/import', {
      method: 'POST',
      body: JSON.stringify({ action: 'ingest', etag, filename: init.filename }),
    });

    if (!ingest.at_bookmark) throw new Error('D1 bulk import did not return an import bookmark.');
    const complete = await pollImport(config, ingest.at_bookmark);
    const meta = complete.result?.meta;
    console.log(
      `  D1 bulk: complete in ${((Date.now() - started) / 1000).toFixed(1)}s` +
      ` | SQL ${meta?.timings?.sql_duration_ms ?? meta?.duration ?? 'n/a'}ms` +
      ` | wrote ${meta?.rows_written ?? 'n/a'} rows` +
      ` | DB ${(meta?.size_after ?? 0) > 0 ? `${((meta!.size_after! / 1024 / 1024)).toFixed(1)} MiB` : 'n/a'}`,
    );

    return {
      filename: init.filename,
      bytes: generated.bytes,
      statements: generated.statements,
      rows: generated.rows,
      etag,
      bookmark: complete.result?.final_bookmark ?? complete.at_bookmark ?? null,
      durationMs: meta?.duration ?? null,
      sqlDurationMs: meta?.timings?.sql_duration_ms ?? null,
      rowsWritten: meta?.rows_written ?? null,
      sizeAfter: meta?.size_after ?? null,
      numQueries: complete.result?.num_queries ?? null,
    };
  } finally {
    try { await unlink(generated.path); } catch { /* best effort */ }
  }
}

export async function queryD1<T extends Record<string, unknown>>(
  config: BulkImportConfig,
  sql: string,
  params: unknown[] = [],
): Promise<QueryResult<T>> {
  return d1Fetch<QueryResult<T>>(config, '/query', {
    method: 'POST',
    body: JSON.stringify({ sql, params: params.map((value) => value == null ? null : String(value)) }),
  });
}

export async function validatePublishedTradeFacts(
  config: BulkImportConfig,
  entityId: string,
  years: number[],
  expectedByYearFlow: Map<string, ExpectedTradeSummary>,
): Promise<void> {
  const placeholders = years.map(() => '?').join(',');
  const rows = await queryD1<{
    year: number;
    flow: string;
    rows: number;
    value_usd: number | null;
  }>(
    config,
    `SELECT year, flow, COUNT(*) AS rows, COALESCE(SUM(value_usd), 0) AS value_usd
       FROM trade_facts
      WHERE entity_id = ? AND year IN (${placeholders})
      GROUP BY year, flow
      ORDER BY year, flow`,
    [entityId, ...years],
  );

  const actual = new Map((rows.results ?? []).map((row) => [
    `${row.year}|${row.flow}`,
    { rows: Number(row.rows), valueUsd: Number(row.value_usd ?? 0) },
  ]));

  for (const year of years) {
    for (const flow of ['export', 'import'] as const) {
      const key = `${year}|${flow}`;
      const expected = expectedByYearFlow.get(key) ?? { rows: 0, valueUsd: 0 };
      const got = actual.get(key) ?? { rows: 0, valueUsd: 0 };
      const tolerance = Math.max(0.01, Math.abs(expected.valueUsd) * 1e-9);
      if (expected.rows !== got.rows || Math.abs(expected.valueUsd - got.valueUsd) > tolerance) {
        throw new Error(
          `D1 validation failed for ${year} ${flow}: expected ${expected.rows} rows / $${expected.valueUsd}, ` +
          `got ${got.rows} rows / $${got.valueUsd}`,
        );
      }
    }
  }


  const worldRows = await queryD1<{ n: number }>(
    config,
    `SELECT COUNT(*) AS n FROM trade_facts
      WHERE entity_id = ? AND year IN (${placeholders}) AND partner_iso3 = 'WLD'`,
    [entityId, ...years],
  );
  if (Number(worldRows.results?.[0]?.n ?? 0) !== 0) {
    throw new Error(`D1 validation failed: ${worldRows.results?.[0]?.n} WLD partner rows found in partner dataset.`);
  }
}

export function expectedTradeSummary(facts: FactRow[], years: number[]): Map<string, ExpectedTradeSummary> {
  const allowed = new Set(years);
  const out = new Map<string, ExpectedTradeSummary>();
  for (const fact of facts) {
    if (!allowed.has(fact.year)) continue;
    const key = `${fact.year}|${fact.flow}`;
    const current = out.get(key) ?? { rows: 0, valueUsd: 0 };
    current.rows += 1;
    current.valueUsd += fact.value_usd;
    out.set(key, current);
  }
  return out;
}
