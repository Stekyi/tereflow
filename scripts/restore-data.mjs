/**
 * Apply the analysed-data snapshot into a migrated database.
 *
 *   node scripts/restore-data.mjs           local
 *   node scripts/restore-data.mjs --remote  the deployed D1
 *
 * Applies data/snapshot/*.sql in filename order. They are split into parts
 * because `wrangler d1 execute --file` streams the whole file in one request
 * and times out on anything large.
 *
 * Run the migrations and the seeds first:
 *   wrangler d1 migrations apply tereflow --local
 *   wrangler d1 execute tereflow --local --file=./data/seed.sql
 *   wrangler d1 execute tereflow --local --file=./data/playbooks.sql
 */
import { readdirSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const DIR = 'data/snapshot';
const remote = process.argv.includes('--remote');
const scope = remote ? '--remote' : '--local';

if (!existsSync(DIR)) {
  console.error(`No snapshot at ${DIR}. Run: node scripts/export-data.mjs`);
  process.exit(1);
}

const parts = readdirSync(DIR)
  .filter((f) => f.endsWith('.sql'))
  .sort();

if (parts.length === 0) {
  console.error(`No .sql parts in ${DIR}.`);
  process.exit(1);
}

console.log(`Restoring ${parts.length} part(s) ${remote ? 'to REMOTE' : 'locally'}...`);

for (const [i, file] of parts.entries()) {
  process.stdout.write(`  [${i + 1}/${parts.length}] ${file} ... `);
  // shell: true because npx resolves to npx.cmd on Windows, which spawn
  // cannot execute directly.
  const res = spawnSync(
    'npx',
    ['wrangler', 'd1', 'execute', 'tereflow', scope, `--file=./${DIR}/${file}`],
    { encoding: 'utf8', shell: true, windowsHide: true },
  );
  if (res.status !== 0) {
    console.log('FAILED');
    console.error((res.stderr || res.stdout || '').slice(-1500));
    process.exit(1);
  }
  console.log('ok');
}

console.log('Restore complete.');
