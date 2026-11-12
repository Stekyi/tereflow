import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';
import { parseCsv } from '../../shared/csv/parse';
import { ISO3_NAME } from '../../shared/country-names';
import cfg from '../../templates/national_config.json';
import { ytdGrowth } from '../../shared/national-series';
import { buildXlsx } from '../lib/xlsx';

/**
 * National statistics: monthly or quarterly series from a country's own statistics office, loaded by an operator, and the
 * public freshness view that shows them next to the yearly Comtrade backbone. Frequency and source are stated per country.
 * The merge is deterministic: year-to-date growth of the national total against the same periods a year earlier.
 */
export const national = new Hono<{ Bindings: Env }>();
export const nationalAdmin = new Hono<{ Bindings: Env }>();

type Freq = 'monthly' | 'quarterly' | 'annual';
const PERIODS: Record<Freq, RegExp> = { monthly: /^\d{4}-(0[1-9]|1[0-2])$/, quarterly: /^\d{4}-Q[1-4]$/, annual: /^\d{4}$/ };
const HS = /^(TOTAL|\d{2}|\d{4}|\d{6})$/;

national.get('/', async (c) => {
  const [src, fresh, ser] = await Promise.all([
    c.env.DB.prepare('SELECT country_iso3, source_name, source_url, frequency, note FROM nat_sources WHERE is_active = 1 ORDER BY country_iso3').all<{ country_iso3: string; source_name: string; source_url: string | null; frequency: Freq; note: string | null }>(),
    c.env.DB.prepare('SELECT country_iso3, flow, comtrade_latest_year, comtrade_years, updated_at FROM data_freshness ORDER BY country_iso3').all<{ country_iso3: string; flow: string; comtrade_latest_year: number | null; comtrade_years: number | null; updated_at: string }>(),
    c.env.DB.prepare("SELECT country_iso3, flow, period, value_usd FROM nat_series WHERE hs_code = 'TOTAL' ORDER BY period DESC LIMIT 5000").all<{ country_iso3: string; flow: string; period: string; value_usd: number }>(),
  ]);
  const sources = new Map((src.results ?? []).map((s) => [s.country_iso3, s]));
  const byKey = new Map<string, { period: string; value_usd: number }[]>();
  for (const r of ser.results ?? []) (byKey.get(`${r.country_iso3}|${r.flow}`) ?? byKey.set(`${r.country_iso3}|${r.flow}`, []).get(`${r.country_iso3}|${r.flow}`)!).push({ period: r.period, value_usd: r.value_usd });
  const countries = new Set<string>([...sources.keys(), ...(fresh.results ?? []).map((f) => f.country_iso3)]);
  const rows = [...countries].sort().map((iso) => {
    const flows = ['X', 'M'].map((flow) => {
      const f = (fresh.results ?? []).find((x) => x.country_iso3 === iso && x.flow === flow);
      const s = byKey.get(`${iso}|${flow}`) ?? [];
      return {
        flow,
        comtrade_latest_year: f?.comtrade_latest_year ?? null,
        national_latest_period: s.length ? s.map((x) => x.period).sort().at(-1)! : null,
        national_ytd: ytdGrowth(s),
      };
    });
    const sc = sources.get(iso);
    return { iso3: iso, name: ISO3_NAME[iso] ?? iso, national_source: sc ? { name: sc.source_name, url: sc.source_url, frequency: sc.frequency, note: sc.note } : null, flows };
  });
  const updated = (fresh.results ?? []).map((f) => f.updated_at).sort().at(-1) ?? null;
  return json({ countries: rows, comtrade_note: 'Yearly backbone: UN Comtrade, refreshed by a nightly job when new data is published.', recorded_at: updated }, 200, { 'cache-control': 'public, max-age=300' });
});

// ---- admin ------------------------------------------------------------------

nationalAdmin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

nationalAdmin.get('/', async (c) => {
  const [s, u] = await Promise.all([
    c.env.DB.prepare('SELECT country_iso3, source_name, source_url, frequency, note, is_active FROM nat_sources ORDER BY country_iso3').all(),
    c.env.DB.prepare('SELECT id, filename, rows_read, rows_loaded, status, uploaded_by, uploaded_at FROM nat_uploads ORDER BY uploaded_at DESC LIMIT 30').all(),
  ]);
  return json({ sources: s.results ?? [], uploads: u.results ?? [], priority: (cfg as { priority_countries: string[] }).priority_countries, formats: (cfg as { period_formats: Record<string, string> }).period_formats });
});

/** The national statistics template, from the same config the upload validates against. */
nationalAdmin.get('/template', async (c) => {
  const k = cfg as { columns: string[]; period_formats: Record<string, string>; hs_code: string; priority_countries: string[] };
  const src = await c.env.DB.prepare('SELECT country_iso3, source_name, frequency FROM nat_sources WHERE is_active = 1 ORDER BY country_iso3').all<{ country_iso3: string; source_name: string; frequency: string }>();
  const xlsx = buildXlsx([
    { name: 'Data', rows: [k.columns], widths: [14, 8, 12, 12, 20, 70] },
    {
      name: 'How to fill',
      widths: [18, 110],
      rows: [
        ['Column', 'What to enter'],
        ['country_iso3', 'Three capital letters. The country needs a registered national source first (see the Sources sheet).'],
        ['flow', 'X for exports, M for imports.'],
        ['period', `Must match the update frequency registered for the country. ${Object.entries(k.period_formats).map(([a, b]) => `${a}: ${b}`).join('. ')}.`],
        ['hs_code', k.hs_code],
        ['value_usd', 'US dollars, plain digits. If the office publishes in local currency, convert first and say how in source_note.'],
        ['source_note', 'REQUIRED on every row: the release, table and date it came from.'],
        [null, null],
        ['Rules', 'One row per country, flow, period and product. Duplicates and any bad row refuse the whole file, with every problem listed by row.'],
        ['Priority countries', k.priority_countries.join(', ')],
      ],
    },
    { name: 'Sources', widths: [14, 46, 14], rows: [['country_iso3', 'source name', 'updates'], ...(src.results ?? []).map((s) => [s.country_iso3, s.source_name, s.frequency])] },
    { name: 'Example', widths: [14, 8, 12, 12, 20, 70], rows: [k.columns, ['GHA', 'X', '2026-03', 'TOTAL', 1250000000, 'EXAMPLE ONLY: statistics office release, table 2'], ['GHA', 'X', '2026-03', '1801', 310000000, 'EXAMPLE ONLY: statistics office release, table 4']] },
  ]);
  return new Response(xlsx, { headers: { 'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', 'content-disposition': 'attachment; filename="tereflow-national-template.xlsx"', 'cache-control': 'no-store' } });
});

nationalAdmin.post('/sources', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { country_iso3?: string; source_name?: string; source_url?: string; frequency?: string; note?: string } | null;
  const iso = (b?.country_iso3 ?? '').trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso) || !b?.source_name?.trim()) return bad('country_iso3 (three letters) and source_name are required');
  if (!['monthly', 'quarterly', 'annual'].includes(b.frequency ?? '')) return bad('frequency must be monthly, quarterly or annual');
  await c.env.DB.prepare('DELETE FROM nat_sources WHERE country_iso3 = ?').bind(iso).run();
  await c.env.DB.prepare('INSERT INTO nat_sources (country_iso3, source_name, source_url, frequency, note) VALUES (?, ?, ?, ?, ?)')
    .bind(iso, b.source_name.trim().slice(0, 200), b.source_url?.trim().slice(0, 400) || null, b.frequency, b.note?.trim().slice(0, 400) || null).run();
  return json({ country_iso3: iso }, 201);
});

nationalAdmin.post('/upload', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { filename?: string; content?: string; dry_run?: boolean; replace?: boolean } | null;
  if (!b || typeof b.content !== 'string') return bad('Send { filename, content } with the CSV text');
  const src = await c.env.DB.prepare('SELECT country_iso3, frequency FROM nat_sources WHERE is_active = 1').all<{ country_iso3: string; frequency: Freq }>();
  const freq = new Map((src.results ?? []).map((s) => [s.country_iso3, s.frequency]));
  const parsed = parseCsv(b.content);
  const problems: { row: number; column: string; message: string }[] = parsed.problems.map((m) => ({ row: 1, column: 'file', message: m }));
  const columns = (cfg as { columns: string[] }).columns;
  const missing = columns.filter((col) => !parsed.header.includes(col));
  if (missing.length) problems.push({ row: 1, column: 'header', message: `missing column(s): ${missing.join(', ')}` });
  const rows: { iso: string; flow: string; period: string; hs: string; value: number; note: string }[] = [];
  if (!missing.length) {
    const ix = Object.fromEntries(columns.map((col) => [col, parsed.header.indexOf(col)])) as Record<string, number>;
    const seen = new Set<string>();
    for (const pr of parsed.rows) {
      const g = (col: string) => (pr.cells[ix[col]] ?? '').trim();
      const r = pr.lineNumber;
      const p = (column: string, message: string) => problems.push({ row: r, column, message });
      for (const col of columns) if (!g(col)) p(col, 'required value is empty');
      const iso = g('country_iso3'), flow = g('flow'), period = g('period'), hs = g('hs_code');
      if (iso && !/^[A-Z]{3}$/.test(iso)) p('country_iso3', `'${iso}' must be three capital letters`);
      else if (iso && !freq.has(iso)) p('country_iso3', `no national source registered for ${iso}; register it first`);
      if (flow && flow !== 'X' && flow !== 'M') p('flow', `'${flow}' must be X (exports) or M (imports)`);
      if (hs && !HS.test(hs)) p('hs_code', `'${hs}' must be TOTAL or a 2, 4 or 6 digit HS code`);
      const f = freq.get(iso);
      if (period && f && !PERIODS[f].test(period)) p('period', `'${period}' does not match ${f} (${(cfg as { period_formats: Record<string, string> }).period_formats[f]})`);
      const v = Number(g('value_usd'));
      if (g('value_usd') && (!Number.isFinite(v) || v < 0)) p('value_usd', `'${g('value_usd')}' must be a non-negative number in US dollars`);
      const key = `${iso}|${flow}|${period}|${hs}`;
      if (seen.has(key)) p('row', 'duplicate of an earlier row');
      seen.add(key);
      rows.push({ iso, flow, period, hs, value: v, note: g('source_note') });
    }
  }
  if (rows.length > 3000) problems.push({ row: 0, column: 'file', message: 'More than 3000 rows; split the file' });
  if (problems.length || !rows.length) return json({ ok: false, rows_read: rows.length, problems: problems.slice(0, 200) }, 422);
  if (b.dry_run) return json({ ok: true, dry_run: true, rows_read: rows.length, problems: [] });
  const actor = await currentUser(c.req.raw, c.env);
  const id = uid('nup_');
  await c.env.DB.prepare('INSERT INTO nat_uploads (id, filename, rows_read, rows_loaded, status, uploaded_by) VALUES (?, ?, ?, ?, ?, ?)').bind(id, (b.filename ?? 'upload.csv').slice(0, 300), rows.length, rows.length, 'loaded', actor?.email ?? 'admin').run();
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (b.replace) stmts.push(c.env.DB.prepare('DELETE FROM nat_series WHERE country_iso3 = ? AND flow = ? AND period = ? AND hs_code = ?').bind(r.iso, r.flow, r.period, r.hs));
    stmts.push(c.env.DB.prepare('INSERT INTO nat_series (country_iso3, flow, period, hs_code, value_usd, source_note, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(r.iso, r.flow, r.period, r.hs, r.value, r.note, id));
  }
  for (let i = 0; i < stmts.length; i += 150) await c.env.DB.batch(stmts.slice(i, i + 150));
  return json({ ok: true, id, rows_loaded: rows.length, problems: [] }, 201);
});

nationalAdmin.delete('/uploads/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM nat_series WHERE upload_id = ?').bind(id).run();
  const res = await c.env.DB.prepare("UPDATE nat_uploads SET status = 'reverted' WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ ok: true });
});