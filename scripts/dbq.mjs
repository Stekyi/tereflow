/**
 * Read-only query helper against the local D1 sqlite file.
 *
 * wrangler's --json output is pretty-printed and not strictly parseable, and
 * shelling out per query is slow enough to discourage asking the follow-up
 * question that actually finds the bug. This opens the file directly, read
 * only, so an audit can ask many questions cheaply.
 *
 *   node scripts/dbq.mjs "SELECT ..."
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';

export function openDb() {
  const files = readdirSync(ROOT)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!files.length) throw new Error(`No sqlite file under ${ROOT}`);
  return new DatabaseSync(join(ROOT, files[0].f), { readOnly: true });
}

export function q(db, sql, ...params) {
  return db.prepare(sql).all(...params);
}

if (process.argv[2]) {
  const db = openDb();
  const rows = q(db, process.argv[2]);
  console.log(JSON.stringify(rows, null, 2));
  db.close();
}
