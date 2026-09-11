/**
 * Ghana ingestion and the opportunities API.
 *
 * The admin route runs the pipeline. The public routes serve what it stored.
 * A user opening the app never triggers a fetch from StatBank: they read
 * precomputed rows, which is what makes the page fast and what keeps somebody
 * else's government API from being hit on every page view.
 */
import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
// No provider import here on purpose. This file only writes what the local
// pipeline computed, so it has no path to an external source and therefore no
// way to substitute one.
import { ACTIVE_COUNTRIES, GHANA } from '../providers/countries/ghana';
import { computeMetrics } from '../analytics/metrics';
import { buildOpportunities } from '../analytics/opportunities';
import type { TradeFlow, TradeObservation } from '../providers/types';

export const ghana = new Hono<{ Bindings: Env }>();

// D1 refuses a statement carrying more than this many bound parameters.
const D1_MAX_BOUND_PARAMS = 100;

/** SHA-256 of a response body, so a repeat run is visible without diffing it. */
async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Store a finished run.
 *
 * The fetching and the analysis happen in local/ghana.mjs, in Node. A Worker
 * has a subrequest budget and a short wall clock, and a full Ghana run is 96
 * sequential calls to somebody else's government API, so the Worker's job is to
 * receive the result and write it down. This is the same split the Comtrade
 * pipeline already uses, and it is also why a user opening the app never causes
 * a call to StatBank.
 *
 * This route writes only. It never fetches, so it cannot silently substitute a
 * source: whatever arrives here was produced by a provider that named itself.
 */
ghana.post('/store', async (c) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;

  const body = (await c.req.json().catch(() => null)) as StorePayload | null;
  if (!body) return bad('Expected a JSON body.');
  if (!body.country || !body.flow) return bad('country and flow are required.');
  if (!Array.isArray(body.observations) || !body.observations.length) {
    return bad('No observations to store. A run with nothing in it is a failed run.');
  }

  const config = ACTIVE_COUNTRIES[body.country];
  if (!config) return bad(`No active configuration for ${body.country}.`, 404);

  const runId = uid('run_');
  const now = new Date().toISOString();

  await c.env.DB.prepare(
    `INSERT INTO ingestion_runs
       (id, country_code, provider, started_at, completed_at, status, records_received,
        records_processed, records_rejected, years_requested, partners_requested,
        products_requested, endpoint, query_json)
     VALUES (?,?,?,?,?,'running',?,?,?,?,?,?,?,?)`,
  )
    .bind(
      runId,
      body.country,
      'ghana-statbank',
      body.started_at ?? now,
      now,
      body.records_received ?? body.observations.length,
      body.observations.length,
      body.records_rejected ?? 0,
      (body.years ?? []).join(','),
      body.partners_requested ?? 0,
      new Set(body.observations.map((o) => o.product_code)).size,
      body.endpoint ?? config.provider.endpoint,
      JSON.stringify({ flow: body.flow, years: body.years }),
    )
    .run();

  try {
    await storeRaw(c.env, runId, config, body.raw ?? []);
    await storeObservations(c.env, runId, body.observations);
    await storeMetricsAndOpportunities(
      c.env, runId, body.country, body.metrics ?? [], body.opportunities ?? [],
    );
  } catch (err) {
    // A partial write is worse than a failed one: the dashboard would show
    // half a refresh and call it current. The run is marked failed so the
    // previous successful run stays the one being served.
    const message = err instanceof Error ? err.message : String(err);
    await c.env.DB.prepare(
      `UPDATE ingestion_runs SET status='failed', error_message=? WHERE id=?`,
    )
      .bind(message.slice(0, 2000), runId)
      .run();
    return bad(`Storing failed and the run was marked failed: ${message}`, 500);
  }

  await c.env.DB.prepare(`UPDATE ingestion_runs SET status='ok' WHERE id=?`).bind(runId).run();

  return json({
    run_id: runId,
    status: 'ok',
    observations_written: body.observations.length,
    metrics_written: (body.metrics ?? []).length,
    opportunities_written: (body.opportunities ?? []).length,
  });
});

interface StorePayload {
  country: string;
  flow: TradeFlow;
  started_at?: string;
  endpoint?: string;
  years?: string[];
  partners_requested?: number;
  records_received?: number;
  records_rejected?: number;
  observations: TradeObservation[];
  metrics?: ReturnType<typeof computeMetrics>;
  opportunities?: ReturnType<typeof buildOpportunities>;
  raw?: Array<{ endpoint: string; request: unknown; http_status: number; content_type: string | null; body: string }>;
  notes?: string[];
}

async function storeRaw(
  env: Env,
  runId: string,
  config: typeof GHANA,
  raw: Array<{ endpoint: string; request: unknown; http_status: number; content_type: string | null; body: string }>,
) {
  for (const r of raw) {
    await env.DB.prepare(
      `INSERT INTO raw_trade_data
         (id, run_id, country_code, provider, endpoint, request_json, http_status,
          content_type, body, body_bytes, body_sha256, retrieved_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
    )
      .bind(
        uid('raw_'),
        runId,
        config.code,
        'statbank',
        r.endpoint,
        JSON.stringify(r.request),
        r.http_status,
        r.content_type,
        r.body,
        r.body.length,
        await sha256(r.body),
        new Date().toISOString(),
      )
      .run();
  }
}

async function storeObservations(env: Env, runId: string, rows: TradeObservation[]) {
  const COLS = 19;
  const perStatement = Math.floor(D1_MAX_BOUND_PARAMS / COLS);
  const statements = [];

  for (let i = 0; i < rows.length; i += perStatement) {
    const slice = rows.slice(i, i + perStatement);
    const placeholders = slice.map(() => `(${Array(COLS).fill('?').join(',')})`).join(',');
    const binds: unknown[] = [];
    for (const o of slice) {
      binds.push(
        uid('obs_'), o.country_code, o.year, o.month, o.trade_flow,
        o.classification_system, o.classification_level, o.product_code, o.product_description,
        o.partner_country, o.partner_iso3, o.import_value_usd, o.net_weight_kg,
        o.value_is_derived ? 1 : 0, o.months_counted, o.source, o.source_endpoint,
        runId, o.retrieved_at,
      );
    }
    // Idempotent by the stated grain: running the same ingest twice updates the
    // figures rather than doubling them.
    statements.push(
      env.DB.prepare(
        `INSERT INTO trade_observations
           (id, country_code, year, month, trade_flow, classification_system,
            classification_level, product_code, product_description, partner_country,
            partner_iso3, import_value_usd, net_weight_kg, value_is_derived,
            months_counted, source, source_endpoint, run_id, retrieved_at)
         VALUES ${placeholders}
         ON CONFLICT (country_code, year, month, trade_flow, classification_system,
                      classification_level, product_code, partner_country, source)
         DO UPDATE SET
           import_value_usd = excluded.import_value_usd,
           net_weight_kg    = excluded.net_weight_kg,
           value_is_derived = excluded.value_is_derived,
           months_counted   = excluded.months_counted,
           run_id           = excluded.run_id,
           retrieved_at     = excluded.retrieved_at`,
      ).bind(...binds),
    );
  }

  for (let i = 0; i < statements.length; i += 25) {
    await env.DB.batch(statements.slice(i, i + 25));
  }
}

async function storeMetricsAndOpportunities(
  env: Env,
  runId: string,
  countryCode: string,
  metrics: ReturnType<typeof computeMetrics>,
  opportunities: ReturnType<typeof buildOpportunities>,
) {
  const now = new Date().toISOString();
  const metricIds = new Map<string, string>();

  for (const m of metrics) {
    const key = `${m.trade_flow}|${m.classification_level}|${m.product_code}`;
    // Reuse the existing row's id when this product has been stored before.
    // An upsert keeps the original id, so generating a new one here and then
    // pointing an opportunity at it broke the foreign key on every re-run: the
    // second ingest failed with a constraint error and wrote nothing, while the
    // first run's data sat there looking current.
    const existing = await env.DB.prepare(
      `SELECT id FROM opportunity_metrics
        WHERE country_code = ? AND trade_flow = ? AND classification_level = ?
          AND product_code = ? AND latest_year = ?`,
    )
      .bind(countryCode, m.trade_flow, m.classification_level, m.product_code, m.latest_year)
      .first<{ id: string }>();

    const id = existing?.id ?? uid('met_');
    metricIds.set(key, id);
    await env.DB.prepare(
      `INSERT INTO opportunity_metrics
         (id, country_code, trade_flow, classification_system, classification_level,
          product_code, product_description, latest_year, years_available, earliest_year,
          import_value_usd, net_weight_kg, unit_value_usd_per_kg, yoy_value_pct,
          yoy_volume_pct, cagr_3y_pct, cagr_5y_pct, trend, volatility_pct, top_partner,
          top_partner_share_pct, supplier_hhi, partner_count, partner_shares_json,
          limitations_json, run_id, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (country_code, trade_flow, classification_level, product_code, latest_year)
       DO UPDATE SET
         import_value_usd = excluded.import_value_usd,
         net_weight_kg = excluded.net_weight_kg,
         unit_value_usd_per_kg = excluded.unit_value_usd_per_kg,
         yoy_value_pct = excluded.yoy_value_pct,
         cagr_3y_pct = excluded.cagr_3y_pct,
         cagr_5y_pct = excluded.cagr_5y_pct,
         trend = excluded.trend,
         volatility_pct = excluded.volatility_pct,
         top_partner = excluded.top_partner,
         top_partner_share_pct = excluded.top_partner_share_pct,
         supplier_hhi = excluded.supplier_hhi,
         partner_count = excluded.partner_count,
         partner_shares_json = excluded.partner_shares_json,
         limitations_json = excluded.limitations_json,
         run_id = excluded.run_id,
         computed_at = excluded.computed_at`,
    )
      .bind(
        id, countryCode, m.trade_flow, 'HS', m.classification_level,
        m.product_code, m.product_description, m.latest_year, m.years_available, m.earliest_year,
        m.import_value_usd, m.net_weight_kg, m.unit_value_usd_per_kg, m.yoy_value_pct,
        m.yoy_volume_pct, m.cagr_3y_pct, m.cagr_5y_pct, m.trend, m.volatility_pct, m.top_partner,
        m.top_partner_share_pct, m.supplier_hhi, m.partner_count, JSON.stringify(m.partner_shares),
        JSON.stringify(m.limitations), runId, now,
      )
      .run();
  }

  for (const o of opportunities) {
    const metricId = metricIds.get(`${o.trade_flow}|${o.classification_level}|${o.product_code}`);
    if (!metricId) continue;
    await env.DB.prepare(
      `INSERT INTO opportunities
         (id, country_code, metric_id, trade_flow, classification_system, classification_level,
          product_code, product_name, opportunity_score, score_breakdown_json, signal_type,
          data_confidence, confidence_reasons_json, explanation, evidence_json,
          limitations_json, is_excluded, excluded_reason, source, source_endpoint,
          run_id, computed_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON CONFLICT (country_code, trade_flow, classification_level, product_code)
       DO UPDATE SET
         metric_id = excluded.metric_id,
         opportunity_score = excluded.opportunity_score,
         score_breakdown_json = excluded.score_breakdown_json,
         signal_type = excluded.signal_type,
         data_confidence = excluded.data_confidence,
         confidence_reasons_json = excluded.confidence_reasons_json,
         explanation = excluded.explanation,
         evidence_json = excluded.evidence_json,
         limitations_json = excluded.limitations_json,
         is_excluded = excluded.is_excluded,
         excluded_reason = excluded.excluded_reason,
         run_id = excluded.run_id,
         computed_at = excluded.computed_at`,
    )
      .bind(
        uid('opp_'), countryCode, metricId, o.trade_flow, 'HS', o.classification_level,
        o.product_code, o.product_name, o.opportunity_score, JSON.stringify(o.score_breakdown),
        o.signal_type, o.data_confidence, JSON.stringify(o.confidence_reasons), o.explanation,
        JSON.stringify(o.evidence), JSON.stringify(o.limitations), o.is_excluded ? 1 : 0,
        o.excluded_reason, 'Ghana Statistical Service', GHANA.provider.endpoint, runId, now,
      )
      .run();
  }
}

// --- public reads -----------------------------------------------------------

/**
 * The opportunities, as the frontend consumes them.
 *
 * Serves stored rows. Nothing here calls StatBank, so a user opening the page
 * is reading a database rather than waiting on somebody else's API.
 */
ghana.get('/opportunities', async (c) => {
  const country = c.req.query('country') ?? 'GH';
  const flow = c.req.query('flow') ?? 'import';
  const includeExcluded = c.req.query('include_excluded') === 'true';
  const limit = Math.min(Number(c.req.query('limit') ?? 50), 200);

  const { results } = await c.env.DB.prepare(
    `SELECT o.*, m.latest_year, m.years_available, m.import_value_usd, m.net_weight_kg,
            m.unit_value_usd_per_kg, m.cagr_3y_pct, m.cagr_5y_pct, m.yoy_value_pct,
            m.trend, m.top_partner, m.top_partner_share_pct, m.supplier_hhi,
            m.partner_count, m.partner_shares_json
       FROM opportunities o
       JOIN opportunity_metrics m ON m.id = o.metric_id
      WHERE o.country_code = ? AND o.trade_flow = ?
        AND (? = 1 OR o.is_excluded = 0)
      ORDER BY o.opportunity_score DESC
      LIMIT ?`,
  )
    .bind(country, flow, includeExcluded ? 1 : 0, limit)
    .all<Record<string, unknown>>();

  // The freshness of what is being served, said plainly. A dashboard that
  // cannot say how old it is invites the reader to assume it is current.
  const lastGood = await c.env.DB.prepare(
    `SELECT id, completed_at, records_processed FROM ingestion_runs
      WHERE country_code = ? AND status = 'ok'
      ORDER BY completed_at DESC LIMIT 1`,
  )
    .bind(country)
    .first<{ id: string; completed_at: string; records_processed: number }>();

  const lastAttempt = await c.env.DB.prepare(
    `SELECT id, status, started_at, completed_at, error_message FROM ingestion_runs
      WHERE country_code = ? ORDER BY started_at DESC LIMIT 1`,
  )
    .bind(country)
    .first<{ id: string; status: string; started_at: string; completed_at: string | null; error_message: string | null }>();

  return json({
    country,
    flow,
    source: 'Ghana Statistical Service',
    source_endpoint: GHANA.provider.endpoint,
    classification: `${GHANA.classification.system}${GHANA.classification.level.replace('HS', '')}`,
    last_successful_run: lastGood ?? null,
    last_attempt: lastAttempt ?? null,
    // True when the newest attempt failed, so the UI can say the figures are
    // the last good ones rather than implying they are fresh.
    serving_stale: !!(lastAttempt && lastAttempt.status === 'failed'),
    count: results?.length ?? 0,
    opportunities: (results ?? []).map(shapeOpportunity),
  });
});

ghana.get('/runs', async (c) => {
  const country = c.req.query('country') ?? 'GH';
  const { results } = await c.env.DB.prepare(
    `SELECT id, provider, started_at, completed_at, status, records_received,
            records_processed, records_rejected, error_message
       FROM ingestion_runs WHERE country_code = ?
      ORDER BY started_at DESC LIMIT 20`,
  )
    .bind(country)
    .all();
  return json({ country, runs: results ?? [] });
});

function shapeOpportunity(r: Record<string, unknown>) {
  const parse = (v: unknown) => {
    try {
      return typeof v === 'string' ? JSON.parse(v) : null;
    } catch {
      return null;
    }
  };
  return {
    product_code: r.product_code,
    product_name: r.product_name,
    classification: r.classification_level,
    trade_flow: r.trade_flow,
    latest_year: r.latest_year,
    years_available: r.years_available,
    latest_import_value: r.import_value_usd,
    latest_import_volume: r.net_weight_kg,
    unit_value_usd_per_kg: r.unit_value_usd_per_kg,
    yoy_value_pct: r.yoy_value_pct,
    three_year_cagr: r.cagr_3y_pct,
    five_year_cagr: r.cagr_5y_pct,
    trend: r.trend,
    top_partner: r.top_partner,
    top_partner_share_pct: r.top_partner_share_pct,
    supplier_concentration_hhi: r.supplier_hhi,
    partner_count: r.partner_count,
    partner_shares: parse(r.partner_shares_json) ?? [],
    opportunity_score: r.opportunity_score,
    score_breakdown: parse(r.score_breakdown_json),
    signal_type: r.signal_type,
    confidence: r.data_confidence,
    confidence_reasons: parse(r.confidence_reasons_json) ?? [],
    explanation: r.explanation,
    evidence: parse(r.evidence_json) ?? [],
    data_limitations: parse(r.limitations_json) ?? [],
    is_excluded: r.is_excluded === 1,
    excluded_reason: r.excluded_reason,
    source: r.source,
  };
}
