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
 *   node local/dist/pipeline.mjs --validate       fetch Comtrade, validate, publish nothing
 *   node local/dist/pipeline.mjs --force          skip the "unchanged?" check
 *
 * Before the expensive fetch, each country gets a cheap probe (latest-year
 * world totals only, two Comtrade calls) plus the World Bank context fetch.
 * If neither has moved since the last successful run,
 * the country is skipped entirely -- no full fetch, no analyse(), no publish.
 * --force bypasses this, e.g. after fixing an analyse.ts bug when you want to
 * recompute even though the source itself hasn't changed.
 *
 * Configuration comes from local/.env or the environment:
 *   TEREFLOW_API_URL     https://tereflow.example.com   (default localhost:8787)
 *   TEREFLOW_ADMIN_TOKEN the ADMIN_TOKEN secret
 *   COMTRADE_API_KEY     optional, raises the UN Comtrade rate limit
 *   TEREFLOW_CALL_PACE_MS pause between direct Comtrade calls within one country (default 2000ms)
 */
import { fetchComtrade, probeComtrade, RateLimited } from '../worker/agent/adapters/comtrade';
import { fetchWorldBank } from '../worker/agent/adapters/worldbank';
import { analyse } from '../worker/agent/analyse';
import { CODE_TO_KEY, DEFAULTS, type Settings } from '../worker/lib/settings';
import type { FactRow } from '../worker/agent/types';
import type { EntitySource } from '../shared/types';

/**
 * Fetch the tunable thresholds the app is currently running to.
 *
 * A failure here is not fatal. Falling back to what the code shipped with
 * produces a correct run using the original numbers, which is better than
 * refusing to analyse because a settings table could not be read. It is
 * announced rather than swallowed, because a run that quietly ignored an
 * edited threshold would be confusing to debug later.
 */
async function loadRunSettings(api: Api, dryRun: boolean): Promise<Settings> {
  try {
    const { settings: rows } = await api.settings();
    const out: Settings = { ...DEFAULTS };
    let applied = 0;
    for (const r of rows) {
      const key: keyof Settings | undefined = CODE_TO_KEY[r.code];
      if (!key) continue;
      const n = Number(r.value);
      if (!Number.isFinite(n)) continue;
      out[key] = n;
      applied++;
    }
    if (!dryRun) console.log(`  settings: ${applied} thresholds loaded from code_setup`);
    return out;
  } catch (e) {
    console.log(`  settings: could not read code_setup (${(e as Error).message}), using defaults`);
    return { ...DEFAULTS };
  }
}

async function loadOpportunityClassifications(
  api: Api,
  slug: string,
): Promise<Map<string, { category: 'traditional' | 'non_traditional' }>> {
  try {
    const { rows } = await api.classifications(slug);
    return new Map(rows.map((r) => [r.hs_code, { category: r.category }]));
  } catch {
    console.log(`  classifications: unavailable for ${slug}, using universal defaults`);
    return new Map(['26', '27', '71'].map((hs_code) => [hs_code, { category: 'traditional' as const }]));
  }
}

interface Config {
  apiUrl: string;
  adminToken: string;
  comtradeKey?: string;
  slug?: string;
  limit?: number;
  dryRun: boolean;
  /** Fetch Comtrade and run data-quality checks without analysis or publishing. */
  validate: boolean;
  /** Skip the "is the source unchanged" check and always do the full fetch. */
  force: boolean;
  /**
   * Recompute from the facts already stored, without contacting any source.
   *
   * For fixing the analysis rather than refreshing the data. Everything the app
   * shows is derived from trade_facts, so a change to the maths only needs the
   * maths re-run.
   */
  reanalyse: boolean;
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
  sources: Record<'export' | 'import' | 'commerce', EntitySource[]>;
}

interface SourceAttempt {
  source_id: string | null;
  source_ref: string;
  role: 'primary' | 'fallback' | 'validator';
  parser_key: string;
  url: string;
  status: 'ok' | 'failed' | 'partial';
  rows_written: number;
  note: string;
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
    dryRun: args.includes('--dry-run') || args.includes('--validate'),
    validate: args.includes('--validate'),
    force: args.includes('--force'),
    reanalyse: args.includes('--reanalyse') || args.includes('--reanalyze'),
    yearsBack: Number(process.env.TEREFLOW_YEARS_BACK ?? 6),
    politenessMs: Number(process.env.TEREFLOW_POLITENESS_MS ?? 1200),
    callPaceMs: Number(process.env.TEREFLOW_CALL_PACE_MS ?? 2000),
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
  /** Read stored facts back, for --reanalyse. Paged; the caller loops. */
  async storedFacts(slug: string): Promise<FactRow[]> {
    const out: FactRow[] = [];
    const PAGE = 5000;
    for (let offset = 0; ; offset += PAGE) {
      const r = await this.call<{ facts: FactRow[]; returned: number; total: number }>(
        `/api/admin/ingest/facts/${encodeURIComponent(slug)}?limit=${PAGE}&offset=${offset}`,
      );
      out.push(...r.facts);
      if (r.returned < PAGE || out.length >= r.total) break;
    }
    return out;
  }
  commit(payload: unknown) {
    return this.call<{ ok: true }>('/api/admin/ingest/commit', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
  }
  /** Per-product rows for the product modal. Sent after the analysis commits. */
  productAnalytics(slug: string, rows: unknown[]) {
    return this.call<{ written: number }>('/api/admin/ingest/product-analytics', {
      method: 'POST',
      body: JSON.stringify({ slug, rows }),
    });
  }
  /**
   * Settle the cross-country price comparison. Runs once at the end of a pass,
   * because a country's price only means something next to everybody else's.
   */
  priceRatios() {
    return this.call<{ priced: number; implausible_weights_dropped: number }>(
      '/api/admin/ingest/price-ratios',
      { method: 'POST' },
    );
  }
  /**
   * The thresholds the analysis should work to.
   *
   * Fetched rather than imported so a change made in the portal takes effect
   * on the next run without redeploying anything the pipeline runs from.
   */
  settings() {
    return this.call<{ settings: { code: string; value: string }[] }>(
      '/api/admin/portal/config',
    );
  }
  classifications(slug: string) {
    return this.call<{ rows: { hs_code: string; category: 'traditional' | 'non_traditional' }[] }>(
      `/api/admin/classifications?entity=${encodeURIComponent(slug)}`,
    );
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

function printComtradeValidation(iso3: string, country: string, result: Awaited<ReturnType<typeof fetchComtrade>>) {
  const rows = result.rows;
  const productRows = rows.filter((r) => r.hs_code?.length === 6 && r.partner_iso3);
  const headlineRows = rows.filter((r) => !r.hs_code && !r.partner_iso3);
  const chapterRows = rows.filter((r) => r.hs_code?.length === 2 && !r.partner_iso3);
  const flows = ['export', 'import'] as const;
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const products = new Set(productRows.map((r) => r.hs_code));
  const partners = new Set(productRows.map((r) => r.partner_iso3));
  const duplicateKeys = new Set<string>();
  const seen = new Set<string>();
  for (const r of productRows) {
    const key = `${r.year}|${r.flow}|${r.partner_iso3}|${r.hs_code}`;
    if (seen.has(key)) duplicateKeys.add(key);
    seen.add(key);
  }

  const moneyByFlow = (flow: 'export' | 'import', source: FactRow[]) =>
    source.filter((r) => r.flow === flow).reduce((sum, r) => sum + Number(r.value_usd || 0), 0);
  const productValueByFlow = (flow: 'export' | 'import') => moneyByFlow(flow, productRows);
  const headlineValueByFlow = (flow: 'export' | 'import') => moneyByFlow(flow, headlineRows);
  const pctDiff = (headline: number, productsValue: number) =>
    headline > 0 ? ((productsValue - headline) / headline) * 100 : null;
  const weightRows = productRows.filter((r) => r.qty != null && Number.isFinite(Number(r.qty)));
  const weightByFlow = (flow: 'export' | 'import') =>
    weightRows.filter((r) => r.flow === flow).reduce((sum, r) => sum + Number(r.qty || 0), 0);

  console.log('');
  console.log('COMTRADE DATA VALIDATION');
  console.log('========================');
  console.log(`Country: ${country} (${iso3})`);
  console.log(`Years:   ${years.join(', ') || 'none'}`);
  console.log('');
  console.log('ROWS');
  console.log('----');
  console.log(`Total Comtrade facts:       ${rows.length.toLocaleString()}`);
  console.log(`Partner × HS6 rows:         ${productRows.length.toLocaleString()}`);
  console.log(`Headline World rows:        ${headlineRows.length.toLocaleString()}`);
  console.log(`Generated HS2 rows:          ${chapterRows.length.toLocaleString()}`);
  for (const flow of flows) {
    console.log(`  ${flow.padEnd(6)} partner × HS6:       ${productRows.filter((r) => r.flow === flow).length.toLocaleString()}`);
  }
  console.log('');
  console.log('PRODUCTS / PARTNERS');
  console.log('-------------------');
  console.log(`Unique HS6 products:        ${products.size.toLocaleString()}`);
  console.log(`Unique partner countries:   ${partners.size.toLocaleString()}`);
  console.log(`World aggregate product rows: ${productRows.filter((r) => r.partner_iso3 === 'WLD').length.toLocaleString()}`);
  console.log('');
  console.log('VALUE RECONCILIATION');
  console.log('--------------------');
  for (const flow of flows) {
    const headline = headlineValueByFlow(flow);
    const partnerProducts = productValueByFlow(flow);
    const diff = pctDiff(headline, partnerProducts);
    console.log(
      `${flow.padEnd(6)} Comtrade total: $${(headline / 1e9).toFixed(2)}bn | ` +
      `partner × HS6: $${(partnerProducts / 1e9).toFixed(2)}bn | ` +
      `difference: ${diff == null ? 'n/a' : `${diff.toFixed(2)}%`}`,
    );
  }
  console.log('');
  console.log('WEIGHT / QUALITY');
  console.log('----------------');
  console.log(`Rows with net weight:       ${weightRows.length.toLocaleString()} / ${productRows.length.toLocaleString()}`);
  for (const flow of flows) {
    console.log(`  ${flow.padEnd(6)} net weight:        ${(weightByFlow(flow) / 1e9).toFixed(3)} million tonnes`);
  }
  console.log(`Duplicate partner-product keys: ${duplicateKeys.size.toLocaleString()}`);
  console.log(`Zero-value partner rows:         ${productRows.filter((r) => !(Number(r.value_usd) > 0)).length.toLocaleString()}`);
  console.log(`Truncated by 250k ceiling:       ${result.truncated_years?.length ? `YES (${result.truncated_years.join(', ')})` : 'NO'}`);
  console.log('');
  console.log('STATUS');
  console.log('------');
  const checks = [
    ['Comtrade returned partner × HS6 rows', productRows.length > 0],
    ['No duplicate partner-product keys', duplicateKeys.size === 0],
    ['No World aggregate in partner dataset', productRows.every((r) => r.partner_iso3 !== 'WLD')],
    ['No zero-value partner rows after normalization', productRows.every((r) => Number(r.value_usd) > 0)],
    ['Response not truncated', !result.truncated_years?.length],
  ];
  for (const [label, ok] of checks) console.log(`${ok ? 'PASS' : 'WARN'}  ${label}`);
  console.log('');
  console.log(`Adapter note: ${result.note || 'none'}`);
}

async function main() {
  const cfg = readConfig();
  const api = new Api(cfg);
  const started = Date.now();

  console.log('Tereflow pipeline');
  console.log(`  target      ${cfg.apiUrl}`);
  console.log(`  comtrade    ${cfg.comtradeKey ? 'keyed' : 'keyless (slower, fewer years)'}`);
  if (cfg.validate) console.log('  mode        VALIDATE, fetch only; nothing will be analysed or published');
  else if (cfg.dryRun) console.log('  mode        DRY RUN, nothing will be published');
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
  let rateLimited: RateLimited | null = null;
  const errors: { slug: string; error: string }[] = [];

  // Read the thresholds once for the whole pass so every country in a run is
  // analysed to the same rules, even if somebody edits a setting mid-run.
  const settings = await loadRunSettings(api, cfg.dryRun);

  for (const [i, entity] of targets.entries()) {
    const label = `[${i + 1}/${targets.length}] ${entity.name}`;
    process.stdout.write(`${label} ... `);
    const t0 = Date.now();

    try {
      if (cfg.validate) {
        const comtradeEnv = { COMTRADE_API_KEY: cfg.comtradeKey } as never;
        let comtrade: Awaited<ReturnType<typeof fetchComtrade>> | undefined;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            comtrade = await fetchComtrade(
              comtradeEnv,
              entity.iso3!,
              years,
              cfg.callPaceMs,
              settings,
            );
            break;
          } catch (err) {
            if (!(err instanceof RateLimited) || attempt === 2) throw err;
            const waitSeconds = Math.max(60, err.retryAfterSeconds ?? 60 * (attempt + 1));
            console.log(`rate limited; waiting ${waitSeconds}s before retry`);
            await sleep(waitSeconds * 1000);
          }
        }
        if (!comtrade) throw new Error('Comtrade validation retry loop exhausted');
        printComtradeValidation(entity.iso3!, entity.name, comtrade);
        if (comtrade.ok) ok++; else failed++;
        factsTotal += comtrade.rows.length;
        console.log(`Validation completed in ${((Date.now() - t0) / 1000).toFixed(0)}s`);
        continue;
      }

      // Recompute-only path. Reads the facts already stored and runs the
      // analysis over them, contacting no source at all. This is what makes a
      // maths fix cheap: the expensive part of a run is the fetch, and the
      // fetch has not changed.
      if (cfg.reanalyse) {
        const rows = await api.storedFacts(entity.slug);
        if (rows.length === 0) {
          console.log('no stored facts, nothing to recompute');
          skipped++;
          continue;
        }

        // The World Bank context is small and free, so it is refetched rather
        // than stored. If it is unavailable the services section is thinner,
        // which is visible, rather than wrong.
        const worldbank = await fetchWorldBank(entity.iso3!, years).catch(() => null);
        const classifications = await loadOpportunityClassifications(api, entity.slug);

        const bundle = analyse(
          entity.name,
          rows,
          worldbank?.context ?? {
            gdp_by_year: {},
            services_export_by_year: {},
            services_import_by_year: {},
            gns_export_by_year: {},
            gns_import_by_year: {},
          },
          ['un-comtrade', ...(worldbank?.ok ? [worldbank.source_ref] : [])],
          // Truncation is a property of the fetch, which is not being redone.
          // Passing none is the conservative choice: it means growth is
          // computed wherever the noise floors allow, and those floors are the
          // real guard.
          [],
          settings,
          entity.iso3 ?? null,
          classifications,
        );

        if (cfg.dryRun) {
          const o = bundle.overview;
          console.log(
            `recomputed only. ${rows.length} stored rows, ${o.year}: ` +
              `X $${(o.export_usd / 1e9).toFixed(1)}bn M $${(o.import_usd / 1e9).toFixed(1)}bn`,
          );
          ok++;
          continue;
        }

        await api.commit({
          slug: entity.slug,
          run_id: runId,
          // No fingerprint and no coverage change: neither the source nor the
          // facts moved, only the maths applied to them.
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
        await api.productAnalytics(entity.slug, bundle.product_analytics);

        const o = bundle.overview;
        console.log(
          `recomputed from ${rows.length} stored rows, ${o.year}: ` +
            `X $${(o.export_usd / 1e9).toFixed(1)}bn M $${(o.import_usd / 1e9).toFixed(1)}bn ` +
            `(${((Date.now() - t0) / 1000).toFixed(0)}s)`,
        );
        ok++;
        continue;
      }

      const worldbank = await fetchWorldBank(entity.iso3!, years).catch(() => ({
        ok: false,
        source_ref: 'world-bank',
        rows: [],
        context: {
          gdp_by_year: {},
          services_export_by_year: {},
          services_import_by_year: {},
          gns_export_by_year: {},
          gns_import_by_year: {},
        },
        note: 'World Bank context unavailable',
        meta: {},
      }));

      // UN Comtrade is the primary trade-data source. National country sources
      // remain available as contextual/enrichment sources, but they are not
      // used as the trade-data authority or as a silent fallback.
      // Comtrade is called directly by this local cron process. The Worker is
      // only used below for D1 storage/publishing. If Comtrade temporarily
      // rate-limits this machine, wait for the provider's retry window and
      // retry the request rather than aborting the whole country immediately.
      const comtradeEnv = { COMTRADE_API_KEY: cfg.comtradeKey } as never;
      const comtradeProbe = async () => {
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            return await probeComtrade(comtradeEnv, entity.iso3!, candidateYears);
          } catch (err) {
            if (!(err instanceof RateLimited) || attempt === 2) throw err;
            const waitSeconds = err.retryAfterSeconds ?? Math.min(60 * (attempt + 1), 180);
            console.log(`rate limited; waiting ${waitSeconds}s before retry`);
            await sleep(waitSeconds * 1000);
          }
        }
        throw new Error('Comtrade probe retry loop exhausted');
      };
      const probe = await comtradeProbe();
      const fingerprint = JSON.stringify({
        y: probe.year ?? null,
        x: probe.export_usd ?? null,
        m: probe.import_usd ?? null,
        wb: (worldbank.meta as Record<string, unknown> | undefined)?.lastupdated ?? null,
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

      let comtrade: Awaited<ReturnType<typeof fetchComtrade>> | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          comtrade = await fetchComtrade(
            comtradeEnv,
            entity.iso3!,
            years,
            cfg.callPaceMs,
            settings,
          );
          break;
        } catch (err) {
          if (!(err instanceof RateLimited) || attempt === 2) throw err;
          const waitSeconds = err.retryAfterSeconds ?? Math.min(60 * (attempt + 1), 180);
          console.log(`rate limited; waiting ${waitSeconds}s before retry`);
          await sleep(waitSeconds * 1000);
        }
      }
      if (!comtrade) throw new Error('Comtrade fetch retry loop exhausted');
      const rows: FactRow[] = [...comtrade.rows, ...worldbank.rows];
      if (rows.length === 0 || !comtrade.ok) {
        throw new Error(`UN Comtrade ingestion failed: ${comtrade.note}`);
      }

      const sourceAttempts: SourceAttempt[] = [{
        source_id: null,
        source_ref: comtrade.source_ref,
        role: 'primary',
        parser_key: 'comtrade',
        url: 'https://comtradeapi.un.org/data/v1/get/C/A/HS',
        status: comtrade.ok ? 'ok' : 'failed',
        rows_written: comtrade.rows.length,
        note: comtrade.note,
      }];
      sourceAttempts.push({
        source_id: null,
        source_ref: worldbank.source_ref,
        role: 'validator',
        parser_key: 'world-bank',
        url: 'https://api.worldbank.org/v2',
        status: worldbank.ok ? 'ok' : 'failed',
        rows_written: worldbank.rows.length,
        note: worldbank.note,
      });

      const sourceRefs = [
        comtrade.source_ref,
        ...(worldbank.ok ? [worldbank.source_ref] : []),
      ];
      const classifications = await loadOpportunityClassifications(api, entity.slug);
      const bundle = analyse(
        entity.name,
        rows,
        worldbank.context,
        sourceRefs,
        comtrade.truncated_years ?? [],
        settings,
        entity.iso3 ?? null,
        classifications,
      );

      const coverage =
        (comtrade.ok ? 0.75 : 0) +
        (worldbank.ok ? 0.10 : 0) +
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
          fingerprint: probe?.ok ? fingerprint : undefined,
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
        source_attempts: sourceAttempts,
      });
      await api.productAnalytics(entity.slug, bundle.product_analytics);

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
      // Rate limiting is not this country's problem, it is the whole run's.
      // Carrying on would write a partial fetch for every remaining country,
      // which reads as data but is a country with most of its products
      // missing. Stop here and leave the rest untouched so a later run can
      // pick them up intact.
      if (err instanceof RateLimited) {
        rateLimited = err;
        console.log('RATE LIMITED');
        if (!cfg.dryRun) {
          await api.fail(entity.slug, 'Source rate limited this address').catch(() => undefined);
        }
        break;
      }
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

    // Prices can only be compared once every country in this pass has been
    // through, so the cross-country ratio is settled here rather than per
    // country.
    if (ok > 0) {
      try {
        const priced = await api.priceRatios();
        console.log(`Prices: ${priced.priced} product rows compared to the world median`);
      } catch (err) {
        console.log(`Price comparison skipped: ${err instanceof Error ? err.message : err}`);
      }
    }

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

  if (rateLimited) {
    const remaining = targets.length - ok - skipped - failed;
    console.log(`\nStopped early: ${rateLimited.message}`);
    console.log(
      `${remaining} country/countries were not completed and still hold whatever data they had before this run.`,
    );
    if (rateLimited.retryAfterSeconds) {
      console.log(`The source asked to be left alone for ${rateLimited.retryAfterSeconds}s.`);
    }
    console.log('Re-run without --force to pick up where this left off.');
  }

  // A run cut short by the source is not a success, but it is also not the
  // same as everything failing: exit 2 so a scheduler can tell them apart.
  process.exit(rateLimited ? 2 : failed > 0 && ok === 0 ? 1 : 0);
}

main().catch((err) => {
  console.error('\nPipeline crashed:', err);
  process.exit(1);
});
