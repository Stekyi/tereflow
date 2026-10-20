/**
 * Build the ready-made answers for the heaviest anonymous pages and store them in KV.
 *
 *   npm run snapshots
 *
 * Why this exists: the dashboard, product list and opportunities feed take more CPU than the free Workers plan allows
 * once an isolate is cold. Here they are built by running the same Worker code locally, where there is no such limit,
 * against the real Oracle data, and the results are put in KV. The deployed Worker only reads them back
 * (worker/lib/snapshot.ts). Run it after every ingest.
 *
 * What it touches: a throwaway local copy of the NON-PERSONAL D1 tables (users, sessions, messages, cards, ratings,
 * subscriptions, billing and feedback are never exported), then writes `snap:*` keys in the CACHE namespace.
 * Oracle credentials come from .dev.vars, which stays out of git.
 */
import { spawn, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PORT = 8799;
const BASE = `http://127.0.0.1:${PORT}`;
const TTL = 60 * 60 * 24 * 2;
const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';

const TABLES = [
  'analysis_results', 'analysis_runs', 'code_setup', 'country_configs', 'dataset_definitions', 'entities',
  'entity_sources', 'export_classifications', 'indicator_definitions', 'indicator_observations', 'opportunities',
  'opportunity_metrics', 'opportunity_signals', 'playbooks', 'product_analytics', 'sector_definitions',
  'sector_observations', 'source_attempts', 'trade_facts', 'trade_observations',
];

function run(args, label) {
  const r = spawnSync(npx, ['wrangler', ...args], { encoding: 'utf8', shell: process.platform === 'win32' });
  if (r.status !== 0) throw new Error(`${label} failed:\n${(r.stderr || r.stdout || '').slice(-1500)}`);
  return r.stdout;
}

const dir = mkdtempSync(join(tmpdir(), 'tf-snap-'));
const state = join(dir, 'state');
let dev = null;

function stopDev() {
  if (!dev || dev.killed) return;
  if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(dev.pid), '/T', '/F']);
  else dev.kill('SIGTERM');
}

async function waitReady() {
  for (let i = 0; i < 90; i += 1) {
    try {
      const r = await fetch(`${BASE}/api/health`);
      if (r.ok) return;
    } catch {
      // still starting
    }
    await new Promise((res) => setTimeout(res, 1000));
  }
  throw new Error('local Worker did not start');
}

/** Retried because the first requests can race the Oracle login that the Worker makes on its own. */
async function get(path) {
  let last = '';
  for (let attempt = 1; attempt <= 4; attempt += 1) {
    const r = await fetch(BASE + path);
    const text = await r.text();
    if (r.ok) {
      JSON.parse(text);
      return text;
    }
    last = `${path} -> ${r.status}: ${text.slice(0, 200)}`;
    await new Promise((res) => setTimeout(res, 2500));
  }
  throw new Error(last);
}

try {
  console.log('exporting non-personal D1 tables');
  const sql = join(dir, 'd1.sql');
  run(['d1', 'export', 'tereflow', '--remote', '--output', sql, ...TABLES.flatMap((t) => ['--table', t])], 'd1 export');
  console.log('loading them into a local database');
  run(['d1', 'execute', 'tereflow', '--local', '--persist-to', state, '--file', sql, '--yes'], 'local import');

  console.log('starting the Worker locally');
  // App data (entities, settings, classifications) lives in Oracle, so the local Worker has to read it from there like
  // production does. The local D1 copy above only serves the old trade tables.
  const envFile = existsSync('.env') ? readFileSync('.env', 'utf8') : '';
  const fromEnv = (k) => (envFile.match(new RegExp(`^${k}=(.*)$`, 'm'))?.[1] ?? '').trim().replace(/^["']|["']$/g, '');
  const appVars = ['ORACLE_APP_CLIENT_ID', 'ORACLE_APP_CLIENT_SECRET'].flatMap((k) => (fromEnv(k) ? ['--var', `${k}:${fromEnv(k)}`] : []));
  if (appVars.length < 4) throw new Error('ORACLE_APP_CLIENT_ID/SECRET missing from .env; the snapshot would read stale app data from D1');
  dev = spawn(npx, ['wrangler', 'dev', '--local', '--port', String(PORT), '--persist-to', state, '--var', 'APP_DB:oracle', ...appVars], {
    stdio: 'ignore',
    shell: process.platform === 'win32',
  });
  await waitReady();

  const out = {};
  for (const p of ['/api/countries', '/api/opportunities', '/api/products?limit=40']) {
    // The product list is built from every country's full feed (exact=1), not the database search the live Worker uses,
    // so its totals and strong-case counts cover everything and not just a sample.
    out[`snap:${p}`] = await get(p.startsWith('/api/products') ? `${p}&exact=1` : p);
    console.log(`  built ${p} (${out[`snap:${p}`].length} bytes)`);
  }
  const countries = JSON.parse(out['snap:/api/countries']).countries ?? [];
  // Refuse to publish a countries page that has lost its figures. Serving it would replace a working page with an empty one
  // for two days, which is how the country cards went blank. A country with no trade loaded (Sierra Leone) is allowed.
  const active = countries.filter((x) => x.is_active);
  const withFigures = active.filter((x) => x.export_usd != null || x.import_usd != null);
  if (active.length > 0 && withFigures.length < Math.ceil(active.length * 0.7)) {
    throw new Error(`countries snapshot has figures for only ${withFigures.length} of ${active.length} active countries; not publishing`);
  }
  for (const c of countries.filter((x) => x.is_active && x.slug)) {
    const p = `/api/dashboard/${c.slug}`;
    // A dashboard with figures but no product families means the Worker swallowed an Oracle error while building it
    // (it returns null for that part). Rebuild rather than store a half-empty page.
    let body = '';
    for (let attempt = 1; attempt <= 4; attempt += 1) {
      body = await get(p);
      const d = JSON.parse(body);
      const hasFigures = d.overview && (d.overview.export_usd > 0 || d.overview.import_usd > 0);
      if (!hasFigures || d.families_import || d.families_export) break;
      if (attempt === 4) throw new Error(`${p} has figures but no product families after 4 builds`);
      await new Promise((res) => setTimeout(res, 3000));
    }
    if (JSON.parse(body).inactive) continue;
    out[`snap:${p}`] = body;
    console.log(`  built ${p} (${body.length} bytes)`);
  }

  const file = join(dir, 'kv.json');
  writeFileSync(file, JSON.stringify(Object.entries(out).map(([key, value]) => ({ key, value, expiration_ttl: TTL }))));
  console.log(`writing ${Object.keys(out).length} snapshots to KV`);
  run(['kv', 'bulk', 'put', file, '--binding', 'CACHE', '--remote'], 'kv put');
  console.log('done');
} catch (e) {
  console.error(String(e.message ?? e));
  process.exitCode = 1;
} finally {
  stopDev();
  // Windows can hold the local database open a moment after the Worker exits; the folder is in temp, so leave it if so.
  try {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 800 });
  } catch {
    console.log('left ' + dir + ' in temp (still locked)');
  }
}
