import type { Env } from '../../lib/db';
import type { AdapterResult, FactRow } from '../types';
import { ISO3_TO_M49, M49_TO_ISO3, hs2Label, hs2Sector, hs6Label } from '../codes';
import { HS6_LABEL } from '../hs6-codes.generated';
import { ISO3_NAME } from '../country-names';

const PREVIEW = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const FULL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const PREVIEW_TARIFFLINE = 'https://comtradeapi.un.org/public/v1/previewTariffline/C/A/HS';
const FULL_TARIFFLINE = 'https://comtradeapi.un.org/data/v1/getTariffline/C/A/HS';
const PREVIEW_TARIFFLINE_AVAIL = 'https://comtradeapi.un.org/public/v1/getDaTariffline/C/A/HS';
const FULL_TARIFFLINE_AVAIL = 'https://comtradeapi.un.org/data/v1/getDaTariffline/C/A/HS';
const PREVIEW_FINAL_AVAIL = 'https://comtradeapi.un.org/public/v1/getDa/C/A/HS';
const FULL_FINAL_AVAIL = 'https://comtradeapi.un.org/data/v1/getDa/C/A/HS';
const SOURCE_REF = 'un-comtrade';
const MAX_RECORDS = 250_000;
const CMD_BATCH_SIZE = 20;
const ALL_CHAPTERS = Array.from({ length: 99 }, (_, i) => String(i + 1).padStart(2, '0'));

export interface UnclassifiedTradeRow {
  year: number;
  flow: 'export' | 'import';
  partner_iso3: string;
  partner_name: string;
  value_usd: number;
  qty: number | null;
  qty_unit: 'kg' | null;
  source_ref: string;
}

export interface ComtradeAdapterResult extends AdapterResult {
  /**
   * Partner-level Comtrade observations reported as an unclassified
   * "Commodities not specified according to kind" line. These remain outside
   * the product opportunity dataset because they do not identify a product.
   */
  unclassified_trade: UnclassifiedTradeRow[];
}

interface ComtradeRow {
  refYear?: number;
  period?: number | string;
  flowCode?: string;
  partnerCode?: number;
  partnerISO?: string | null;
  partnerDesc?: string | null;
  partner2Code?: number;
  cmdCode?: string;
  cmdDesc?: string | null;
  customsCode?: string;
  motCode?: number;
  mosCode?: number;
  primaryValue?: number;
  netWgt?: number;
  qtyUnitAbbr?: string;
}

const FLOWS = [
  ['X', 'export'],
  ['M', 'import'],
] as const;

/**
 * UN Comtrade is Tereflow's primary trade-data source.
 *
 * Product extraction order is deliberate:
 *   1. Tariffline endpoint, using HS chapter prefixes to retrieve the most
 *      detailed national commodity codes Comtrade publishes for the reporter.
 *   2. Final-data HS6 partner/product extraction only when tariffline data is
 *      unavailable for that country/year/flow.
 *
 * National tariff-line codes are reporter-specific. They are stored exactly
 * as reported and are never silently treated as globally equivalent HS codes.
 */
export async function fetchComtrade(
  env: Env,
  iso3: string,
  years: number[],
  perCallDelayMs = 1200,
  _settings?: unknown,
): Promise<ComtradeAdapterResult> {
  const reporter = ISO3_TO_M49[iso3?.toUpperCase()];
  if (!reporter) {
    return {
      rows: [],
      unclassified_trade: [],
      source_ref: SOURCE_REF,
      ok: false,
      note: `No UN M49 code known for ${iso3}; skipped Comtrade.`,
    };
  }

  const hasKey = Boolean(env.COMTRADE_API_KEY);
  if (!hasKey) {
    return {
      rows: [],
      unclassified_trade: [],
      source_ref: SOURCE_REF,
      ok: false,
      note: 'COMTRADE_API_KEY is required for complete partner-level ingestion.',
    };
  }

  const rows: FactRow[] = [];
  const unclassified_trade: UnclassifiedTradeRow[] = [];
  const seenRows = new Set<string>();
  const notes: string[] = [];
  const truncatedYears = new Set<number>();
  let callsMade = 0;
  // Comtrade rate limits are shared across requests from this address.
  // Tariff-line extraction makes many more calls than the HS6 path, so keep
  // a conservative minimum pace even when the pipeline config is zero.
  const effectiveDelayMs = Math.max(perCallDelayMs, 1200);

  const paced = async (
    params: Record<string, string | number | boolean>,
    tariffline = false,
  ) => {
    if (callsMade > 0) await sleep(effectiveDelayMs);
    callsMade++;
    return call(env, true, params, tariffline);
  };

  const pushRow = (row: FactRow) => {
    const key = `${row.year}|${row.flow}|${row.partner_iso3 ?? ''}|${row.hs_code ?? ''}`;
    if (seenRows.has(key)) return;
    seenRows.add(key);
    rows.push(row);
  };

  // Headline country totals. Keep these separate from the product dataset.
  for (const [flowCode, flow] of FLOWS) {
    for (const year of years) {
      const res = await paced({
        reporterCode: reporter,
        period: String(year),
        cmdCode: 'TOTAL',
        flowCode,
        partnerCode: 0,
      });
      if (res.error) {
        notes.push(`${flow} total ${year}: ${res.error}`);
        continue;
      }
      for (const r of aggregatesOnly(res.data)) {
        if (Number(r.partnerCode ?? -1) !== 0) continue;
        const value = Number(r.primaryValue ?? 0);
        const reportedYear = Number(r.refYear ?? r.period ?? 0);
        if (!(value > 0) || !reportedYear) continue;
        pushRow({
          year: reportedYear,
          flow,
          stream: 'goods',
          partner_iso3: null,
          partner_name: null,
          hs_code: null,
          product_name: null,
          sector: null,
          value_usd: value,
          qty: r.netWgt ?? null,
          qty_unit: r.netWgt != null ? 'kg' : null,
          source_ref: SOURCE_REF,
        });
      }
    }
  }

  // Determine the deepest tariff-line classification Comtrade actually
  // publishes for each reporter/year before making any tariff-line requests.
  // This avoids expensive tariff-line calls for reporters whose Comtrade
  // dataset is only HS6 (such as Ghana 2025).
  const tarifflineAvailability = new Map<number, ComtradeAvailability | null>();
  for (const year of years) {
    if (callsMade > 0) await sleep(effectiveDelayMs);
    callsMade++;
    const availability = await fetchAvailability(env, reporter, year, true);
    tarifflineAvailability.set(year, availability);
  }

  // Product extraction: use the deepest published tariff-line level when it
  // is actually deeper than HS6; otherwise use the standard HS6 endpoint.
  for (const [flowCode, flow] of FLOWS) {
    for (const year of years) {
      // Check Comtrade's published tariff-line classification before making
      // expensive chapter requests. The availability dataset tells us the
      // deepest commodity-code length actually published for this reporter/year.
      const availability = tarifflineAvailability.get(year) ?? null;
      const tarifflineLength = availability?.lengthCmdCode ?? null;

      if (tarifflineLength != null && tarifflineLength > 6) {
        const tariff = await fetchTarifflineYear(
          paced,
          reporter,
          year,
          flowCode,
          flow,
          pushRow,
          unclassified_trade,
        );

        if (tariff.rows > 0) {
          if (tariff.truncated) truncatedYears.add(year);
          notes.push(`${flow} ${year}: tariffline HS${tarifflineLength} ${tariff.rows.toLocaleString()} rows`);
          continue;
        }

        notes.push(`${flow} ${year}: tariffline HS${tarifflineLength} available but returned no rows; using HS6 fallback`);
      } else if (tarifflineLength === 6) {
        notes.push(`${flow} ${year}: Comtrade tariffline dataset is HS6; using HS6 directly`);
      } else {
        notes.push(`${flow} ${year}: no tariffline availability; using HS6 fallback`);
      }

      // No deeper tariff-line rows are available for this country/year/flow.
      // Use the standard final-data HS6 endpoint.
      const res = await paced({
        reporterCode: reporter,
        period: String(year),
        cmdCode: 'AG6',
        flowCode,
        maxRecords: MAX_RECORDS,
        breakdownMode: 'classic',
        includeDesc: true,
      });

      if (res.error) {
        notes.push(`${flow} HS6 fallback ${year}: ${res.error}`);
        continue;
      }
      if (res.data.length >= MAX_RECORDS) {
        truncatedYears.add(year);
        notes.push(`${flow} HS6 fallback ${year}: response reached ${MAX_RECORDS.toLocaleString()} records`);
      }

      let fallbackRows = 0;
      for (const r of aggregatesOnly(res.data)) {
        const value = Number(r.primaryValue ?? 0);
        const yearValue = Number(r.refYear ?? r.period ?? 0);
        const hs = hs6CodeOf(r.cmdCode);
        const partnerCode = Number(r.partnerCode ?? -1);
        const partnerIso = r.partnerISO || M49_TO_ISO3[partnerCode] || null;
        if (!(value > 0) || !yearValue || partnerCode <= 0 || !partnerIso) continue;

        const rawHs = String(r.cmdCode ?? '').trim().padStart(6, '0');
        if (isUnclassifiedCode(rawHs, r.cmdDesc)) {
          unclassified_trade.push({
            year: yearValue,
            flow,
            partner_iso3: partnerIso,
            partner_name: r.partnerDesc || ISO3_NAME[partnerIso] || partnerIso,
            value_usd: value,
            qty: r.netWgt ?? null,
            qty_unit: r.netWgt != null ? 'kg' : null,
            source_ref: SOURCE_REF,
          });
          continue;
        }
        if (!hs) continue;

        fallbackRows++;
        pushRow({
          year: yearValue,
          flow,
          stream: 'goods',
          partner_iso3: partnerIso,
          partner_name: r.partnerDesc || ISO3_NAME[partnerIso] || partnerIso,
          hs_code: hs,
          product_name: hs6Label(hs, r.cmdDesc || null),
          sector: hs2Sector(hs),
          value_usd: value,
          qty: r.netWgt ?? null,
          qty_unit: r.netWgt != null ? 'kg' : null,
          source_ref: SOURCE_REF,
        });
      }
      notes.push(`${flow} ${year}: HS6 fallback ${fallbackRows.toLocaleString()} rows`);
    }
  }

  // Preserve 999999-style trade in the canonical facts without pretending
  // it is a product. hs_code=null + a real partner keeps it visible in partner
  // totals while every product query continues to exclude it naturally.
  for (const u of unclassified_trade) {
    pushRow({
      year: u.year,
      flow: u.flow,
      stream: 'goods',
      partner_iso3: u.partner_iso3,
      partner_name: u.partner_name,
      hs_code: null,
      product_name: 'Commodities not specified according to kind',
      sector: null,
      value_usd: u.value_usd,
      qty: u.qty,
      qty_unit: u.qty_unit,
      source_ref: u.source_ref,
    });
  }

  // Chapter rows are generated from the most detailed partner/product rows.
  // They remain the complete concentration level used by the existing
  // analysis engine and do not duplicate the product dataset when a specific
  // product level is selected.
  const chapters = new Map<string, FactRow>();
  for (const row of rows) {
    if (!row.hs_code || ![6, 8, 10].includes(row.hs_code.length) || !row.partner_iso3) continue;
    const chapter = row.hs_code.slice(0, 2);
    const key = `${row.year}|${row.flow}|${chapter}`;
    const existing = chapters.get(key);
    if (existing) {
      existing.value_usd += row.value_usd;
      if (row.qty != null) existing.qty = (existing.qty ?? 0) + row.qty;
    } else {
      chapters.set(key, {
        year: row.year,
        flow: row.flow,
        stream: 'goods',
        partner_iso3: null,
        partner_name: null,
        hs_code: chapter,
        product_name: hs2Label(chapter, null),
        sector: hs2Sector(chapter),
        value_usd: row.value_usd,
        qty: row.qty ?? null,
        qty_unit: row.qty != null ? 'kg' : null,
        source_ref: SOURCE_REF,
      });
    }
  }
  for (const row of chapters.values()) rows.push(row);

  const productRows = rows.filter((r) => [6, 8, 10].includes(r.hs_code?.length ?? 0) && r.partner_iso3);
  const partnerCount = new Set(productRows.map((r) => r.partner_iso3)).size;
  const productCount = new Set(productRows.map((r) => r.hs_code)).size;
  const availableYears = [...new Set(productRows.map((r) => r.year))].sort((a, b) => a - b);
  const levels = [...new Set(productRows.map((r) => r.hs_code?.length ?? 0))].sort((a, b) => b - a);
  const detailLabel = levels.length ? `HS${levels[0]}` : 'none';

  return {
    rows,
    unclassified_trade,
    source_ref: SOURCE_REF,
    ok: productRows.length > 0,
    truncated_years: [...truncatedYears].sort(),
    note: productRows.length
      ? `${productRows.length} partner-product rows from UN Comtrade; ${productCount} product codes across ${partnerCount} partners; deepest stored level ${detailLabel}; years ${availableYears.join(', ') || 'none'}` +
        (notes.length ? ` (${notes.length} extraction notes)` : '')
      : notes.join('; ') || 'no partner-product rows returned',
  };
}

export interface ComtradeAvailability {
  classificationCode: string | null;
  lengthCmdCode: number | null;
  totalRecords: number | null;
  datasetChecksum: string | null;
  lastReleased: string | null;
}

async function fetchAvailability(
  env: Env,
  reporter: number,
  year: number,
  tariffline: boolean,
): Promise<ComtradeAvailability | null> {
  const base = tariffline
    ? (env.COMTRADE_API_KEY ? FULL_TARIFFLINE_AVAIL : PREVIEW_TARIFFLINE_AVAIL)
    : (env.COMTRADE_API_KEY ? FULL_FINAL_AVAIL : PREVIEW_FINAL_AVAIL);
  const url = new URL(base);
  url.searchParams.set('reportercode', String(reporter));
  url.searchParams.set('period', String(year));

  try {
    const res = await fetch(url, {
      headers: {
        accept: 'application/json',
        ...(env.COMTRADE_API_KEY
          ? { 'Ocp-Apim-Subscription-Key': env.COMTRADE_API_KEY }
          : {}),
      },
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { data?: Record<string, unknown>[] };
    const first = Array.isArray(body?.data) ? body.data[0] : null;
    if (!first) return null;
    const n = (key: string) => {
      const value = Number(first[key] ?? 0);
      return Number.isFinite(value) && value > 0 ? value : null;
    };
    return {
      classificationCode: String(first.classificationCode ?? '') || null,
      lengthCmdCode: n('lengthCmdCode'),
      totalRecords: n('totalRecords'),
      datasetChecksum: String(first.datasetChecksum ?? '') || null,
      lastReleased: String(first.lastReleased ?? '') || null,
    };
  } catch {
    return null;
  }
}

/**
 * Cheap per-year Comtrade metadata check. This is deliberately separate from
 * fetchComtrade: callers can determine exactly which years changed before
 * paying for the large partner × product extraction.
 */
export async function getComtradeAvailability(
  env: Env,
  iso3: string,
  years: number[],
  delayMs = 1200,
): Promise<Record<number, { final: ComtradeAvailability | null; tariffline: ComtradeAvailability | null }>> {
  const reporter = ISO3_TO_M49[iso3?.toUpperCase()];
  if (!reporter) return {};
  const out: Record<number, { final: ComtradeAvailability | null; tariffline: ComtradeAvailability | null }> = {};
  let calls = 0;
  for (const year of years) {
    if (calls++) await sleep(Math.max(delayMs, 1200));
    const final = await fetchAvailability(env, reporter, year, false);
    if (calls++) await sleep(Math.max(delayMs, 1200));
    const tariffline = await fetchAvailability(env, reporter, year, true);
    out[year] = { final, tariffline };
  }
  return out;
}

/** Fetch one annual flow from tariffline data, in chapter batches. */
async function fetchTarifflineYear(
  paced: (
    params: Record<string, string | number | boolean>,
    tariffline?: boolean,
  ) => Promise<{ data: ComtradeRow[]; error?: string }>,
  reporter: number,
  year: number,
  flowCode: string,
  flow: 'export' | 'import',
  pushRow: (row: FactRow) => void,
  unclassified: UnclassifiedTradeRow[],
): Promise<{ rows: number; truncated: boolean }> {
  let rows = 0;
  let truncated = false;

  for (let i = 0; i < ALL_CHAPTERS.length; i += CMD_BATCH_SIZE) {
    const batch = ALL_CHAPTERS.slice(i, i + CMD_BATCH_SIZE);
    const result = await fetchTarifflineBatch(
      paced,
      reporter,
      year,
      flowCode,
      flow,
      batch,
      pushRow,
      unclassified,
    );
    rows += result.rows;
    truncated ||= result.truncated;
  }

  return { rows, truncated };
}

/**
 * A 250k response is split again instead of silently accepting an arbitrary
 * slice. This makes the tariffline-first path safe for larger reporters.
 */
async function fetchTarifflineBatch(
  paced: (
    params: Record<string, string | number | boolean>,
    tariffline?: boolean,
  ) => Promise<{ data: ComtradeRow[]; error?: string }>,
  reporter: number,
  year: number,
  flowCode: string,
  flow: 'export' | 'import',
  cmdCodes: string[],
  pushRow: (row: FactRow) => void,
  unclassified: UnclassifiedTradeRow[],
): Promise<{ rows: number; truncated: boolean }> {
  const res = await paced(
    {
      reporterCode: reporter,
      period: String(year),
      cmdCode: cmdCodes.join(','),
      flowCode,
      maxRecords: MAX_RECORDS,
      includeDesc: true,
    },
    true,
  );

  if (res.error) return { rows: 0, truncated: false };

  if (res.data.length >= MAX_RECORDS && cmdCodes.length > 1) {
    const mid = Math.ceil(cmdCodes.length / 2);
    const left = await fetchTarifflineBatch(
      paced,
      reporter,
      year,
      flowCode,
      flow,
      cmdCodes.slice(0, mid),
      pushRow,
      unclassified,
    );
    const right = await fetchTarifflineBatch(
      paced,
      reporter,
      year,
      flowCode,
      flow,
      cmdCodes.slice(mid),
      pushRow,
      unclassified,
    );
    return {
      rows: left.rows + right.rows,
      truncated: left.truncated || right.truncated,
    };
  }

  let written = 0;
  for (const r of aggregatesOnly(res.data)) {
    const value = Number(r.primaryValue ?? 0);
    const yearValue = Number(r.refYear ?? r.period ?? 0);
    const partnerCode = Number(r.partnerCode ?? -1);
    const partnerIso = r.partnerISO || M49_TO_ISO3[partnerCode] || null;
    const code = normalizeProductCode(r.cmdCode);
    if (!(value > 0) || !yearValue || partnerCode <= 0 || !partnerIso) continue;

    if (isUnclassifiedCode(code, r.cmdDesc)) {
      unclassified.push({
        year: yearValue,
        flow,
        partner_iso3: partnerIso,
        partner_name: r.partnerDesc || ISO3_NAME[partnerIso] || partnerIso,
        value_usd: value,
        qty: r.netWgt ?? null,
        qty_unit: r.netWgt != null ? 'kg' : null,
        source_ref: SOURCE_REF,
      });
      continue;
    }

    if (!code || code.length < 6 || code.length > 10) continue;
    written++;
    const hs6 = code.slice(0, 6);
    pushRow({
      year: yearValue,
      flow,
      stream: 'goods',
      partner_iso3: partnerIso,
      partner_name: r.partnerDesc || ISO3_NAME[partnerIso] || partnerIso,
      hs_code: code,
      product_name: productLabel(code, r.cmdDesc || null),
      sector: hs2Sector(hs6),
      value_usd: value,
      qty: r.netWgt ?? null,
      qty_unit: r.netWgt != null ? 'kg' : null,
      source_ref: SOURCE_REF,
    });
  }

  return {
    rows: written,
    truncated: res.data.length >= MAX_RECORDS,
  };
}

function normalizeProductCode(cmdCode: string | undefined): string | null {
  const raw = String(cmdCode ?? '').trim();
  if (!raw || raw.toUpperCase() === 'TOTAL') return null;
  const digits = raw.replace(/\D/g, '');
  return /^\d{6,10}$/.test(digits) ? digits : null;
}

function isUnclassifiedCode(code: string | null, description?: string | null): boolean {
  if (code && /^9{6,10}$/.test(code)) return true;
  return /commodities not specified according to kind/i.test(String(description ?? ''));
}

function productLabel(code: string, description: string | null): string {
  if (description) return description;
  if (code.length === 6) return hs6Label(code, null);
  return hs6Label(code.slice(0, 6), null);
}

export interface ComtradeProbe {
  ok: boolean;
  year: number | null;
  export_usd: number | null;
  import_usd: number | null;
}

export async function probeComtrade(
  env: Env,
  iso3: string,
  candidateYearsDescending: number[],
): Promise<ComtradeProbe> {
  const reporter = ISO3_TO_M49[iso3?.toUpperCase()];
  if (!reporter) return { ok: false, year: null, export_usd: null, import_usd: null };
  const hasKey = Boolean(env.COMTRADE_API_KEY);
  if (!hasKey) return { ok: false, year: null, export_usd: null, import_usd: null };

  // The probe is also subject to the Comtrade address/key rate limit.
  // Keep the same conservative pacing used by the full extraction path.
  let probeCalls = 0;
  const probeDelayMs = 1200;

  for (const year of candidateYearsDescending.slice(0, 2)) {
    const totals: Partial<Record<'export' | 'import', number>> = {};
    for (const [flowCode, flow] of FLOWS) {
      if (probeCalls > 0) await sleep(probeDelayMs);
      probeCalls++;
      const res = await call(env, true, {
        reporterCode: reporter,
        period: String(year),
        cmdCode: 'TOTAL',
        flowCode,
        partnerCode: 0,
      });
      if (res.error) continue;
      for (const r of aggregatesOnly(res.data)) {
        if (Number(r.partnerCode ?? -1) !== 0) continue;
        const value = Number(r.primaryValue ?? 0);
        if (value > 0) totals[flow] = value;
      }
    }
    if (totals.export != null && totals.import != null) {
      return { ok: true, year, export_usd: totals.export, import_usd: totals.import };
    }
  }
  return { ok: false, year: null, export_usd: null, import_usd: null };
}

function hs6CodeOf(cmdCode: string | undefined): string | null {
  const raw = String(cmdCode ?? '').trim();
  if (!raw || raw.toUpperCase() === 'TOTAL') return null;
  const hs = raw.padStart(6, '0');
  if (!/^\d{6}$/.test(hs) || hs.startsWith('00') || hs === '999999') return null;
  return hs;
}

function aggregatesOnly(rows: ComtradeRow[]): ComtradeRow[] {
  const filtered = rows.filter(
    (r) =>
      (r.customsCode ?? 'C00') === 'C00' &&
      Number(r.motCode ?? 0) === 0 &&
      Number(r.partner2Code ?? 0) === 0 &&
      Number(r.mosCode ?? 0) === 0,
  );
  const seen = new Set<string>();
  return filtered.filter((r) => {
    const key = `${r.refYear}|${r.flowCode}|${r.partnerCode}|${r.cmdCode}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class RateLimited extends Error {
  constructor(public readonly retryAfterSeconds: number | null) {
    super('UN Comtrade is rate limiting this address.');
    this.name = 'RateLimited';
  }
}

async function call(
  env: Env,
  hasKey: boolean,
  params: Record<string, string | number | boolean>,
  tariffline = false,
): Promise<{ data: ComtradeRow[]; error?: string }> {
  const base = tariffline
    ? (hasKey ? FULL_TARIFFLINE : PREVIEW_TARIFFLINE)
    : (hasKey ? FULL : PREVIEW);
  const url = new URL(base);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  if (!tariffline) {
    url.searchParams.set('customsCode', 'C00');
    url.searchParams.set('motCode', '0');
    url.searchParams.set('partner2Code', '0');
  }

  let lastError = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(700 * attempt);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(hasKey ? { 'Ocp-Apim-Subscription-Key': env.COMTRADE_API_KEY! } : {}),
        },
        signal: AbortSignal.timeout(60_000),
      });
      if (res.status === 429) {
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(retryAfter * 1000, 1200)
          : 1500;
        if (attempt < 2) {
          await sleep(waitMs);
          continue;
        }
        throw new RateLimited(Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null);
      }
      if (res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) {
        const body = await res.text().catch(() => '');
        return { data: [], error: `HTTP ${res.status}${body ? `: ${body.slice(0, 180)}` : ''}` };
      }
      const body = (await res.json()) as { data?: ComtradeRow[]; error?: string };
      if (body?.error) return { data: [], error: String(body.error) };
      return { data: Array.isArray(body?.data) ? body.data : [] };
    } catch (err) {
      if (err instanceof RateLimited) throw err;
      lastError = err instanceof Error ? err.message : 'fetch failed';
    }
  }
  return { data: [], error: lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Keep this import live in builds where hs6Label is tree-shaken differently;
// HS6 descriptions remain the fallback when a tariffline description is absent.
void HS6_LABEL;
