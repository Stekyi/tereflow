import type { Env } from '../../lib/db';
import type { AdapterResult, FactRow } from '../types';
import { ISO3_TO_M49, M49_TO_ISO3, hs2Label, hs2Sector, hs6Label } from '../codes';
import { ISO3_NAME } from '../country-names';

const PREVIEW = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const FULL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const SOURCE_REF = 'un-comtrade';
const MAX_RECORDS = 250_000;

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
   * Partner-level Comtrade observations reported as HS 999999 / 9999
   * ("Commodities not specified according to kind"). These are retained
   * separately from analytical HS6 facts because they do not identify a product.
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
 * UN Comtrade is the primary trade-data source for Tereflow.
 *
 * Important API behaviour:
 *   - partnerCode omitted => individual partner rows
 *   - partnerCode=0        => World aggregate
 *   - cmdCode=AG6          => HS6 product data
 *   - getFinalData supports up to 250,000 returned records
 *
 * We therefore request HS6 product data for ALL partners in one request per
 * country/year/flow whenever it fits under the API record ceiling. This is
 * fundamentally different from the old chapter-by-chapter / World-only
 * strategy and gives Tereflow the partner × product grain it needs.
 *
 * World totals are retained only as headline/validation rows. Product and
 * partner analysis is based on the individual partner observations.
 */
export async function fetchComtrade(
  env: Env,
  iso3: string,
  years: number[],
  perCallDelayMs = 0,
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
  let callsMade = 0;
  let truncated = false;

  const paced = async (params: Record<string, string | number | boolean>) => {
    if (perCallDelayMs > 0 && callsMade > 0) await sleep(perCallDelayMs);
    callsMade++;
    return call(env, true, params);
  };

  const pushRow = (row: FactRow) => {
    const key = `${row.year}|${row.flow}|${row.partner_iso3 ?? ''}|${row.hs_code ?? ''}`;
    if (seenRows.has(key)) return;
    seenRows.add(key);
    rows.push(row);
  };

  // Headline totals. These are NOT the analytical product dataset; they are
  // retained because the existing analysis layer uses them for country totals
  // and they provide a useful reconciliation check against summed partners.
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

  // Product-level dataset: HS6 × individual partner. No partnerCode is sent.
  // The official Comtrade client documents this exact pattern as the way to
  // retrieve final data from all partners.
  for (const [flowCode, flow] of FLOWS) {
    for (const year of years) {
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
        notes.push(`${flow} HS6 ${year}: ${res.error}`);
        continue;
      }

      if (res.data.length >= MAX_RECORDS) {
        truncated = true;
        notes.push(`${flow} HS6 ${year}: response reached the ${MAX_RECORDS.toLocaleString()}-row API ceiling`);
      }

      // Diagnostic only: for the historical years where the final partner × HS6
      // value does not reconcile to the World headline, inspect the response
      // before any Tereflow normalization/filtering/deduplication. This lets us
      // distinguish a Comtrade response/query issue from a Tereflow transformation.
      if (flow === 'import' && [2021, 2023, 2024].includes(year)) {
        const sumValue = (items: ComtradeRow[]) =>
          items.reduce((sum, r) => sum + Number(r.primaryValue ?? 0), 0);
        const rawPartner = res.data.filter((r) => Number(r.partnerCode ?? -1) > 0);
        const rawPartnerHs6 = rawPartner.filter((r) => Boolean(hs6CodeOf(r.cmdCode)));
        const rawPartnerHs6Positive = rawPartnerHs6.filter((r) => Number(r.primaryValue ?? 0) > 0);
        const filtered = aggregatesOnly(res.data);
        const filteredPartner = filtered.filter((r) => Number(r.partnerCode ?? -1) > 0);
        const filteredPartnerHs6 = filteredPartner.filter((r) => Boolean(hs6CodeOf(r.cmdCode)));
        const candidate = filteredPartnerHs6.filter((r) => {
          const value = Number(r.primaryValue ?? 0);
          const yearValue = Number(r.refYear ?? r.period ?? 0);
          const hs = hs6CodeOf(r.cmdCode);
          const partnerCode = Number(r.partnerCode ?? -1);
          const partnerIso = r.partnerISO || M49_TO_ISO3[partnerCode] || null;
          return value > 0 && Boolean(yearValue) && Boolean(hs) && partnerCode > 0 && Boolean(partnerIso);
        });
        const candidateKeys = new Set<string>();
        let duplicateCandidateCount = 0;
        let duplicateCandidateValue = 0;
        for (const r of candidate) {
          const hs = hs6CodeOf(r.cmdCode);
          const partnerCode = Number(r.partnerCode ?? -1);
          const yearValue = Number(r.refYear ?? r.period ?? 0);
          const key = `${yearValue}|${flow}|${partnerCode}|${hs}`;
          const value = Number(r.primaryValue ?? 0);
          if (candidateKeys.has(key)) {
            duplicateCandidateCount++;
            duplicateCandidateValue += value;
          } else {
            candidateKeys.add(key);
          }
        }

        console.log('');
        console.log(`RAW COMTRADE DIAGNOSTIC — ${year} IMPORT`);
        console.log('------------------------------------------');
        console.log(`Raw API records:                 ${res.data.length.toLocaleString()}`);
        console.log(`Raw API primaryValue:             $${(sumValue(res.data) / 1e9).toFixed(2)}bn`);
        console.log(`Raw partnerCode > 0:              ${rawPartner.length.toLocaleString()} | $${(sumValue(rawPartner) / 1e9).toFixed(2)}bn`);
        console.log(`Raw partner + HS6:                ${rawPartnerHs6.length.toLocaleString()} | $${(sumValue(rawPartnerHs6) / 1e9).toFixed(2)}bn`);
        console.log(`Raw partner + HS6 + value > 0:    ${rawPartnerHs6Positive.length.toLocaleString()} | $${(sumValue(rawPartnerHs6Positive) / 1e9).toFixed(2)}bn`);
        console.log(`After aggregatesOnly:              ${filtered.length.toLocaleString()}`);
        console.log(`After aggregate + partner + HS6:   ${filteredPartnerHs6.length.toLocaleString()} | $${(sumValue(filteredPartnerHs6) / 1e9).toFixed(2)}bn`);
        console.log(`Final candidates before pushRow:   ${candidate.length.toLocaleString()} | $${(sumValue(candidate) / 1e9).toFixed(2)}bn`);
        console.log(`Duplicate candidate rows:          ${duplicateCandidateCount.toLocaleString()} | $${(duplicateCandidateValue / 1e9).toFixed(2)}bn`);
      }

      for (const r of aggregatesOnly(res.data)) {
        const value = Number(r.primaryValue ?? 0);
        const yearValue = Number(r.refYear ?? r.period ?? 0);
        const rawHs = String(r.cmdCode ?? '').trim().padStart(6, '0');
        const hs = hs6CodeOf(r.cmdCode);
        const partnerCode = Number(r.partnerCode ?? -1);
        const partnerIso = r.partnerISO || M49_TO_ISO3[partnerCode] || null;

        if (!(value > 0) || !yearValue || partnerCode <= 0 || !partnerIso) continue;

        if (rawHs === '999999') {
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
    }
  }

  // Build complete HS2 chapter rows from the partner-level HS6 dataset. This
  // avoids a second product API pass while keeping the existing analysis layer
  // able to calculate chapter concentration correctly.
  const chapters = new Map<string, FactRow>();
  for (const row of rows) {
    if (!row.hs_code || row.hs_code.length !== 6 || !row.partner_iso3) continue;
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

  const productRows = rows.filter((r) => r.hs_code?.length === 6 && r.partner_iso3);
  const partnerCount = new Set(productRows.map((r) => r.partner_iso3)).size;
  const productCount = new Set(productRows.map((r) => r.hs_code)).size;
  const availableYears = [...new Set(productRows.map((r) => r.year))].sort((a, b) => a - b);

  return {
    rows,
    unclassified_trade,
    source_ref: SOURCE_REF,
    ok: productRows.length > 0,
    truncated_years: truncated ? availableYears : [],
    note: productRows.length
      ? `${productRows.length} partner-product rows from UN Comtrade; ${productCount} HS6 products across ${partnerCount} partners; years ${availableYears.join(', ') || 'none'}` +
        (notes.length ? ` (${notes.length} request notes)` : '')
      : notes.join('; ') || 'no partner-product rows returned',
  };
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

  for (const year of candidateYearsDescending.slice(0, 2)) {
    const totals: Partial<Record<'export' | 'import', number>> = {};
    for (const [flowCode, flow] of FLOWS) {
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
): Promise<{ data: ComtradeRow[]; error?: string }> {
  const url = new URL(hasKey ? FULL : PREVIEW);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  url.searchParams.set('customsCode', 'C00');
  url.searchParams.set('motCode', '0');
  url.searchParams.set('partner2Code', '0');

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
