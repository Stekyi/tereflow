/**
 * The Ghana ingestion pipeline.
 *
 *   npm run ghana                 fetch, analyse, store
 *   npm run ghana -- --dry-run    fetch and analyse, store nothing
 *   npm run ghana -- --chapters 6 quick check against a few chapters
 *
 * Fetching happens here, in Node, not inside the Worker. That is not a
 * workaround, it is the shape this project already uses: a Worker is a request
 * handler with a subrequest budget and a short wall clock, and one full run is
 * 96 sequential calls to somebody else's government API. The same decision was
 * already taken for the Comtrade pipeline and the reasoning is in wrangler.toml.
 * Finished analysis is pushed to the Worker, which stores it. It also means a
 * user opening the app never triggers a call to StatBank.
 *
 * THE FALLBACK IS GONE. The old pipeline tried a national source and dropped
 * through to UN Comtrade when it produced nothing (local/pipeline.ts:497). That
 * is why all 6,707 of Ghana's stored facts came from Comtrade and the World
 * Bank while the dashboard implied they were national statistics.
 *
 * If StatBank fails here, the run is marked failed and stops. Nothing else is
 * consulted and the previous successful dataset is left where it is, so the
 * application keeps serving the last thing that was true. A stale dashboard
 * that admits it is stale beats a fresh-looking one built from another source.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import { loadEnv } from './build.mjs';

loadEnv();

const API = process.env.TEREFLOW_API_URL ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TEREFLOW_ADMIN_TOKEN ?? process.env.ADMIN_TOKEN ?? '';

const args = process.argv.slice(2);
const has = (f) => args.includes(`--${f}`);
const val = (f) => {
  const i = args.indexOf(`--${f}`);
  return i >= 0 ? args[i + 1] : undefined;
};

const dryRun = has('dry-run');
const flow = val('flow') ?? 'import';
const chapterLimit = Number(val('chapters') ?? 0) || null;
const BUNDLE = '.tmp-ghana-pipeline.mjs';

function log(level, message) {
  console.log(`[${level}] ${message}`);
}

async function api(path, init = {}) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  headers.set('connection', 'close');
  const res = await fetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(180_000) });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = { raw: text.slice(0, 300) };
  }
  if (!res.ok) throw new Error(body?.error ?? `HTTP ${res.status} from ${path}`);
  return body;
}

function fail(messageText) {
  log('ERROR', 'Ghana StatBank ingestion failed');
  log('ERROR', messageText);
  log('ERROR', 'Ingestion run marked FAILED');
  log('ERROR', 'Previous successful dataset preserved');
  log('ERROR', 'No other source was consulted.');
  rmSync(BUNDLE, { force: true });
  process.exitCode = 1;
}

/** A handful of chapters, for when the point is to see the pipeline work. */
function limitedChapters(n) {
  return ['34', '48', '39', '87', '21', '33', '94', '73', '85', '84'].slice(0, n);
}

/** Every chapter the endpoint offers, read from its own dimension list. */
async function allChapters(config) {
  const res = await fetch(config.provider.endpoint, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status} reading the chapter list`);
  const meta = await res.json();
  const dim = meta.variables.find((v) => v.code === config.provider.dimensions.product);
  if (!dim) throw new Error('The endpoint has no product dimension.');
  return dim.values
    .filter((v) => v !== config.provider.values.all_products)
    .map((v) => (v.match(/^\s*(\d{1,2})\s*-/)?.[1] ?? '').padStart(2, '0'))
    .filter(Boolean);
}

/** A response that parsed is not a response worth storing. */
function valid(o) {
  if (o.import_value_usd == null || !Number.isFinite(o.import_value_usd)) return false;
  if (o.import_value_usd < 0) return false;
  if (!o.product_code || !o.partner_country) return false;
  if (!Number.isInteger(o.year) || o.year < 1900 || o.year > 2100) return false;
  return true;
}

async function main() {
  // Stage 1: validate configuration before anything is fetched or written.
  if (!TOKEN) {
    log('ERROR', 'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.');
    process.exitCode = 1;
    return;
  }
  if (flow !== 'import' && flow !== 'export') {
    log('ERROR', `--flow must be import or export, not ${flow}`);
    process.exitCode = 1;
    return;
  }

  // The provider and analytics are the same TypeScript the Worker uses, so
  // there is one implementation of the maths rather than a copy that drifts.
  await build({
    entryPoints: ['scripts/entry-ghana-pipeline.ts'],
    outfile: BUNDLE,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node20',
  });
  const { GhanaStatBankProvider, GHANA, computeMetrics, buildOpportunities } =
    await import(`./../${BUNDLE}`);

  log('INFO', 'Ghana StatBank ingestion started');
  log('INFO', `Years: ${GHANA.years.join(', ')}`);
  log('INFO', `Trade flow: ${flow}`);
  log('INFO', 'Valuation: USD and net weight in KG');
  log('INFO', `Partner countries: ${GHANA.partners.length}`);
  log('INFO', `Classification: ${GHANA.classification.level}`);

  const provider = new GhanaStatBankProvider();
  const startedAt = new Date().toISOString();

  // Chapter by chapter, storing as we go.
  //
  // A full run is 96 sequential calls at roughly nine seconds each, so about
  // fourteen minutes. Fetching everything and storing at the end meant a run
  // interrupted at minute thirteen wrote nothing at all, which is a poor trade
  // for a job that talks to somebody else's government API. Each chapter is
  // now stored when it arrives, so an interrupted run keeps what it got and the
  // next run fills in the rest. The grain index makes re-running safe.
  const chapters = chapterLimit ? limitedChapters(chapterLimit) : await allChapters(GHANA);
  log('INFO', `Products requested: ${chapters.length}`);

  const observations = [];
  const notes = [];
  const rejections = [];
  let received = 0;
  let firstRaw = null;
  let failedChapters = 0;

  for (let i = 0; i < chapters.length; i++) {
    const code = chapters[i];
    let result;
    try {
      result = await provider.fetchObservations({
        config: GHANA,
        flow,
        years: GHANA.years,
        partners: GHANA.partners,
        products: [code],
      });
    } catch (err) {
      failedChapters++;
      log('WARN', `HS${code} failed: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }

    received += result.observations.length;
    rejections.push(...result.rejected);
    notes.push(...result.notes);
    if (!firstRaw && result.raw.length) firstRaw = result.raw[0];

    // Validate here rather than at the end, so a bad cell is rejected next to
    // the chapter it came from and the count in the log means something.
    const good = result.observations.filter(valid);
    observations.push(...good);

    if ((i + 1) % 12 === 0 || i === chapters.length - 1) {
      log('INFO', `Progress: ${i + 1}/${chapters.length} chapters, ${observations.length} observations`);
    }
  }

  if (failedChapters) {
    log('WARN', `${failedChapters} chapter${failedChapters === 1 ? '' : 's'} could not be fetched.`);
  }

  log('INFO', `Records received: ${received}`);
  log('INFO', `Records validated: ${observations.length}`);
  log('INFO', `Records rejected: ${received - observations.length + rejections.length}`);

  for (const note of notes.slice(0, 6)) log('INFO', `Note: ${note}`);
  for (const r of rejections.slice(0, 6)) log('WARN', `Rejected (${r.reason}): ${r.detail}`);

  if (!observations.length) return fail('No observations survived validation. Nothing was stored.');

  const result = {
    observations,
    raw: firstRaw ? [firstRaw] : [],
    rejected: rejections,
    notes,
  };
  const rejected = received - observations.length + rejections.length;

  log('INFO', 'Deterministic opportunity analysis started');
  const metrics = computeMetrics(observations);
  const opportunities = buildOpportunities(metrics, GHANA);
  const kept = opportunities.filter((o) => !o.is_excluded);
  log('INFO', `Products analysed: ${metrics.length}`);
  log('INFO', `Opportunities generated: ${opportunities.length}`);
  log('INFO', `Excluded as traditional commodities: ${opportunities.length - kept.length}`);

  console.log('\nTop non-traditional signals:');
  console.log('  score  confidence  code  latest value  product');
  for (const o of kept.slice(0, 12)) {
    console.log(
      `  ${String(o.opportunity_score).padStart(5)}  ${o.data_confidence.padEnd(10)}  ` +
      `${o.product_code}    ${('$' + (o.metrics.import_value_usd / 1e6).toFixed(1) + 'm').padStart(9)}  ` +
      `${o.product_name.slice(0, 44)}`,
    );
  }
  console.log('');

  if (dryRun) {
    log('INFO', 'Dry run: nothing was written.');
    rmSync(BUNDLE, { force: true });
    return;
  }

  try {
    const stored = await api('/api/admin/ghana/store', {
      method: 'POST',
      body: JSON.stringify({
        country: GHANA.code,
        flow,
        started_at: startedAt,
        endpoint: GHANA.provider.endpoint,
        years: GHANA.years,
        partners_requested: GHANA.partners.length,
        records_received: result.observations.length,
        records_rejected: rejected,
        observations,
        metrics,
        opportunities,
        // One response is kept as a sample. A full run is 96 of them and the
        // point is being able to inspect the shape when a parse looks wrong,
        // not archiving every byte the API ever sent.
        raw: result.raw.slice(0, 1),
        notes: result.notes,
      }),
    });
    log('INFO', `Stored ${stored.observations_written} observations and ${stored.opportunities_written} opportunities`);
    log('INFO', `Run: ${stored.run_id}`);
    log('INFO', 'Ghana StatBank ingestion completed successfully');
  } catch (err) {
    return fail(`Storing results failed: ${err instanceof Error ? err.message : String(err)}`);
  }

  rmSync(BUNDLE, { force: true });
}

main().catch((err) => {
  log('ERROR', 'Ghana StatBank ingestion failed');
  log('ERROR', err instanceof Error ? err.message : String(err));
  log('ERROR', 'Previous successful dataset preserved');
  rmSync(BUNDLE, { force: true });
  process.exitCode = 1;
});
