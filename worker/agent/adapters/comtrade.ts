import type { Env } from '../../lib/db';
import type { AdapterResult, FactRow } from '../types';
import { ISO3_TO_M49, M49_TO_ISO3, hs2Label, hs2Sector } from '../codes';
import { ISO3_NAME } from '../country-names';

const PREVIEW = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const FULL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const SOURCE_REF = 'un-comtrade';

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
 * UN Comtrade is the harmonised backbone.
 *
 * National statistical offices publish in ~90 different shapes, half of them
 * PDF and several in languages the pipeline cannot parse. Those stay as
 * citations and get health-checked weekly. Comtrade puts every country on the
 * same HS classification and the same USD basis, which is the only honest way
 * to compare markets side by side.
 *
 * Two things the API will bite you on, both handled here:
 *  1. The keyless preview endpoint accepts exactly ONE period per call.
 *  2. Every figure repeats across customs procedures and modes of transport.
 *     Without pinning customsCode=C00 and motCode=0 you multiply every number.
 */
export async function fetchComtrade(
  env: Env,
  iso3: string,
  years: number[],
): Promise<AdapterResult> {
  const reporter = ISO3_TO_M49[iso3?.toUpperCase()];
  if (!reporter) {
    return {
      rows: [],
      source_ref: SOURCE_REF,
      ok: false,
      note: `No UN M49 code known for ${iso3}; skipped Comtrade.`,
    };
  }

  const hasKey = Boolean(env.COMTRADE_API_KEY);
  const rows: FactRow[] = [];
  const notes: string[] = [];
  const yearsWithData = new Set<number>();
  // Track per flow so the product pass only targets years that reported both
  // sides. A year with exports but no imports makes a nonsense trade balance.
  const yearsByFlow: Record<'export' | 'import', Set<number>> = {
    export: new Set(),
    import: new Set(),
  };

  // Pass 1 — country totals and partner mix per year.
  // This also tells us which years actually have data.
  for (const [flowCode, flow] of FLOWS) {
    const periods = hasKey ? [years.join(',')] : years.map(String);
    for (const period of periods) {
      const res = await call(env, hasKey, {
        reporterCode: reporter,
        period,
        cmdCode: 'TOTAL',
        flowCode,
      });
      if (res.error) {
        notes.push(`${flow} totals ${period}: ${res.error}`);
        continue;
      }
      for (const r of aggregatesOnly(res.data)) {
        const value = Number(r.primaryValue ?? 0);
        const year = Number(r.refYear ?? r.period ?? 0);
        if (!value || !year) continue;

        const partnerCode = Number(r.partnerCode ?? -1);
        const isWorld = partnerCode === 0;
        const partnerIso = isWorld
          ? null
          : r.partnerISO || M49_TO_ISO3[partnerCode] || null;

        // Comtrade reports aggregates like "Areas, nes" and free-trade zones
        // that have no ISO3. They must never fall through to the world row —
        // doing so corrupts the country total the whole trend hangs off.
        if (!isWorld && !partnerIso) continue;

        yearsWithData.add(year);
        if (isWorld) yearsByFlow[flow].add(year);
        rows.push({
          year,
          flow,
          stream: 'goods',
          partner_iso3: partnerIso,
          partner_name: isWorld
            ? null
            : r.partnerDesc || (partnerIso ? ISO3_NAME[partnerIso] : null) || partnerIso,
          hs_code: null,
          product_name: null,
          sector: null,
          value_usd: value,
          source_ref: SOURCE_REF,
        });
      }
    }
  }

  // Pass 2 — product mix. Costly, so without a key we only pull the years the
  // charts actually need: newest complete year, the one before it, and three
  // years back for the growth rate.
  const completeYears = [...yearsByFlow.export]
    .filter((y) => yearsByFlow.import.has(y))
    .sort((a, b) => b - a);
  const available = completeYears.length
    ? completeYears
    : [...yearsWithData].sort((a, b) => b - a);
  const latest = available[0];
  const productYears = hasKey
    ? years.filter((y) => yearsWithData.has(y))
    : latest
      ? [...new Set([latest, latest - 1, latest - 3])].filter((y) => yearsWithData.has(y))
      : [];

  for (const [flowCode, flow] of FLOWS) {
    const periods = hasKey ? [productYears.join(',')] : productYears.map(String);
    for (const period of periods) {
      if (!period) continue;
      const res = await call(env, hasKey, {
        reporterCode: reporter,
        period,
        partnerCode: '0',
        cmdCode: 'AG2',
        flowCode,
      });
      if (res.error) {
        notes.push(`${flow} products ${period}: ${res.error}`);
        continue;
      }
      for (const r of aggregatesOnly(res.data)) {
        const value = Number(r.primaryValue ?? 0);
        const year = Number(r.refYear ?? r.period ?? 0);
        if (!value || !year) continue;
        const hs = String(r.cmdCode ?? '')
          .padStart(2, '0')
          .slice(0, 2);
        if (!/^\d{2}$/.test(hs)) continue;
        rows.push({
          year,
          flow,
          stream: 'goods',
          partner_iso3: null,
          partner_name: null,
          hs_code: hs,
          product_name: hs2Label(hs, r.cmdDesc || null),
          sector: hs2Sector(hs),
          value_usd: value,
          qty: r.netWgt ?? null,
          qty_unit: r.qtyUnitAbbr ?? null,
          source_ref: SOURCE_REF,
        });
      }
    }
  }

  return {
    rows,
    source_ref: SOURCE_REF,
    ok: rows.length > 0,
    note: rows.length
      ? `${rows.length} rows from UN Comtrade covering ${available.join(', ') || 'no years'}` +
        (notes.length ? ` (${notes.length} partial failures)` : '')
      : notes.join('; ') || 'no rows returned',
  };
}

/**
 * Keep only the fully aggregated slice: all customs procedures (C00), all modes
 * of transport (0), and all second partners (0).
 *
 * Comtrade repeats the same value across each of those sub-dimensions. Skipping
 * any one of them silently corrupts the totals — Germany, for instance, files
 * imports broken down by country of origin as well as country of consignment,
 * so without pinning partner2Code the world total falls off the end of the
 * response and the country appears to import almost nothing.
 */
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

async function call(
  env: Env,
  hasKey: boolean,
  params: Record<string, string | number>,
): Promise<{ data: ComtradeRow[]; error?: string }> {
  const url = new URL(hasKey ? FULL : PREVIEW);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // Pin the fully aggregated slice server-side. Without these the 500-row
  // preview cap is spent on sub-breakdowns and the world total can be cut off.
  url.searchParams.set('customsCode', 'C00');
  url.searchParams.set('motCode', '0');
  url.searchParams.set('partner2Code', '0');

  // Comtrade throttles and occasionally drops a request under load. A single
  // dropped call silently punches a hole in the trend line, so retry.
  let lastError = 'unknown';
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    try {
      const res = await fetch(url, {
        headers: {
          accept: 'application/json',
          ...(hasKey ? { 'Ocp-Apim-Subscription-Key': env.COMTRADE_API_KEY! } : {}),
        },
        signal: AbortSignal.timeout(30_000),
      });
      if (res.status === 429 || res.status >= 500) {
        lastError = `HTTP ${res.status}`;
        continue;
      }
      if (!res.ok) return { data: [], error: `HTTP ${res.status}` };
      const body = (await res.json()) as { data?: ComtradeRow[]; error?: string };
      if (body?.error) return { data: [], error: String(body.error) };
      return { data: Array.isArray(body?.data) ? body.data : [] };
    } catch (err) {
      lastError = err instanceof Error ? err.message : 'fetch failed';
    }
  }
  return { data: [], error: lastError };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
