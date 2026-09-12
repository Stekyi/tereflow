/**
 * Copy World Bank market context from the local D1 file into portable SQL.
 *
 *   node scripts/export-context-sql.mjs > ctx.sql
 *
 * A stopgap, and labelled as one. scripts/ingest-context.mjs writes straight to
 * the local sqlite file, which works for a machine-scheduled run and cannot
 * reach a deployed Worker. Every other pipeline here publishes over the admin
 * API instead, and that is where the context ingest should end up too.
 *
 * Until then this exists so a deployment is not missing the context panel
 * entirely. It emits a DELETE scoped to source_ref='world-bank' followed by the
 * rows, so re-running corrects figures rather than stacking duplicate years,
 * and anything uploaded by hand is left alone.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const SOURCE = 'world-bank';

const file = readdirSync(ROOT)
  .filter((f) => f.endsWith('.sqlite'))
  .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
  .sort((a, b) => b.size - a.size)[0]?.f;

if (!file) {
  console.error(`No sqlite file under ${ROOT}`);
  process.exit(1);
}

const db = new DatabaseSync(join(ROOT, file), { readOnly: true });

/** Quotes for SQL. Nulls stay null: a missing figure must not become an empty string. */
function sql(value) {
  if (value == null) return 'NULL';
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : 'NULL';
  return `'${String(value).replace(/'/g, "''")}'`;
}

const out = [];

const INDICATOR_COLS = [
  'entity_id',
  'indicator_code',
  'category',
  'year',
  'value',
  'unit',
  'source_name',
  'source_url',
  'confidence',
  'source_ref',
];
const SECTOR_COLS = [
  'entity_id',
  'sector_code',
  'sector_name',
  'year',
  'share_of_gdp',
  'unit',
  'source_name',
  'source_url',
  'source_ref',
];

function dump(table, cols) {
  out.push(`DELETE FROM ${table} WHERE source_ref = ${sql(SOURCE)};`);
  const rows = db
    .prepare(`SELECT ${cols.join(', ')} FROM ${table} WHERE source_ref = ?`)
    .all(SOURCE);
  for (const row of rows) {
    const values = cols.map((c) => sql(row[c])).join(', ');
    out.push(
      `INSERT INTO ${table} (${cols.join(', ')}, ingested_at) VALUES (${values}, datetime('now'));`,
    );
  }
  return rows.length;
}

const indicators = dump('indicator_observations', INDICATOR_COLS);
const sectors = dump('sector_observations', SECTOR_COLS);

db.close();

console.log(out.join('\n'));
console.error(`${indicators} indicator rows, ${sectors} sector rows.`);
