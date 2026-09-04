import type { Env } from '../lib/db';
import { uid } from '../lib/db';
import { fetchComtrade } from './adapters/comtrade';
import { fetchWorldBank } from './adapters/worldbank';
import { analyse } from './analyse';
import type { FactRow } from './types';

/**
 * How many entities one invocation will process.
 *
 * Cloudflare caps subrequests per invocation (50 on the free plan, 1000 on
 * paid). Keyless, each country costs ~23 fetches because the Comtrade preview
 * endpoint only accepts one year per call. With COMTRADE_API_KEY set that drops
 * to ~9 and the paid budget applies. Entities are processed oldest-first so
 * coverage rotates fairly rather than always refreshing the same few.
 */
const MAX_ENTITIES_FREE = 2;
const MAX_ENTITIES_PAID = 90;
const YEARS_BACK = 6;

export interface RunResult {
  run_id: string;
  status: 'ok' | 'partial' | 'failed';
  entities_total: number;
  entities_ok: number;
  entities_failed: number;
  facts_written: number;
  processed: string[];
  errors: { slug: string; error: string }[];
}

export async function runAnalysis(
  env: Env,
  trigger: 'cron' | 'manual' | 'backfill' = 'cron',
  onlySlug?: string,
): Promise<RunResult> {
  const runId = uid('run_');
  await env.DB.prepare(
    `INSERT INTO analysis_runs (id, trigger, status) VALUES (?, ?, 'running')`,
  )
    .bind(runId, trigger)
    .run();

  const budget = env.COMTRADE_API_KEY ? MAX_ENTITIES_PAID : MAX_ENTITIES_FREE;
  const limit = onlySlug ? 1 : budget;

  const { results: targets } = await env.DB.prepare(
    onlySlug
      ? `SELECT * FROM entities WHERE (slug = ? OR id = ?) LIMIT 1`
      : `SELECT * FROM entities
           WHERE is_active = 1 AND kind = 'country' AND iso3 IS NOT NULL
           ORDER BY COALESCE(last_ingest_at, '1970-01-01') ASC
           LIMIT ?`,
  )
    .bind(...(onlySlug ? [onlySlug, onlySlug] : [limit]))
    .all<{ id: string; slug: string; name: string; iso3: string }>();

  const entities = targets ?? [];
  const thisYear = new Date().getUTCFullYear();
  // Trade statistics lag; asking for the current year returns nothing useful.
  const years = Array.from({ length: YEARS_BACK }, (_, i) => thisYear - 1 - i).reverse();

  const result: RunResult = {
    run_id: runId,
    status: 'ok',
    entities_total: entities.length,
    entities_ok: 0,
    entities_failed: 0,
    facts_written: 0,
    processed: [],
    errors: [],
  };

  for (const entity of entities) {
    try {
      const written = await processEntity(env, runId, entity, years);
      result.facts_written += written;
      result.entities_ok++;
      result.processed.push(entity.slug);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      result.entities_failed++;
      result.errors.push({ slug: entity.slug, error: message });
      await env.DB.prepare(
        `UPDATE entities SET last_error = ?, updated_at = datetime('now') WHERE id = ?`,
      )
        .bind(message.slice(0, 500), entity.id)
        .run();
    }
  }

  result.status =
    result.entities_failed === 0
      ? 'ok'
      : result.entities_ok === 0
        ? 'failed'
        : 'partial';

  await env.DB.prepare(
    `UPDATE analysis_runs
        SET finished_at = datetime('now'), status = ?, entities_total = ?,
            entities_ok = ?, entities_failed = ?, facts_written = ?, log = ?
      WHERE id = ?`,
  )
    .bind(
      result.status,
      result.entities_total,
      result.entities_ok,
      result.entities_failed,
      result.facts_written,
      JSON.stringify({ processed: result.processed, errors: result.errors }).slice(0, 8000),
      runId,
    )
    .run();

  return result;
}

async function processEntity(
  env: Env,
  runId: string,
  entity: { id: string; slug: string; name: string; iso3: string },
  years: number[],
): Promise<number> {
  const [comtrade, worldbank] = await Promise.all([
    fetchComtrade(env, entity.iso3, years),
    fetchWorldBank(entity.iso3, years),
  ]);

  const rows: FactRow[] = [...comtrade.rows, ...worldbank.rows];
  const sourceRefs = [
    ...(comtrade.ok ? [comtrade.source_ref] : []),
    ...(worldbank.ok ? [worldbank.source_ref] : []),
  ];

  if (rows.length === 0) {
    throw new Error(`No data returned. ${comtrade.note} | ${worldbank.note}`);
  }

  await replaceFacts(env, entity.id, rows);

  const bundle = analyse(entity.name, rows, worldbank.context, sourceRefs);

  const stmts: D1PreparedStatement[] = [];
  const put = (kind: string, payload: unknown) =>
    stmts.push(
      env.DB.prepare(
        `INSERT INTO analysis_results (id, entity_id, run_id, kind, payload, computed_at)
         VALUES (?, ?, ?, ?, ?, datetime('now'))
         ON CONFLICT (entity_id, kind) DO UPDATE SET
           payload = excluded.payload,
           run_id = excluded.run_id,
           computed_at = excluded.computed_at`,
      ).bind(uid('res_'), entity.id, runId, kind, JSON.stringify(payload)),
    );

  put('overview', bundle.overview);
  put('top_exports', bundle.top_exports);
  put('top_imports', bundle.top_imports);
  put('services', bundle.services);
  put('partners_export', bundle.partners_export);
  put('partners_import', bundle.partners_import);
  put('yearly_trend', bundle.yearly_trend);
  put('recommendations', bundle.recommendations);

  stmts.push(env.DB.prepare('DELETE FROM opportunity_signals WHERE entity_id = ?').bind(entity.id));
  for (const s of bundle.signals) {
    stmts.push(
      env.DB.prepare(
        `INSERT INTO opportunity_signals
           (id, entity_id, hs_code, product_name, flow, cagr_3y, momentum,
            current_rank, projected_rank, horizon_years, confidence, rationale, run_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        uid('sig_'),
        entity.id,
        s.hs_code,
        s.product_name,
        s.flow,
        s.cagr_3y,
        s.momentum,
        s.current_rank,
        s.projected_rank,
        s.horizon_years,
        s.confidence,
        s.rationale,
        runId,
      ),
    );
  }

  // Coverage: how much of the picture we actually managed to fill in.
  const coverage =
    (comtrade.ok ? 0.6 : 0) +
    (worldbank.ok ? 0.25 : 0) +
    (bundle.yearly_trend.length >= 4 ? 0.15 : 0);

  stmts.push(
    env.DB.prepare(
      `UPDATE entities
          SET last_ingest_at = datetime('now'), last_error = NULL,
              coverage_score = ?, updated_at = datetime('now')
        WHERE id = ?`,
    ).bind(coverage, entity.id),
  );

  await env.DB.batch(stmts);
  return rows.length;
}

/** Replace rather than append so a re-run never double counts. */
async function replaceFacts(env: Env, entityId: string, rows: FactRow[]) {
  await env.DB.prepare('DELETE FROM trade_facts WHERE entity_id = ?').bind(entityId).run();

  const CHUNK = 40;
  for (let i = 0; i < rows.length; i += CHUNK) {
    const chunk = rows.slice(i, i + CHUNK);
    await env.DB.batch(
      chunk.map((r) =>
        env.DB.prepare(
          `INSERT INTO trade_facts
             (entity_id, year, flow, stream, partner_iso3, partner_name,
              hs_code, product_name, sector, value_usd, qty, qty_unit, source_ref)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).bind(
          entityId,
          r.year,
          r.flow,
          r.stream,
          r.partner_iso3,
          r.partner_name,
          r.hs_code,
          r.product_name,
          r.sector,
          r.value_usd,
          r.qty ?? null,
          r.qty_unit ?? null,
          r.source_ref,
        ),
      ),
    );
  }
}
