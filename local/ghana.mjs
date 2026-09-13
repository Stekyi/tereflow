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
/**
 * Watch mode: stay up and take whatever the admin asks for.
 *
 * The admin wanted one button. The work behind it is about fourteen minutes of
 * sequential calls to a government API, which does not fit in a Worker request,
 * so the button queues and this drains the queue. Without something in watch
 * mode a queued run waits forever, which is why the UI reports whether anything
 * has claimed work recently rather than just showing a bar.
 */
const watch = has('watch');
const pollSeconds = Number(val('poll') ?? 5) || 5;
const BUNDLE = '.tmp-ghana-pipeline.mjs';

function log(level, message) {
  console.log(`[${level}] ${message}`);
}

async function api(path, init = {}, timeoutMs = 180_000) {
  const headers = new Headers(init.headers);
  headers.set('accept', 'application/json');
  headers.set('authorization', `Bearer ${TOKEN}`);
  if (init.body) headers.set('content-type', 'application/json');
  headers.set('connection', 'close');
  const res = await fetch(`${API}${path}`, { ...init, headers, signal: AbortSignal.timeout(timeoutMs) });
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

/**
 * A progress update, which must never hold up the work it is describing.
 *
 * The default timeout is three minutes, which is right for storing a run's
 * results and badly wrong for saying how far along it is. A stalled connection
 * on a progress call froze an entire ingest before the first chapter, and the
 * log went quiet with no indication why.
 *
 * Five seconds, and a failure is logged rather than swallowed. Best effort is
 * not the same as silent: this failing means the admin watches an empty bar,
 * and something should say so.
 */
async function reportRun(path, body, what) {
  try {
    await api(path, { method: 'POST', body: JSON.stringify(body) }, 5_000);
    return true;
  } catch (err) {
    log('WARN', `Could not report ${what}: ${err instanceof Error ? err.message : String(err)}`);
    return false;
  }
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

/**
 * One ingest.
 *
 * `runFlow` and `existingRunId` are passed rather than read from argv so watch
 * mode can drive this per queued job. A run claimed from the queue already has
 * a row, and opening a second one would leave the first as `running` forever
 * while the admin watched the wrong bar.
 */
async function main(runFlow = flow, existingRunId = null) {
  // Stage 1: validate configuration before anything is fetched or written.
  if (!TOKEN) {
    log('ERROR', 'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.');
    process.exitCode = 1;
    return;
  }
  if (runFlow !== 'import' && runFlow !== 'export') {
    log('ERROR', `--flow must be import or export, not ${runFlow}`);
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
  log('INFO', `Trade flow: ${runFlow}`);
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

  // Open the run before fetching, so there is something to poll for the
  // fourteen minutes this takes. Without it the admin screen can only show a
  // spinner, which cannot distinguish a run on chapter 84 from one that died on
  // chapter 3.
  //
  // A run claimed from the queue already has a row and is already marked
  // running. Opening a second one would leave the first as `running` forever
  // while the admin watched a bar belonging to nothing.
  //
  // Best effort: a reporting failure must not stop an ingest. If the run cannot
  // be opened the fetch still happens and /store creates the row at the end,
  // exactly as it did before.
  let runId = existingRunId;
  if (runId) {
    // Claimed runs are queued before the chapter list is known, so the total
    // arrives now rather than at request time. Without it the bar has no
    // denominator and shows "in progress" for the whole fourteen minutes,
    // which is the spinner this replaced.
    await reportRun(
      `/api/ghana/runs/${runId}/progress`,
      { chapters_total: chapters.length, current_step: 'Starting' },
      'the chapter total',
    );
    log('INFO', `Run claimed: ${runId}`);
  } else {
    try {
      const opened = await api('/api/ghana/runs/open', {
        method: 'POST',
        body: JSON.stringify({
          country: GHANA.code,
          provider: 'ghana-statbank',
          chapters_total: chapters.length,
          endpoint: GHANA.provider.endpoint,
        }),
      });
      runId = opened?.run_id ?? null;
      if (runId) log('INFO', `Run opened: ${runId}`);
    } catch (err) {
      log('WARN', `Could not open a run for progress reporting: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Push progress. Never blocks the work it describes. */
  async function reportProgress(body) {
    if (!runId) return;
    await reportRun(`/api/ghana/runs/${runId}/progress`, body, 'progress');
  }

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
        flow: runFlow,
        years: GHANA.years,
        partners: GHANA.partners,
        products: [code],
      });
    } catch (err) {
      failedChapters++;
      log('WARN', `HS${code} failed: ${err instanceof Error ? err.message : String(err)}`);
      // Counted as done even though it failed. Progress is how far through the
      // work the run is, not how much of it worked; conflating the two leaves a
      // run with failures appearing to stall.
      await reportProgress({
        chapters_done: i + 1,
        records_received: received,
        records_processed: observations.length,
        current_step: `Chapter ${code} failed`,
      });
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

    await reportProgress({
      chapters_done: i + 1,
      records_received: received,
      records_processed: observations.length,
      records_rejected: received - observations.length + rejections.length,
      current_step: `Chapter ${code}`,
    });

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

  if (!observations.length) {
    // Close the run rather than leaving it as `running` forever. An abandoned
    // row shows the admin screen a run permanently in progress, which is worse
    // than a visible failure because nobody goes looking for it.
    if (runId) {
      await api(`/api/ghana/runs/${runId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: 'No observations survived validation. Nothing was stored.' }),
      }).catch(() => undefined);
    }
    return fail('No observations survived validation. Nothing was stored.');
  }

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
    // A dry run that opened a row must close it, or the admin screen shows a
    // run stuck at 100% that never finished.
    if (runId) {
      await api(`/api/ghana/runs/${runId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: 'Dry run: nothing was written.' }),
      }).catch(() => undefined);
    }
    rmSync(BUNDLE, { force: true });
    return;
  }

  try {
    const stored = await api('/api/admin/ghana/store', {
      method: 'POST',
      body: JSON.stringify({
        country: GHANA.code,
        flow: runFlow,
        // The run opened before fetching, so the row the admin screen has been
        // polling is the row that gets the result rather than a second one
        // appearing at the end.
        run_id: runId ?? undefined,
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
    const detail = err instanceof Error ? err.message : String(err);
    if (runId) {
      await api(`/api/ghana/runs/${runId}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: `Storing results failed: ${detail}` }),
      }).catch(() => undefined);
    }
    return fail(`Storing results failed: ${detail}`);
  }

  rmSync(BUNDLE, { force: true });
}

/**
 * Stay up and take whatever the admin asks for.
 *
 * The point of the button is that nobody opens a terminal. Something still has
 * to do the fourteen minutes of work, so this is that something: it claims one
 * queued run at a time and runs it exactly as a manual invocation would.
 *
 * One at a time on purpose. Two concurrent runs would double the request rate
 * against somebody else's government API, and the second would be doing it
 * without anybody having asked for more throughput.
 */
async function watchQueue() {
  if (!TOKEN) {
    log('ERROR', 'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.');
    process.exitCode = 1;
    return;
  }

  log('INFO', `Watching ${API} for queued runs, polling every ${pollSeconds}s`);
  log('INFO', 'Nothing runs until an admin asks for one. Ctrl+C to stop.');

  let stopping = false;
  process.on('SIGINT', () => {
    // Finish the run in hand rather than abandoning it mid-fetch, which would
    // leave a row marked running that nothing is working on.
    log('INFO', 'Stopping after the current run.');
    stopping = true;
  });

  let idleLogged = false;

  while (!stopping) {
    let claimed = null;
    try {
      const res = await api('/api/ghana/runs/claim', {
        method: 'POST',
        body: JSON.stringify({ agent: 'ghana-statbank' }),
      });
      claimed = res?.claimed ?? null;
    } catch (err) {
      // A Worker that is down is a reason to wait, not to exit. The admin's
      // queued run is still queued and will be picked up when it returns.
      if (!idleLogged) {
        log('WARN', `Could not reach ${API}: ${err instanceof Error ? err.message : String(err)}`);
        idleLogged = true;
      }
      await new Promise((r) => setTimeout(r, pollSeconds * 1000));
      continue;
    }

    if (!claimed) {
      idleLogged = false;
      await new Promise((r) => setTimeout(r, pollSeconds * 1000));
      continue;
    }

    log('INFO', `Claimed ${claimed.run_id}: ${claimed.country} ${claimed.flow}`);
    try {
      await main(claimed.flow, claimed.run_id);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      log('ERROR', `Run ${claimed.run_id} failed: ${detail}`);
      // Close it, or the admin watches a bar for a run nothing is working on.
      await api(`/api/ghana/runs/${claimed.run_id}/fail`, {
        method: 'POST',
        body: JSON.stringify({ error: detail }),
      }).catch(() => undefined);
    }
    // One failing run must not stop the agent: the next request should still
    // be picked up.
    process.exitCode = 0;
  }
}

const entry = watch ? watchQueue() : main();

entry.catch((err) => {
  log('ERROR', 'Ghana StatBank ingestion failed');
  log('ERROR', err instanceof Error ? err.message : String(err));
  log('ERROR', 'Previous successful dataset preserved');
  rmSync(BUNDLE, { force: true });
  process.exitCode = 1;
});
