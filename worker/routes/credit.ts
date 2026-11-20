import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { ISO3_NAME } from '../../shared/country-names';
import { buildXlsx, type Sheet } from '../lib/xlsx';
import cfg from '../../templates/credit_config.json';

/**
 * Sectoral credit intelligence: where bank credit is outstanding across the economy and how that stock changes.
 *
 * The Worker only reads what the pipeline has stored and calculated (oracle/tereflow_oracle/credit*.py). Fetching and the
 * heavy calculation do not fit the free plan's CPU limit, so an admin's "Run now" records a request that the pipeline picks up.
 * Every figure here is a stored observation or a calculation from stored observations. No AI, no estimates.
 */
export const credit = new Hono<{ Bindings: Env }>();
export const creditAdmin = new Hono<{ Bindings: Env }>();

const ISO3 = /^[A-Z]{3}$/;
const SERIES_COLS = 'id, country_iso3, source_key, source_name, databank, dataflow, mnemonic, series_name, data_family, sector_key, sector_name, series_role, currency, unit_label, unit_multiplier, unit_verified, frequency, first_obs, latest_obs, obs_count, is_active, measure_kind, kind_basis, definition_notes, endpoint_url, sort_order, last_fetch_at, fetch_status, fetch_error';

interface CountrySource { country_iso3: string; preferred_source: string; currency: string | null; national_available: number; imf_available: number; in_use: string | null; status: string | null; status_note: string | null; is_active: number; checked_at: string | null }

function parseSummary(payload: unknown): unknown {
  if (typeof payload !== 'string') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

// ---- public -----------------------------------------------------------------------------------------------------

credit.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT country_iso3, preferred_source, national_available, imf_available, in_use, status, status_note, checked_at FROM cr_country_sources WHERE is_active = 1 ORDER BY country_iso3').all<CountrySource>();
  const countries = (results ?? []).map((r) => ({ ...r, country_name: ISO3_NAME[r.country_iso3] ?? r.country_iso3 }));
  return json({ countries }, 200, { 'cache-control': 'public, max-age=300' });
});

credit.get('/:iso3', async (c) => {
  const iso3 = c.req.param('iso3').toUpperCase();
  if (!ISO3.test(iso3)) return bad('country must be an ISO3 code');
  const [cs, sums, series, flags, map, ent, run] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT country_iso3, preferred_source, currency, national_available, imf_available, in_use, status, status_note, checked_at FROM cr_country_sources WHERE country_iso3 = ?').bind(iso3),
    c.env.DB.prepare('SELECT source_key, payload, computed_at FROM cr_summary WHERE country_iso3 = ?').bind(iso3),
    c.env.DB.prepare(`SELECT ${SERIES_COLS} FROM cr_series WHERE country_iso3 = ? AND is_active = 1 ORDER BY source_key, sort_order`).bind(iso3),
    c.env.DB.prepare('SELECT series_id, flag_code, since_period, message FROM cr_flags WHERE series_id LIKE ?').bind(`${iso3}:%`),
    c.env.DB.prepare('SELECT sector_key, trade_scope, hs_prefixes, trade_flow, confidence, note FROM cr_sector_map WHERE is_active = 1'),
    c.env.DB.prepare("SELECT slug FROM entities WHERE kind = 'country' AND iso3 = ?").bind(iso3),
    c.env.DB.prepare('SELECT id, trigger, status, started_at, finished_at, series_ok, series_failed, obs_new, obs_revised FROM cr_runs WHERE finished_at IS NOT NULL ORDER BY finished_at DESC FETCH FIRST 1 ROWS ONLY'),
  ]);
  const source = ((cs.results ?? [])[0] ?? null) as CountrySource | null;
  if (!source) return bad('No credit data is configured for this country', 404);
  const summaries: Record<string, unknown> = {};
  for (const r of (sums.results ?? []) as { source_key: string; payload: string }[]) summaries[r.source_key] = parseSummary(r.payload);
  const slug = ((ent.results ?? [])[0] as { slug: string } | undefined)?.slug ?? null;
  return json({
    country: { iso3, name: ISO3_NAME[iso3] ?? iso3, slug },
    source,
    primary: source.in_use,
    summaries,
    series: series.results ?? [],
    flags: flags.results ?? [],
    sector_map: Object.fromEntries(((map.results ?? []) as { sector_key: string }[]).map((m) => [m.sector_key, m])),
    last_run: ((run.results ?? [])[0] as unknown) ?? null,
  }, 200, { 'cache-control': 'public, max-age=300' });
});

/** Full history of one series: stock, net change, percentage change, share and rank at every period. */
credit.get('/:iso3/history', async (c) => {
  const iso3 = c.req.param('iso3').toUpperCase();
  const id = c.req.query('series') ?? '';
  if (!ISO3.test(iso3) || !id.startsWith(`${iso3}:`) || id.length > 160) return bad('Give a series id for this country');
  const [meta, rows, rev] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${SERIES_COLS} FROM cr_series WHERE id = ? AND is_active = 1`).bind(id),
    c.env.DB.prepare('SELECT period, period_end, stock, prev_stock, net_change, pct_change, share_pct, rank_stock, rank_change, rank_pct, flag FROM cr_derived WHERE series_id = ? ORDER BY period').bind(id),
    c.env.DB.prepare('SELECT COUNT(*) AS n FROM cr_revisions WHERE series_id = ?').bind(id),
  ]);
  const m = (meta.results ?? [])[0];
  if (!m) return bad('Series not found', 404);
  return json({ series: m, history: rows.results ?? [], revisions: ((rev.results ?? [])[0] as { n: number } | undefined)?.n ?? 0 }, 200, { 'cache-control': 'public, max-age=300' });
});

// ---- admin ------------------------------------------------------------------------------------------------------

creditAdmin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

creditAdmin.get('/', async (c) => {
  const [series, countries, runs, map] = await c.env.DB.batch([
    c.env.DB.prepare(`SELECT ${SERIES_COLS} FROM cr_series ORDER BY country_iso3, source_key, sort_order`),
    c.env.DB.prepare('SELECT country_iso3, preferred_source, currency, national_available, imf_available, in_use, status, status_note, is_active, checked_at FROM cr_country_sources ORDER BY country_iso3'),
    c.env.DB.prepare('SELECT id, run_kind, trigger, requested_by, status, backfill, countries, requested_at, started_at, finished_at, series_ok, series_failed, obs_new, obs_revised, detail FROM cr_runs ORDER BY requested_at DESC FETCH FIRST 25 ROWS ONLY'),
    c.env.DB.prepare('SELECT sector_key, trade_scope, hs_prefixes, trade_flow, confidence, note, is_active FROM cr_sector_map ORDER BY sector_key'),
  ]);
  return json({ series: series.results ?? [], countries: countries.results ?? [], runs: runs.results ?? [], sector_map: map.results ?? [] });
});

const KINDS = ['stock', 'flow', 'unverified'];
const ROLES = ['total', 'sector', 'borrower_sector'];
const FREQS = ['M', 'Q', 'A'];

/** Add or edit a series. New series are Bank of Ghana style (the IMF ones are discovered by the pipeline, never typed in). */
creditAdmin.post('/series', async (c) => {
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return bad('Send a JSON body');
  const str = (k: string, max: number) => (typeof b[k] === 'string' && (b[k] as string).trim() ? (b[k] as string).trim().slice(0, max) : null);
  let id = str('id', 160);
  if (!id) {
    const iso = (str('country_iso3', 3) ?? '').toUpperCase();
    const mn = (str('mnemonic', 120) ?? '').toUpperCase();
    if (!ISO3.test(iso)) return bad('country_iso3 must be three capital letters');
    if (!/^[A-Z0-9_]{3,80}$/.test(mn)) return bad('mnemonic must be letters, digits and underscores, for example GHA_SAC_12');
    const sectorKey = (str('sector_key', 60) ?? '').toLowerCase();
    const sectorName = str('sector_name', 200);
    if (!/^[a-z0-9_]{2,60}$/.test(sectorKey) || !sectorName) return bad('sector_key (lowercase) and sector_name are required');
    const role = str('series_role', 20) ?? 'sector';
    if (!ROLES.includes(role)) return bad(`series_role must be one of ${ROLES.join(', ')}`);
    id = `${iso}:BOG:${mn}`;
    const exists = await c.env.DB.prepare('SELECT 1 AS x FROM cr_series WHERE id = ?').bind(id).first();
    if (exists) return bad('That series is already registered; edit it instead', 409);
    await c.env.DB.prepare(`INSERT INTO cr_series (id, country_iso3, source_key, source_name, databank, mnemonic, sector_key, sector_name, series_role, unit_multiplier, unit_verified, is_active, sort_order, definition_notes)
      VALUES (?, ?, 'BOG', 'Bank of Ghana (DataWarehousePro guest API)', 'MON', ?, ?, ?, ?, 1, 0, 1, ?, ?)`)
      .bind(id, iso, mn, sectorKey, sectorName.slice(0, 200), role, Number(b.sort_order) || 99, str('definition_notes', 3000)).run();
    return json({ id, note: 'Registered. Run a backfill to fetch its history; the unit is verified from the response.' }, 201);
  }
  const cur = await c.env.DB.prepare('SELECT id FROM cr_series WHERE id = ?').bind(id).first();
  if (!cur) return bad('Series not found', 404);
  const sets: string[] = [];
  const vals: unknown[] = [];
  const add = (col: string, v: unknown) => { sets.push(`${col} = ?`); vals.push(v); };
  if (typeof b.is_active === 'boolean' || b.is_active === 0 || b.is_active === 1) add('is_active', b.is_active ? 1 : 0);
  if (str('sector_name', 200)) add('sector_name', str('sector_name', 200));
  if (str('series_role', 20)) { if (!ROLES.includes(str('series_role', 20)!)) return bad('Unknown series_role'); add('series_role', str('series_role', 20)); }
  if ('definition_notes' in b) add('definition_notes', str('definition_notes', 3000));
  if (b.frequency !== undefined) { const f = str('frequency', 2); if (f && !FREQS.includes(f)) return bad('frequency must be M, Q or A'); if (f) add('frequency', f); }
  if (b.unit_multiplier !== undefined) { const n = Number(b.unit_multiplier); if (!Number.isFinite(n) || n <= 0) return bad('unit_multiplier must be a positive number'); add('unit_multiplier', n); add('unit_verified', 0); }
  if (b.measure_kind !== undefined) {
    const k = str('measure_kind', 12);
    if (!k || !KINDS.includes(k)) return bad(`measure_kind must be one of ${KINDS.join(', ')}`);
    add('measure_kind', k);
    add('kind_basis', 'admin');
  }
  if (!sets.length) return bad('Nothing to change');
  sets.push("updated_at = TO_CHAR(SYSTIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS')");
  await c.env.DB.prepare(`UPDATE cr_series SET ${sets.join(', ')} WHERE id = ?`).bind(...vals, id).run();
  return json({ id, ok: true, note: 'Saved. Net changes and rankings are recalculated at the next run.' });
});

/** Which countries are covered and which source each one prefers. */
creditAdmin.post('/country', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { country_iso3?: string; preferred_source?: string; is_active?: boolean; currency?: string } | null;
  const iso = (b?.country_iso3 ?? '').trim().toUpperCase();
  if (!ISO3.test(iso)) return bad('country_iso3 must be three capital letters');
  const pref = b?.preferred_source ?? 'auto';
  if (!['auto', 'both', 'national', 'imf'].includes(pref)) return bad('preferred_source must be auto, both, national or imf');
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM cr_country_sources WHERE country_iso3 = ?').bind(iso).first();
  const active = b?.is_active === false ? 0 : 1;
  const ccy = b?.currency?.trim().toUpperCase().slice(0, 10) || null;
  if (exists) await c.env.DB.prepare('UPDATE cr_country_sources SET preferred_source = ?, is_active = ?, currency = COALESCE(?, currency) WHERE country_iso3 = ?').bind(pref, active, ccy, iso).run();
  else await c.env.DB.prepare('INSERT INTO cr_country_sources (country_iso3, preferred_source, is_active, currency) VALUES (?, ?, ?, ?)').bind(iso, pref, active, ccy).run();
  return json({ ok: true, note: 'Saved. The source in use is decided at the next run.' });
});

/** The explicit map from a credit sector to TeraFlow's trade categories (HS chapters or codes). */
creditAdmin.post('/sector-map', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { sector_key?: string; trade_scope?: string; hs_prefixes?: string | null; trade_flow?: string; confidence?: string; note?: string; is_active?: boolean } | null;
  const key = (b?.sector_key ?? '').trim().toLowerCase();
  if (!/^[a-z0-9_]{2,60}$/.test(key)) return bad('sector_key is required');
  const scope = b?.trade_scope ?? 'none';
  if (!['hs', 'exports', 'imports', 'none'].includes(scope)) return bad('trade_scope must be hs, exports, imports or none');
  const hs = (b?.hs_prefixes ?? '').replace(/\s+/g, '');
  if (scope === 'hs' && !/^(\d{2,6})(,\d{2,6})*$/.test(hs)) return bad('hs_prefixes must be comma-separated HS codes of 2 to 6 digits');
  const flow = b?.trade_flow ?? 'both';
  if (!['X', 'M', 'both'].includes(flow)) return bad('trade_flow must be X, M or both');
  const conf = b?.confidence ?? 'none';
  if (!['direct', 'indicative', 'none'].includes(conf)) return bad('confidence must be direct, indicative or none');
  if (scope === 'none' && conf !== 'none') return bad('A sector with no trade mapping must have confidence none');
  const note = b?.note?.trim().slice(0, 1000) || null;
  const exists = await c.env.DB.prepare('SELECT 1 AS x FROM cr_sector_map WHERE sector_key = ?').bind(key).first();
  const act = b?.is_active === false ? 0 : 1;
  if (exists) await c.env.DB.prepare('UPDATE cr_sector_map SET trade_scope = ?, hs_prefixes = ?, trade_flow = ?, confidence = ?, note = ?, is_active = ? WHERE sector_key = ?').bind(scope, scope === 'hs' ? hs : null, flow, conf, note, act, key).run();
  else await c.env.DB.prepare('INSERT INTO cr_sector_map (sector_key, trade_scope, hs_prefixes, trade_flow, confidence, note, is_active) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(key, scope, scope === 'hs' ? hs : null, flow, conf, note, act).run();
  return json({ ok: true });
});

/**
 * Ask for a run. The Worker cannot fetch and analyse inside the free plan's CPU limit, so this records the request;
 * the pipeline (scheduled, or `pipeline.cmd credit`) picks it up and adopts it as its run record.
 */
creditAdmin.post('/run', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { countries?: string[]; backfill?: boolean } | null;
  const countries = (b?.countries ?? []).map((x) => String(x).trim().toUpperCase()).filter((x) => ISO3.test(x)).slice(0, 40);
  const open = await c.env.DB.prepare("SELECT id FROM cr_runs WHERE status = 'requested'").first<{ id: string }>();
  if (open) return json({ ok: true, id: open.id, already: true, note: 'A run is already waiting to be picked up.' });
  const id = uid('crr_');
  await c.env.DB.prepare("INSERT INTO cr_runs (id, run_kind, trigger, requested_by, status, backfill, countries, requested_at) VALUES (?, 'ingest', 'admin', 'admin', 'requested', ?, ?, TO_CHAR(SYSTIMESTAMP AT TIME ZONE 'UTC','YYYY-MM-DD HH24:MI:SS'))")
    .bind(id, b?.backfill ? 1 : 0, countries.join(',') || null).run();
  return json({ ok: true, id, note: 'Requested. It starts the next time the pipeline runs (the daily schedule, or `pipeline.cmd credit` on any PC with the Oracle wallet).' }, 201);
});

// ---- spreadsheet route ------------------------------------------------------------------------------------------

type Cell = string | number | null;
interface FileFormat { source_fields: [string, string][]; series_columns: [string, string][]; period_help: string; rules: string[]; example: { source: [string, string][]; series_header: string[]; series: Cell[][]; data_header: string[]; data: Cell[][] } }

/** The same workbook the pipeline's `credit-template` command writes, from the same block of credit_config.json. */
function templateSheets(ff: FileFormat): Sheet[] {
  const pad = (r: Cell[], n: number): Cell[] => [...r, ...Array(Math.max(0, n - r.length)).fill(null)];
  const ex = ff.example;
  return [
    { name: 'Source', widths: [20, 60], rows: [['field', 'value'], ...ff.source_fields.map(([k]) => [k, null] as Cell[])] },
    { name: 'Series', widths: [18, 20, 36, 10, 20, 22, 14, 60], rows: [ff.series_columns.map(([k]) => k)] },
    { name: 'Data', widths: [12], rows: [['period']] },
    {
      name: 'How to fill',
      widths: [26, 120],
      rows: [
        ['Sheet / column', 'What to enter'],
        ...ff.source_fields.map(([k, v]) => [`Source: ${k}`, v] as Cell[]),
        [null, null],
        ...ff.series_columns.map(([k, v]) => [`Series: ${k}`, v] as Cell[]),
        [null, null],
        ['Data: period', ff.period_help],
        ['Data: other columns', 'One column per mnemonic from the Series sheet, headed with exactly the same mnemonic. Paste plain numbers. A blank cell means the central bank published nothing for that period (it is never read as zero).'],
        [null, null],
        ...ff.rules.map((r) => ['Rule', r] as Cell[]),
      ],
    },
    {
      name: 'Example',
      widths: [20, 20, 36, 10, 20, 22, 14],
      rows: [
        pad(['EXAMPLE ONLY: do not load. Layout of a filled workbook.'], 7),
        pad(['Source sheet'], 7),
        ...ex.source.map(([k, v]) => pad([k, v], 7)),
        pad([], 7),
        pad(['Series sheet'], 7),
        pad(ex.series_header, 7),
        ...ex.series.map((r) => pad(r, 7)),
        pad([], 7),
        pad(['Data sheet'], 7),
        pad(['period', ...ex.data_header], 7),
        ...ex.data.map((r) => pad(r, 7)),
      ],
    },
  ];
}

creditAdmin.get('/template', () => {
  const xlsx = buildXlsx(templateSheets((cfg as unknown as { file_format: FileFormat }).file_format));
  return new Response(xlsx, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="tereflow-credit-template.xlsx"', 'cache-control': 'no-store' } });
});

/**
 * Uploaded workbooks wait in storage. The website cannot read Excel inside the free plan's CPU limit, so the pipeline opens them,
 * checks every cell, and loads or refuses each file (with the reasons kept next to it).
 */
const QUEUE_NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{1,90}\.xlsx$/;
const QUEUE_MAX = 5 * 1024 * 1024;

creditAdmin.get('/queue', async (c) => {
  const list = async (prefix: string) => (await c.env.MEDIA.list({ prefix, limit: 100 })).objects.filter((o) => !o.key.endsWith('.reason.txt')).map((o) => ({ name: o.key.slice(prefix.length), bytes: o.size, uploaded: o.uploaded.toISOString() }));
  const [pending, done, rejected] = await Promise.all([list('credit-inbox/pending/'), list('credit-inbox/done/'), list('credit-inbox/rejected/')]);
  const reasons = await Promise.all(rejected.slice(0, 8).map(async (r) => ({ ...r, reason: (await (await c.env.MEDIA.get(`credit-inbox/rejected/${r.name}.reason.txt`))?.text())?.slice(0, 1500) ?? null })));
  done.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  rejected.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  return json({ pending, done: done.slice(0, 20), rejected: reasons.sort((a, b) => b.uploaded.localeCompare(a.uploaded)) });
});

creditAdmin.put('/queue/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!QUEUE_NAME.test(name)) return bad('The file must be an .xlsx workbook with a simple name (letters, digits, spaces, dots, dashes)');
  const len = Number(c.req.header('content-length') ?? 0);
  if (!len) return bad('Empty file');
  if (len > QUEUE_MAX) return bad('The workbook is over 5 MB; it should hold numbers only');
  const body = await c.req.arrayBuffer();
  const head = new Uint8Array(body.slice(0, 2));
  if (head[0] !== 0x50 || head[1] !== 0x4b) return bad('That is not an Excel .xlsx workbook');
  await c.env.MEDIA.put(`credit-inbox/pending/${name}`, body, { httpMetadata: { contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' } });
  return json({ ok: true, name, bytes: body.byteLength, note: 'Queued. The pipeline checks and loads it at its next run (daily, or `pipeline.cmd credit` on any PC with the Oracle wallet). If any cell is wrong the whole file is refused and the reasons appear here.' }, 201);
});

creditAdmin.delete('/queue/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!QUEUE_NAME.test(name)) return bad('Bad file name');
  await c.env.MEDIA.delete(`credit-inbox/pending/${name}`);
  return json({ ok: true });
});
