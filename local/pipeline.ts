/**
 * Tereflow local pipeline.
 *
 * Fetches, analyses and publishes. Runs on your machine or your own server,
 * never on Workers.
 *
 * Why local:
 *   - Workers cap subrequests per invocation (50 on the free plan). Keyless,
 *     one country costs ~23 calls, so a cloud run managed two countries and
 *     rotated. Locally there is no cap and the whole registry finishes in one
 *     pass.
 *   - No Worker CPU time is spent on the heavy part, so the cloud bill stays
 *     at the free tier for what it is actually good at: serving readers.
 *   - The public APIs are rate limited per source IP. Running from one machine
 *     you control makes that predictable and easy to throttle.
 *
 * The cloud database only ever receives finished analysis.
 *
 * Usage:
 *   node local/dist/pipeline.mjs                  every activated country
 *   node local/dist/pipeline.mjs --slug ghana     one country
 *   node local/dist/pipeline.mjs --limit 10       first ten due
 *   node local/dist/pipeline.mjs --dry-run        analyse, publish nothing
 *   node local/dist/pipeline.mjs --force          skip the "unchanged?" check
 *
 * Before the expensive fetch, each country gets a cheap probe (latest-year
 * world totals only, 2-4 Comtrade calls instead of ~18) plus the World Bank
 * fetch (already cheap). If neither has moved since the last successful run,
 * the country is skipped entirely -- no full fetch, no analyse(), no publish.
 * --force bypasses this, e.g. after fixing an analyse.ts bug when you want to
 * recompute even though the source itself hasn't changed.
 *
 * Configuration comes from local/.env or the environment:
 *   TEREFLOW_API_URL     https://tereflow.example.com   (default localhost:8787)
 *   TEREFLOW_ADMIN_TOKEN the ADMIN_TOKEN secret
 *   COMTRADE_API_KEY     optional, raises the UN Comtrade rate limit
 *   TEREFLOW_CALL_PACE_MS pause between calls within one country (default 300ms)
 */
import { fetchComtrade, probeComtrade } from '../worker/agent/adapters/comtrade';
import { fetchWorldBank } from '../worker/agent/adapters/worldbank';
import { analyse } from '../worker/agent/analyse';
import type { FactRow } from '../worker/agent/types';

interface Config {
  apiUrl: string;
  adminToken: string;
  comtradeKey?: string;
  slug?: string;
  limit?: number;
  dryRun: boolean;
  /** Skip the "is the source unchanged" check and always do the full fetch. */
  force: boolean;
  yearsBack: number;
  /** Pause between countries so we stay a good citizen on public APIs. */
  politenessMs: number;
  /** Pause between the ~18 calls that make up ONE country's Comtrade fetch. */
  callPaceMs: number;
}

interface EntityRow {
  id: string;
  slug: string;
  name: string;
  iso3: string | null;
  is_active: 0 | 1;
  last_ingest_at: string | null;
  last_fingerprint: string | null;
}

function readConfig(): Config {
  const args = process.argv.slice(2);
  const flag = (name: string): string | undefined => {
    const i = args.indexOf(`--${name}`);
    return i >= 0 ? args[i + 1] : undefined;
  };

  const apiUrl = (process.env.TEREFLOW_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
  const adminToken = process.env.TEREFLOW_ADMIN_TOKEN ?? '';
  if (!adminToken) {
    console.error(
      'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.\n' +
        'It must match the ADMIN_TOKEN secret on the Worker.',
    );
    process.exit(1);
  }

  return {
    apiUrl,
    adminToken,
    comtradeKey: process.env.COMTRADE_API_KEY,
    slug: flag('slug'),
    limit: flag('limit') ? Number(flag('limit')) : undefined,
    dryRun: args.includes('--dry-run'),
    force: args.includes('--force'),
    yearsBack: Number(process.env.TEREFLOW_YEARS_BACK ?? 6),
    politenessMs: Number(process.env.TEREFLOW_POLITENESS_MS ?? 1200),
    callPaceMs: Number(process.env.TEREFLOW_CALL_PACE_MS ?? 300),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

class Api {
  constructor(private cfg: Config) {}

  private async call<T>(path: string, init: RequestInit = {}, timeoutMs = 60_000): Promise<T> {
    const headers = new Headers(init.headers);
    headers.set('accept', 'application/json');
    headers.set('authorization', `Bearer ${this.cfg.adminToken}`);
    if (init.body) headers.set('content-type', 'application/json');

    // Publishing must not fail because of one dropped connection.
    let lastError = 'unknown';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (attempt > 0) await sleep(800 * attempt);
      try {
        const res = await fetch(`${this.cfg.apiUrl}${path}`, {
          ...init,
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
        const text = await res.text();
        if (!res.ok) {
          if (res.status >= 500 || res.status === 429) {
            lastError = `HTTP ${res.status}`;
            continue;
          }
          throw new Error(`${path} -> HTTP ${res.status}: ${text.slice(0, 200)}`);
        }
        return (text ? JSON.parse(text) : null) as T;
      } catch (err) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === 2) throw new Error(`${path} -> ${lastError}`);
      }
    }
    throw new Error(`${path} -> ${lastError}`);
  }

  listCountries() {
    return this.call<{ entities: EntityRow[] }>('/api/admin/entities?kind=country');
  }
  start() {
    return this.call<{ run_id: string }>('/api/admin/ingest/start', { method: 'POST' });
  }
  skip(slug: string, fingerprint: string) {
    return this.call<{ ok: true }>('/api/admin/ingest/skip', {
      method: 'POST',
      body: JSON.stringify({ slug, fingerprint }),
    });
  }
  begin(slug: string, runId?: string) {
    return this.call<{ run_id: string }>('/api/admin/ingest/begin', {
      method: 'POST',
      body: JSON.stringify({ slug, run_id: runId }),
    });
  }
  facts(slug: string, facts: FactRow[]) {
    return this.call<{ written: number }>('/api/admin/ingest/facts', {
      method: 'POST',
      body: JSON.stringify({ slug, facts }),
    });
  }
  commit(payload: unknown) {
    return this.call<{ ok: true }>('/api/admin/ingest/commit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  fail(slug: string, error: string) {
    return this.call<{ ok: true }>('/api/admin/ingest/fail', {
      method: 'POST',
      body: JSON.stringify({ slug, error }),
    });
  }
  finish(payload: unknown) {
    return this.call<{ status: string; feed: Record<string, number> }>(
      '/api/admin/ingest/finish',
      { method: 'POST', body: JSON.stringify(payload) },
    );
  }
  checkLinks() {
    // Probing links is slow by nature, so this gets its own generous budget
    // rather than the standard request timeout.
    return this.call<{ checked: number; ok: number; gated: number; broken: number }>(
      '/api/admin/sources/check?limit=120',
      { method: 'POST' },
      180_000,
    );
  }
}

async function main() {
  const cfg = readConfig();
  const api = new Api(cfg);
  const started = Date.now();

  console.log('Tereflow pipeline');
  console.log(`  target      ${cfg.apiUrl}`);
  console.log(`  comtrade    ${cfg.comtradeKey ? 'keyed' : 'keyless (slower, fewer years)'}`);
  if (cfg.dryRun) console.log('  mode        DRY RUN, nothing will be published');
  if (cfg.force) console.log('  mode        FORCE, ignoring the unchanged-since-last-check skip');
  console.log('');

  const { entities } = await api.listCountries();

  let targets = entities.filter((e) => e.is_active === 1 && e.iso3);
  if (cfg.slug) {
    targets = entities.filter((e) => e.slug === cfg.slug);
    if (targets.length === 0) {
      console.error(`No entity with slug "${cfg.slug}".`);
      process.exit(1);
    }
  } else {
    // Oldest first, so an interrupted run resumes where it left off.
    targets.sort((a, b) => (a.last_ingest_at ?? '').localeCompare(b.last_ingest_at ?? ''));
    if (cfg.limit) targets = targets.slice(0, cfg.limit);
  }

  console.log(`${targets.length} country/countries to process\n`);
  if (targets.length === 0) {
    console.log('Nothing activated. Tick a country in Admin first.');
    return;
  }

  const thisYear = new Date().getUTCFullYear();
  const years = Array.from({ length: cfg.yearsBack }, (_, i) => thisYear - 1 - i).reverse();
  const candidateYears = [...years].reverse(); // newest first, for the probe

  // Create the run up front rather than lazily on the first begin(), so a run
  // still exists to record against even if the very first country turns out
  // to be skipped below.
  let runId: string | undefined;
  if (!cfg.dryRun) runId = (await api.start()).run_id;

  let ok = 0;
  let failed = 0;
  let skipped = 0;
  let factsTotal = 0;
  const errors: { slug: string; error: string }[] = [];

  for (const [i, entity] of targets.entries()) {
    const label = `[${i + 1}/${targets.length}] ${entity.name}`;
    process.stdout.write(`${label} ... `);
    const t0 = Date.now();

    try {
      // Cheap first: a latest-year-only Comtrade probe (2-4 calls) plus the
      // already-cheap World Bank fetch, before paying for the full ~18-call
      // Comtrade product/partner breakdown.
      const [probe, worldbank] = await Promise.all([
        probeComtrade({ COMTRADE_API_KEY: cfg.comtradeKey } as never, entity.iso3!, candidateYears),
        fetchWorldBank(entity.iso3!, years),
      ]);
      const fingerprint = JSON.stringify({
        y: probe.year,
        x: probe.export_usd,
        m: probe.import_usd,
        wb: worldbank.meta?.lastupdated ?? null,
      });

      const unchanged =
        !cfg.force && !cfg.dryRun && entity.last_ingest_at != null && fingerprint === entity.last_fingerprint;

      if (unchanged) {
        console.log('unchanged since last check, skipped');
        skipped++;
        await api.skip(entity.slug, fingerprint);
        if (i < targets.length - 1) await sleep(cfg.politenessMs);
        continue;
      }

      const comtrade = await fetchComtrade(
        { COMTRADE_API_KEY: cfg.comtradeKey } as never,
        entity.iso3!,
        years,
        cfg.callPaceMs,
      );

      const rows: FactRow[] = [...comtrade.rows, ...worldbank.rows];
      if (rows.length === 0) {
        throw new Error(`no data. ${comtrade.note} | ${worldbank.note}`);
      }

      const sourceRefs = [
        ...(comtrade.ok ? [comtrade.source_ref] : []),
        ...(worldbank.ok ? [worldbank.source_ref] : []),
      ];
      const bundle = analyse(entity.name, rows, worldbank.context, sourceRefs);

      const coverage =
        (comtrade.ok ? 0.6 : 0) +
        (worldbank.ok ? 0.25 : 0) +
        (bundle.yearly_trend.length >= 4 ? 0.15 : 0);

      if (cfg.dryRun) {
        const o = bundle.overview;
        console.log(
          `analysed only. ${rows.length} rows, ${o.year}: ` +
            `X $${(o.export_usd / 1e9).toFixed(1)}bn M $${(o.import_usd / 1e9).toFixed(1)}bn`,
        );
        ok++;
        factsTotal += rows.length;
        continue;
      }

      await api.begin(entity.slug, runId);

      // Batched so no single Worker invocation does too much work.
      const BATCH = 1000;
      for (let j = 0; j < rows.length; j += BATCH) {
        await api.facts(entity.slug, rows.slice(j, j + BATCH));
      }

      await api.commit({
        slug: entity.slug,
        run_id: runId,
        coverage_score: coverage,
        fingerprint: probe.ok ? fingerprint : undefined,
        analysis: {
          overview: bundle.overview,
          top_exports: bundle.top_exports,
          top_imports: bundle.top_imports,
          services: bundle.services,
          partners_export: bundle.partners_export,
          partners_import: bundle.partners_import,
          yearly_trend: bundle.yearly_trend,
          recommendations: bundle.recommendations,
        },
        signals: bundle.signals,
      });

      ok++;
      factsTotal += rows.length;
      const o = bundle.overview;
      console.log(
        `${rows.length} rows, ${o.year}: ` +
          `X $${(o.export_usd / 1e9).toFixed(1)}bn ` +
          `M $${(o.import_usd / 1e9).toFixed(1)}bn ` +
          `(${((Date.now() - t0) / 1000).toFixed(0)}s)`,
      );
    } catch (err) {
      failed++;
      const message = err instanceof Error ? err.message : String(err);
      errors.push({ slug: entity.slug, error: message });
      console.log(`FAILED: ${message.slice(0, 120)}`);
      if (!cfg.dryRun) await api.fail(entity.slug, message).catch(() => undefined);
    }

    if (i < targets.length - 1) await sleep(cfg.politenessMs);
  }

  console.log('');

  if (!cfg.dryRun && runId) {
    const result = await api.finish({
      run_id: runId,
      entities_total: targets.length,
      entities_ok: ok,
      entities_failed: failed,
      entities_skipped: skipped,
      facts_written: factsTotal,
      log: { errors },
    });
    console.log(`Run ${result.status}. Feed: ${JSON.stringify(result.feed)}`);

    // Link health is cheap and belongs on the same schedule.
    try {
      const links = await api.checkLinks();
      console.log(
        `Links: ${links.checked} checked, ${links.ok} healthy, ${links.gated} gated, ${links.broken} broken`,
      );
    } catch (err) {
      console.log(`Link check skipped: ${err instanceof Error ? err.message : err}`);
    }
  }

  const mins = ((Date.now() - started) / 60_000).toFixed(1);
  console.log(`\n${ok} ok, ${skipped} unchanged/skipped, ${failed} failed, ${factsTotal} facts, ${mins} min`);
  if (errors.length) {
    console.log('\nFailures:');
    for (const e of errors) console.log(`  ${e.slug}: ${e.error.slice(0, 160)}`);
  }

  process.exit(failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nPipeline crashed:', err);
  process.exit(1);
});
