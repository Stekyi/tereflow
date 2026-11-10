import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';
import { parseCsv, normaliseHeader } from '../../shared/csv/parse';
import { ISO3_NAME } from '../../shared/country-names';

/**
 * Finance module. Institutions and their published figures, loaded from the bank template by an operator
 * (script or CSV upload). Allowed metrics, units and rate types come from the fin_metric_defs table, never from code.
 * Rankings are deterministic: each metric says whether higher or lower is better, and the latest period per institution decides.
 */
export const finance = new Hono<{ Bindings: Env }>();
export const financeAdmin = new Hono<{ Bindings: Env }>();

interface Def { code: string; label: string; units: string; is_rate: number; better: string }
interface MetricRow { institution_code: string; country_iso3: string; period: string; metric_code: string; value: number; unit: string; currency: string | null; source_note: string; rate_type: string | null }

const COLUMNS = ['institution_code', 'country_iso3', 'period', 'metric_code', 'value', 'unit', 'currency', 'source_note', 'rate_type'];
const REQUIRED = ['institution_code', 'country_iso3', 'period', 'metric_code', 'value', 'unit', 'source_note'];
const RATE_TYPES = ['fixed', 'variable', 'indicative', 'policy'];
const PERIOD = /^\d{4}(-(0[1-9]|1[0-2])|-Q[1-4])?$/;

// ---- public -----------------------------------------------------------------

finance.get('/:country', async (c) => {
  const iso3 = c.req.param('country').toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso3)) return bad('country must be an ISO3 code');
  const [inst, defs, rows] = await Promise.all([
    c.env.DB.prepare('SELECT code, name, kind, website FROM fin_institutions WHERE country_iso3 = ? AND is_active = 1 ORDER BY name').bind(iso3).all<{ code: string; name: string; kind: string; website: string | null }>(),
    c.env.DB.prepare('SELECT code, label, units, is_rate, better FROM fin_metric_defs WHERE is_active = 1 ORDER BY sort_order').all<Def>(),
    c.env.DB.prepare('SELECT institution_code, period, metric_code, value, unit, currency, source_note, rate_type FROM fin_metrics WHERE country_iso3 = ? ORDER BY period DESC LIMIT 5000').bind(iso3).all<MetricRow>(),
  ]);
  const institutions = inst.results ?? [];
  const known = new Set(institutions.map((i) => i.code));
  // Latest period per institution, metric and rate type.
  const latest = new Map<string, MetricRow>();
  for (const r of rows.results ?? []) {
    if (!known.has(r.institution_code)) continue;
    const k = `${r.institution_code}|${r.metric_code}|${r.rate_type ?? ''}`;
    if (!latest.has(k)) latest.set(k, r);
  }
  const byInst = new Map<string, MetricRow[]>();
  for (const r of latest.values()) (byInst.get(r.institution_code) ?? byInst.set(r.institution_code, []).get(r.institution_code)!).push(r);
  const rankings = (defs.results ?? [])
    .filter((d) => d.better === 'higher' || d.better === 'lower')
    .map((d) => {
      const list = [...latest.values()].filter((r) => r.metric_code === d.code && r.unit !== 'currency');
      list.sort((a, b) => (d.better === 'lower' ? a.value - b.value : b.value - a.value));
      return {
        metric_code: d.code,
        label: d.label,
        better: d.better,
        ranked: list.map((r, i) => ({ rank: i + 1, institution_code: r.institution_code, value: r.value, unit: r.unit, period: r.period, rate_type: r.rate_type })),
      };
    })
    .filter((r) => r.ranked.length > 0);
  const lastUpdated = [...latest.values()].reduce((m, r) => (r.period > m ? r.period : m), '');
  return json({
    country: iso3,
    country_name: ISO3_NAME[iso3] ?? iso3,
    last_period: lastUpdated || null,
    institutions: institutions.map((i) => ({ ...i, metrics: byInst.get(i.code) ?? [] })),
    metric_defs: defs.results ?? [],
    rankings,
  });
});

// ---- admin ------------------------------------------------------------------

financeAdmin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

financeAdmin.get('/', async (c) => {
  const [inst, defs, ups] = await Promise.all([
    c.env.DB.prepare('SELECT code, name, country_iso3, kind, website, is_active FROM fin_institutions ORDER BY country_iso3, name').all(),
    c.env.DB.prepare('SELECT code, label, units, is_rate, better FROM fin_metric_defs ORDER BY sort_order').all(),
    c.env.DB.prepare('SELECT id, filename, rows_read, rows_loaded, status, uploaded_by, uploaded_at FROM fin_uploads ORDER BY uploaded_at DESC LIMIT 30').all(),
  ]);
  return json({ institutions: inst.results ?? [], metric_defs: defs.results ?? [], uploads: ups.results ?? [] });
});

financeAdmin.post('/institutions', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { code?: string; name?: string; country_iso3?: string; kind?: string; website?: string } | null;
  if (!b?.code || !b.name || !b.country_iso3) return bad('code, name and country_iso3 are required');
  const code = b.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60);
  const iso = b.country_iso3.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso)) return bad('country_iso3 must be three capital letters');
  const kind = ['bank', 'dfi', 'microfinance', 'insurer', 'other'].includes(b.kind ?? '') ? b.kind! : 'bank';
  await c.env.DB.prepare('DELETE FROM fin_institutions WHERE code = ?').bind(code).run();
  await c.env.DB.prepare('INSERT INTO fin_institutions (code, name, country_iso3, kind, website) VALUES (?, ?, ?, ?, ?)').bind(code, b.name.trim().slice(0, 200), iso, kind, b.website?.trim().slice(0, 300) || null).run();
  return json({ code }, 201);
});

/** Validate a CSV saved from the template's Data sheet. dry_run reports without writing. */
financeAdmin.post('/upload', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { filename?: string; content?: string; dry_run?: boolean; replace?: boolean } | null;
  if (!b || typeof b.content !== 'string') return bad('Send { filename, content } with the CSV text');
  const [defsR, instR] = await Promise.all([
    c.env.DB.prepare('SELECT code, label, units, is_rate, better FROM fin_metric_defs WHERE is_active = 1').all<Def>(),
    c.env.DB.prepare('SELECT code, country_iso3 FROM fin_institutions WHERE is_active = 1').all<{ code: string; country_iso3: string }>(),
  ]);
  const defs = new Map((defsR.results ?? []).map((d) => [d.code, d]));
  const insts = new Set((instR.results ?? []).map((i) => i.code));
  const parsed = parseCsv(b.content);
  const problems: { row: number; column: string; message: string }[] = parsed.problems.map((m) => ({ row: 1, column: 'file', message: m }));
  const missing = COLUMNS.filter((col) => !parsed.header.includes(col));
  if (missing.length) problems.push({ row: 1, column: 'header', message: `missing column(s): ${missing.join(', ')}` });
  const rows: MetricRow[] = [];
  if (!missing.length) {
    const ix = Object.fromEntries(COLUMNS.map((col) => [col, parsed.header.indexOf(normaliseHeader(col))])) as Record<string, number>;
    const seen = new Set<string>();
    for (const pr of parsed.rows) {
      const g = (col: string) => (pr.cells[ix[col]] ?? '').trim();
      const r = pr.lineNumber;
      const bad1 = (column: string, message: string) => problems.push({ row: r, column, message });
      for (const col of REQUIRED) if (!g(col)) bad1(col, 'required value is empty');
      const code = g('metric_code'), unit = g('unit'), iso = g('country_iso3'), period = g('period'), inst = g('institution_code'), rt = g('rate_type');
      const d = defs.get(code);
      if (code && !d) bad1('metric_code', `'${code}' is not an allowed metric`);
      if (inst && !insts.has(inst)) bad1('institution_code', `'${inst}' is not a registered institution; register it first`);
      if (iso && !/^[A-Z]{3}$/.test(iso)) bad1('country_iso3', `'${iso}' must be three capital letters`);
      if (period && !PERIOD.test(period)) bad1('period', `'${period}' is not a valid period (YYYY, YYYY-MM or YYYY-Qn)`);
      const num = Number(g('value'));
      if (g('value') && !Number.isFinite(num)) bad1('value', `'${g('value')}' is not a number`);
      if (d && unit && !d.units.split(',').includes(unit)) bad1('unit', `'${unit}' not allowed for ${code}; use ${d.units}`);
      if (d && unit === 'currency' && !g('currency')) bad1('currency', 'currency code required when unit is currency');
      if (d && d.is_rate && !RATE_TYPES.includes(rt)) bad1('rate_type', `rate rows need rate_type, one of: ${RATE_TYPES.join(', ')}`);
      if (d && !d.is_rate && rt) bad1('rate_type', `${code} is not a rate, leave rate_type empty`);
      const key = `${inst}|${iso}|${period}|${code}|${rt}`;
      if (seen.has(key)) bad1('row', 'duplicate of an earlier row');
      seen.add(key);
      rows.push({ institution_code: inst, country_iso3: iso, period, metric_code: code, value: num, unit, currency: g('currency') || null, source_note: g('source_note'), rate_type: rt || null });
    }
  }
  if (rows.length > 2000) problems.push({ row: 0, column: 'file', message: 'More than 2000 rows; split the file' });
  if (problems.length || !rows.length) return json({ ok: false, rows_read: rows.length, problems: problems.slice(0, 200) }, 422);
  if (b.dry_run) return json({ ok: true, dry_run: true, rows_read: rows.length, problems: [] });
  const actor = await currentUser(c.req.raw, c.env);
  const id = uid('fup_');
  await c.env.DB.prepare('INSERT INTO fin_uploads (id, filename, rows_read, rows_loaded, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, (b.filename ?? 'upload.csv').slice(0, 300), rows.length, rows.length, 'loaded', actor?.email ?? 'admin').run();
  for (const r of rows) {
    if (b.replace) {
      await c.env.DB.prepare("DELETE FROM fin_metrics WHERE institution_code = ? AND period = ? AND metric_code = ? AND COALESCE(rate_type, '-') = ?").bind(r.institution_code, r.period, r.metric_code, r.rate_type ?? '-').run();
    }
    await c.env.DB.prepare('INSERT INTO fin_metrics (institution_code, country_iso3, period, metric_code, value, unit, currency, source_note, rate_type, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.institution_code, r.country_iso3, r.period, r.metric_code, r.value, r.unit, r.currency, r.source_note, r.rate_type, id).run();
  }
  return json({ ok: true, id, rows_loaded: rows.length, problems: [] }, 201);
});

financeAdmin.delete('/uploads/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM fin_metrics WHERE upload_id = ?').bind(id).run();
  const res = await c.env.DB.prepare("UPDATE fin_uploads SET status = 'reverted' WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ ok: true });
});