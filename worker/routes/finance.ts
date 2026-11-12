import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';
import { parseCsv, normaliseHeader } from '../../shared/csv/parse';
import { ISO3_NAME } from '../../shared/country-names';
import { buildXlsx } from '../lib/xlsx';

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

/** Countries that have institutions on record, for the Finance landing page. */
finance.get('/', async (c) => {
  const { results } = await c.env.DB.prepare('SELECT country_iso3, COUNT(*) AS institutions FROM fin_institutions WHERE is_active = 1 GROUP BY country_iso3 ORDER BY country_iso3').all<{ country_iso3: string; institutions: number }>();
  return json({ countries: (results ?? []).map((r) => ({ ...r, country_name: ISO3_NAME[r.country_iso3] ?? r.country_iso3 })) });
});

finance.get('/:country', async (c) => {
  const iso3 = c.req.param('country').toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso3)) return bad('country must be an ISO3 code');
  const [inst, defs, rows, ent] = await Promise.all([
    c.env.DB.prepare('SELECT code, name, kind, website FROM fin_institutions WHERE country_iso3 = ? AND is_active = 1 ORDER BY name').bind(iso3).all<{ code: string; name: string; kind: string; website: string | null }>(),
    c.env.DB.prepare('SELECT code, label, units, is_rate, better FROM fin_metric_defs WHERE is_active = 1 ORDER BY sort_order').all<Def>(),
    c.env.DB.prepare('SELECT institution_code, period, metric_code, value, unit, currency, source_note, rate_type FROM fin_metrics WHERE country_iso3 = ? ORDER BY period DESC LIMIT 5000').bind(iso3).all<MetricRow>(),
    c.env.DB.prepare("SELECT slug FROM entities WHERE kind = 'country' AND iso3 = ?").bind(iso3).first<{ slug: string }>(),
  ]);
  const institutions = inst.results ?? [];
  const kindOf = new Map(institutions.map((i) => [i.code, i.kind]));
  const labelOf = new Map((defs.results ?? []).map((d) => [d.code, d.label]));
  const all = (rows.results ?? []).filter((r) => kindOf.has(r.institution_code));
  const get = (inst: string, metric: string, period?: string, rt?: string | null) =>
    all.find((r) => r.institution_code === inst && r.metric_code === metric && (period ? r.period === period : true) && (rt === undefined ? true : (r.rate_type ?? null) === rt));
  // Latest period per institution, metric and rate type (rows are newest first).
  const latest = new Map<string, MetricRow>();
  const previous = new Map<string, MetricRow>();
  for (const r of all) {
    const k = `${r.institution_code}|${r.metric_code}|${r.rate_type ?? ''}`;
    if (!latest.has(k)) latest.set(k, r);
    else if (!previous.has(k) && r.period.slice(0, 4) < latest.get(k)!.period.slice(0, 4)) previous.set(k, r);
  }
  const banks = institutions.filter((i) => i.kind === 'bank');
  const bankCodes = new Set(banks.map((b) => b.code));
  const sectorCode = institutions.find((i) => i.kind === 'sector')?.code ?? null;
  const centralCode = institutions.find((i) => i.kind === 'central_bank')?.code ?? null;

  const rankings = (defs.results ?? [])
    .filter((d) => d.better === 'higher' || d.better === 'lower')
    .map((d) => {
      const list = [...latest.values()].filter((r) => r.metric_code === d.code && bankCodes.has(r.institution_code) && r.unit !== 'currency');
      list.sort((a, b) => (d.better === 'lower' ? a.value - b.value : b.value - a.value));
      return { metric_code: d.code, label: d.label, better: d.better, ranked: list.map((r, i) => ({ rank: i + 1, institution_code: r.institution_code, value: r.value, unit: r.unit, period: r.period, rate_type: r.rate_type })) };
    })
    .filter((r) => r.ranked.length > 0);

  // ---- insight, all rule-based from the stored figures ----
  const nameOf = (code: string) => institutions.find((i) => i.code === code)?.name ?? code;
  const bn = (v: number) => `GHS ${(v / 1e9).toFixed(v >= 1e11 ? 0 : 1)}bn`;
  const pct = (v: number, d = 1) => `${v.toFixed(d)}%`;
  const insights: { id: string; title: string; text: string; evidence: string[] }[] = [];
  const yr = (all.filter((r) => bankCodes.has(r.institution_code) && r.metric_code === 'TOTAL_ASSETS').map((r) => r.period.slice(0, 4)).sort().at(-1)) ?? null;
  const prevYr = yr ? String(Number(yr) - 1) : null;
  const sectorYearEnd = yr && sectorCode ? get(sectorCode, 'TOTAL_ASSETS', `${yr}-12`) : undefined;
  const sec = (metric: string) => (yr && sectorCode ? get(sectorCode, metric, `${yr}-12`) : undefined);

  if (yr) {
    // size and market share, against the sector figure for the same year end
    const assets = banks.map((b) => ({ b, a: get(b.code, 'TOTAL_ASSETS', yr) })).filter((x) => x.a) as { b: (typeof banks)[number]; a: MetricRow }[];
    assets.sort((x, y) => y.a.value - x.a.value);
    if (assets.length) {
      const big = assets[0];
      const share = sectorYearEnd ? (big.a.value / sectorYearEnd.value) * 100 : null;
      insights.push({
        id: 'size', title: 'Who is biggest',
        text: `${big.b.name} holds the most assets of the banks listed here, at ${bn(big.a.value)} at the end of ${yr}${share != null ? `, about ${pct(share, 0)} of the whole banking sector (${bn(sectorYearEnd!.value)})` : ''}.`,
        evidence: [big.a.source_note, ...(sectorYearEnd ? [sectorYearEnd.source_note] : [])],
      });
    }
    // asset quality against the sector
    const secNpl = sec('NPL_RATIO');
    const npl = banks.map((b) => ({ b, r: get(b.code, 'NPL_RATIO', yr) })).filter((x) => x.r) as { b: (typeof banks)[number]; r: MetricRow }[];
    if (npl.length && secNpl) {
      npl.sort((x, y) => x.r.value - y.r.value);
      const parts = npl.map((x) => `${x.b.name} ${pct(x.r.value, 2)} (${x.r.value < secNpl.value ? 'below' : 'above'} the sector)`);
      insights.push({
        id: 'asset_quality', title: 'Loan quality',
        text: `The sector's non-performing loan ratio was ${pct(secNpl.value)} at the end of ${yr}. ${parts.join('; ')}. A lower ratio means fewer of the bank's loans are not being repaid.`,
        evidence: [secNpl.source_note, ...npl.map((x) => x.r.source_note)],
      });
    }
    // capital
    const secCar = sec('CAPITAL_ADEQUACY');
    const car = banks.map((b) => ({ b, r: get(b.code, 'CAPITAL_ADEQUACY', yr) })).filter((x) => x.r) as { b: (typeof banks)[number]; r: MetricRow }[];
    if (car.length && secCar) {
      car.sort((x, y) => y.r.value - x.r.value);
      insights.push({
        id: 'capital', title: 'Capital buffer',
        text: `Capital adequacy shows how much cushion a bank holds against losses. The sector stood at ${pct(secCar.value)} at the end of ${yr}. ${car.map((x) => `${x.b.name} ${pct(x.r.value, 2)}`).join(', ')}.`,
        evidence: [secCar.source_note, ...car.map((x) => x.r.source_note)],
      });
    }
    // loans against deposits: derived from two published figures
    const ltd = banks.map((b) => ({ b, l: get(b.code, 'TOTAL_LOANS', yr), d: get(b.code, 'TOTAL_DEPOSITS', yr) })).filter((x) => x.l && x.d && x.d.value > 0) as { b: (typeof banks)[number]; l: MetricRow; d: MetricRow }[];
    if (ltd.length) {
      ltd.sort((x, y) => y.l.value / y.d.value - x.l.value / x.d.value);
      const secL = sec('TOTAL_LOANS'), secD = sec('TOTAL_DEPOSITS');
      insights.push({
        id: 'lending_appetite', title: 'How much of deposits becomes loans',
        text: `Calculated from each bank's published loans and deposits: ${ltd.map((x) => `${x.b.name} lends out ${pct((x.l.value / x.d.value) * 100, 0)} of its customer deposits`).join('; ')}${secL && secD ? `. For the whole sector the figure was ${pct((secL.value / secD.value) * 100, 0)}` : ''}. The rest of each bank's deposits is held in other assets such as securities and cash.`,
        evidence: ltd.flatMap((x) => [x.l.source_note]),
      });
    }
    // growth
    if (prevYr) {
      const g = banks.map((b) => ({ b, a: get(b.code, 'TOTAL_ASSETS', yr), p: get(b.code, 'TOTAL_ASSETS', prevYr), l: get(b.code, 'TOTAL_LOANS', yr), lp: get(b.code, 'TOTAL_LOANS', prevYr) })).filter((x) => x.a && x.p && x.l && x.lp) as { b: (typeof banks)[number]; a: MetricRow; p: MetricRow; l: MetricRow; lp: MetricRow }[];
      if (g.length) {
        insights.push({
          id: 'growth', title: 'Who is growing its lending',
          text: g.map((x) => `${x.b.name}: loans ${x.l.value >= x.lp.value ? 'up' : 'down'} ${pct(Math.abs((x.l.value / x.lp.value - 1) * 100), 0)}, assets ${x.a.value >= x.p.value ? 'up' : 'down'} ${pct(Math.abs((x.a.value / x.p.value - 1) * 100), 0)} in ${yr}`).join('. ') + '.',
          evidence: g.map((x) => x.l.source_note),
        });
      }
    }
  }
  // the rate picture
  const policy = centralCode ? get(centralCode, 'POLICY_RATE') : undefined;
  const policyPrev = centralCode && policy ? all.filter((r) => r.institution_code === centralCode && r.metric_code === 'POLICY_RATE' && r.period < policy.period).sort((a, b) => (a.period < b.period ? 1 : -1))[0] : undefined;
  const sectorRateNow = sectorCode ? get(sectorCode, 'LENDING_RATE') : undefined;
  const sectorRatePrev = sectorCode && sectorRateNow ? all.filter((r) => r.institution_code === sectorCode && r.metric_code === 'LENDING_RATE' && r.period < sectorRateNow.period).sort((a, b) => (a.period < b.period ? 1 : -1))[0] : undefined;
  const refNow = sectorCode ? get(sectorCode, 'REFERENCE_RATE') : undefined;
  if (policy || sectorRateNow) {
    const bits: string[] = [];
    if (policy) bits.push(`The Bank of Ghana policy rate is ${pct(policy.value)} (${policy.period})${policyPrev ? `, down from ${pct(policyPrev.value)} in ${policyPrev.period}` : ''}`);
    if (sectorRateNow) bits.push(`the average bank lending rate was ${pct(sectorRateNow.value, 2)} in ${sectorRateNow.period}${sectorRatePrev ? `, against ${pct(sectorRatePrev.value, 2)} in ${sectorRatePrev.period}` : ''}`);
    if (refNow && sectorRateNow) bits.push(`the Ghana Reference Rate, which banks use as the base for pricing loans, was ${pct(refNow.value, 2)}, so the average borrower paid about ${(sectorRateNow.value - refNow.value).toFixed(1)} points above the base`);
    insights.push({ id: 'rates', title: 'Cost of borrowing', text: bits.join('; ') + '. Banks price each loan individually, so ask for the reference rate plus margin in writing.', evidence: [policy?.source_note, sectorRateNow?.source_note, refNow?.source_note].filter(Boolean) as string[] });
  }
  // trade finance fees, with an arithmetic example from the published figure
  const feeCodes = ['FEE_LC_IMPORT_SIGHT', 'FEE_LC_IMPORT_USANCE', 'FEE_LC_EXPORT_NEGOTIATION', 'FEE_GUARANTEE_PERIODIC', 'FEE_COLLECTION_EXPORT'];
  const fees = feeCodes.map((m) => ({
    metric_code: m, label: labelOf.get(m) ?? m,
    rows: banks.map((b) => ({ b, r: get(b.code, m) })).filter((x) => x.r).map((x) => ({ institution_code: x.b.code, name: x.b.name, value: x.r!.value, period: x.r!.period, source_note: x.r!.source_note })),
  })).filter((f) => f.rows.length > 0);
  const sight = fees.find((f) => f.metric_code === 'FEE_LC_IMPORT_SIGHT')?.rows[0];
  if (sight) {
    insights.push({ id: 'trade_finance', title: 'What trade finance costs',
      text: `${sight.name} publishes its import letter of credit fee at ${pct(sight.value)} per quarter for a sight credit. As an example, a US$100,000 sight letter of credit held for one quarter would carry a fee of about US$${(100000 * sight.value / 100).toLocaleString('en-US')}, plus the SWIFT charge the bank lists. Only banks whose tariff we hold are shown, so ask the others for theirs.`,
      evidence: [sight.source_note] });
  }
  const lastPeriod = all.reduce((m, r) => (r.period > m ? r.period : m), '');
  const byInst = new Map<string, MetricRow[]>();
  for (const r of latest.values()) (byInst.get(r.institution_code) ?? byInst.set(r.institution_code, []).get(r.institution_code)!).push(r);
  return json({
    country: iso3,
    country_name: ISO3_NAME[iso3] ?? iso3,
    country_slug: ent?.slug ?? null,
    last_period: lastPeriod || null,
    year: yr,
    institutions: institutions.filter((i) => i.kind === 'bank').map((i) => ({ ...i, metrics: byInst.get(i.code) ?? [] })),
    sector: sectorCode ? { code: sectorCode, name: nameOf(sectorCode), metrics: byInst.get(sectorCode) ?? [] } : null,
    central_bank: centralCode ? { code: centralCode, name: nameOf(centralCode), website: institutions.find((i) => i.code === centralCode)?.website ?? null, metrics: byInst.get(centralCode) ?? [] } : null,
    metric_defs: defs.results ?? [],
    rankings,
    insights,
    fees,
    sources: [...new Set(all.map((r) => r.source_note.replace(/:.*$/, '')))],
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

/**
 * The Excel template, built from the live metric definitions and registered institutions, so what an operator downloads is
 * exactly what the upload will accept. Sheets: Data (fill this), How to fill, Metrics, Institutions, Example.
 */
financeAdmin.get('/template', async (c) => {
  const [defsR, instR] = await Promise.all([
    c.env.DB.prepare('SELECT code, label, units, is_rate, better FROM fin_metric_defs WHERE is_active = 1 ORDER BY sort_order').all<Def>(),
    c.env.DB.prepare('SELECT code, name, country_iso3, kind FROM fin_institutions WHERE is_active = 1 ORDER BY country_iso3, name').all<{ code: string; name: string; country_iso3: string; kind: string }>(),
  ]);
  const defs = defsR.results ?? [];
  const first = defs.find((d) => !d.is_rate) ?? defs[0];
  const rate = defs.find((d) => d.is_rate);
  const xlsx = buildXlsx([
    { name: 'Data', rows: [COLUMNS], widths: [20, 13, 10, 20, 16, 12, 10, 60, 12] },
    {
      name: 'How to fill',
      widths: [22, 110],
      rows: [
        ['Column', 'What to enter'],
        ['institution_code', 'The code of a registered institution (see the Institutions sheet). Register new ones in the admin first: rows for unknown institutions are rejected.'],
        ['country_iso3', 'Three capital letters, for example GHA.'],
        ['period', 'The period the figure describes: 2025 for a year, 2025-06 for a month, 2025-Q2 for a quarter.'],
        ['metric_code', 'One code from the Metrics sheet. Nothing else is accepted.'],
        ['value', 'A plain number. No commas, no currency symbol. Percentages as 14.2, not 0.142. Money in full units (GHS 1,250,000 is 1250000).'],
        ['unit', 'One of the units listed for that metric on the Metrics sheet: percent, currency or count.'],
        ['currency', 'Required when unit is currency: the three-letter code, for example GHS.'],
        ['source_note', 'REQUIRED on every row. Where the figure came from: document title, year, page or table. A figure without a source is rejected.'],
        ['rate_type', 'Only for rate metrics (those marked "yes" on the Metrics sheet): fixed, variable, indicative or policy. Leave empty for everything else.'],
        [null, null],
        ['Rules', 'One row per institution, period, metric and rate type. A duplicate row is rejected. If any row is wrong the whole file is refused and every problem is listed by row, so nothing is half loaded.'],
        ['Order of work', '1. Register institutions in the admin. 2. Fill the Data sheet. 3. Admin, Finance, Upload figures: save the Data sheet as CSV, choose "Check only", fix what it lists, then "Check and load".'],
        ['Never', 'Do not estimate, round up or fill gaps. If a figure was not published, leave the row out.'],
      ],
    },
    { name: 'Metrics', widths: [24, 34, 26, 16, 26], rows: [['metric_code', 'label', 'allowed units', 'is a rate (needs rate_type)', 'ranking'], ...defs.map((d) => [d.code, d.label, d.units.replace(/,/g, ', '), d.is_rate ? 'yes' : 'no', d.better === 'higher' ? 'higher ranks first' : d.better === 'lower' ? 'lower ranks first' : 'not ranked'])] },
    { name: 'Institutions', widths: [26, 44, 12, 16], rows: [['institution_code', 'name', 'country_iso3', 'kind'], ...(instR.results ?? []).map((i) => [i.code, i.name, i.country_iso3, i.kind])] },
    {
      name: 'Example',
      widths: [20, 13, 10, 20, 16, 12, 10, 60, 12],
      rows: [
        COLUMNS,
        ['EXAMPLE_BANK', 'GHA', '2025', first?.code ?? 'TOTAL_ASSETS', 14.2, first?.units.split(',')[0] ?? 'percent', first?.units.startsWith('currency') ? 'GHS' : null, 'EXAMPLE ONLY: annual report 2025, page 31', null],
        ...(rate ? [['EXAMPLE_BANK', 'GHA', '2025-06', rate.code, 28.5, 'percent', null, 'EXAMPLE ONLY: published rate card, June 2025', 'indicative']] : []),
      ],
    },
  ]);
  return new Response(xlsx, {
    headers: {
      'content-type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'content-disposition': 'attachment; filename="tereflow-finance-template.xlsx"',
      'cache-control': 'no-store',
    },
  });
});

financeAdmin.post('/institutions', async (c) => {
  const b = (await c.req.json().catch(() => null)) as { code?: string; name?: string; country_iso3?: string; kind?: string; website?: string } | null;
  if (!b?.code || !b.name || !b.country_iso3) return bad('code, name and country_iso3 are required');
  const code = b.code.trim().toUpperCase().replace(/[^A-Z0-9_]/g, '_').slice(0, 60);
  const iso = b.country_iso3.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso)) return bad('country_iso3 must be three capital letters');
  const kind = ['bank', 'dfi', 'microfinance', 'insurer', 'central_bank', 'sector', 'other'].includes(b.kind ?? '') ? b.kind! : 'bank';
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
  // One gateway call per 150 statements, so a large file does not exhaust the Worker's subrequest limit.
  const stmts: D1PreparedStatement[] = [];
  for (const r of rows) {
    if (b.replace) {
      stmts.push(c.env.DB.prepare("DELETE FROM fin_metrics WHERE institution_code = ? AND period = ? AND metric_code = ? AND COALESCE(rate_type, '-') = ?").bind(r.institution_code, r.period, r.metric_code, r.rate_type ?? '-'));
    }
    stmts.push(c.env.DB.prepare('INSERT INTO fin_metrics (institution_code, country_iso3, period, metric_code, value, unit, currency, source_note, rate_type, upload_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .bind(r.institution_code, r.country_iso3, r.period, r.metric_code, r.value, r.unit, r.currency, r.source_note, r.rate_type, id));
  }
  for (let i = 0; i < stmts.length; i += 150) await c.env.DB.batch(stmts.slice(i, i + 150));  return json({ ok: true, id, rows_loaded: rows.length, problems: [] }, 201);
});

financeAdmin.delete('/uploads/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare('DELETE FROM fin_metrics WHERE upload_id = ?').bind(id).run();
  const res = await c.env.DB.prepare("UPDATE fin_uploads SET status = 'reverted' WHERE id = ?").bind(id).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ ok: true });
});