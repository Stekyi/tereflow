import type { Env } from '../../lib/db';
import type { AdapterResult, FactRow } from '../types';
import { ISO3_TO_M49, M49_TO_ISO3, hs2Label, hs2Sector, hs6Label } from '../codes';
import { HS6_LABEL } from '../hs6-codes.generated';
import { ISO3_NAME } from '../country-names';

const PREVIEW = 'https://comtradeapi.un.org/public/v1/preview/C/A/HS';
const FULL = 'https://comtradeapi.un.org/data/v1/get/C/A/HS';
const SOURCE_REF = 'un-comtrade';

/**
 * Rows the keyless preview endpoint returns before it stops. A response of
 * exactly this length has been cut off rather than completed, and the rows
 * kept are not the largest ones, so anything derived from comparing two
 * capped responses is meaningless.
 */
const PREVIEW_ROW_CAP = 500;

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
  perCallDelayMs = 0,
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
  const seenRows = new Set<string>();
  const notes: string[] = [];
  const yearsWithData = new Set<number>();
  // Track per flow so the product pass only targets years that reported both
  // sides. A year with exports but no imports makes a nonsense trade balance.
  const yearsByFlow: Record<'export' | 'import', Set<number>> = {
    export: new Set(),
    import: new Set(),
  };

  // Defensive: aggregatesOnly() only dedupes within one response. Nothing
  // upstream currently produces overlapping periods across calls, but a
  // duplicate row here would silently double-count a country's whole trade
  // total, so the cheapest possible guard is applied at the point everything
  // funnels through anyway.
  const pushRow = (row: FactRow) => {
    const key = `${row.year}|${row.flow}|${row.partner_iso3 ?? ''}|${row.hs_code ?? ''}`;
    if (seenRows.has(key)) return;
    seenRows.add(key);
    rows.push(row);
  };

  let callsMade = 0;
  const paced = async (params: Record<string, string | number>) => {
    if (perCallDelayMs > 0 && callsMade > 0) await sleep(perCallDelayMs);
    callsMade++;
    return call(env, hasKey, params);
  };

  // Pass 1 — country totals and partner mix per year.
  // This also tells us which years actually have data.
  for (const [flowCode, flow] of FLOWS) {
    const periods = hasKey ? [years.join(',')] : years.map(String);
    for (const period of periods) {
      const res = await paced({
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
        if (!(value > 0) || !year) continue;

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
        pushRow({
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

  // Pass 2 — product mix, at two levels of detail.
  //
  // AG2 (~97 chapters) always fits inside the keyless 500-row preview cap, so
  // it is complete and safe to compute totals, shares and concentration from.
  //
  // AG6 is the specific tradeable line ("guavas, mangoes and mangosteens",
  // not "Fruit & nuts") and is the whole reason somebody opens this app. A
  // country reports thousands of those, and a plain cmdCode=AG6 request comes
  // back cut off at the cap, in an arbitrary order that differs year to year.
  // Comparing two such slices produces invented growth rates.
  //
  // So AG6 is requested one HS chapter at a time, passing that chapter's
  // explicit code list. A single chapter holds at most a few hundred lines, so
  // each response is complete, and the same chapter is comparable across
  // years. Chapters are taken in descending order of value until the covered
  // share passes CHAPTER_COVERAGE_TARGET, which keeps the call count bounded
  // while still covering what the country actually trades.
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

  const truncatedYears = new Set<number>();

  // Pass 2a — chapters. Complete, and it tells us where the trade actually is.
  const chapterValue = new Map<string, number>();
  for (const [flowCode, flow] of FLOWS) {
    const periods = hasKey ? [productYears.join(',')] : productYears.map(String);
    for (const period of periods) {
      if (!period) continue;
      const res = await paced({
        reporterCode: reporter,
        period,
        partnerCode: '0',
        cmdCode: 'AG2',
        flowCode,
      });
      if (res.error) {
        notes.push(`${flow} chapters ${period}: ${res.error}`);
        continue;
      }
      for (const r of aggregatesOnly(res.data)) {
        const value = Number(r.primaryValue ?? 0);
        const year = Number(r.refYear ?? r.period ?? 0);
        if (!(value > 0) || !year) continue;
        const hs = hs2CodeOf(r.cmdCode);
        if (!hs) continue;
        if (year === latest) chapterValue.set(hs, (chapterValue.get(hs) ?? 0) + value);
        pushRow({
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

  // Pass 2b — specific lines, chapter by chapter.
  //
  // Only the two years the growth rate is measured between. The intermediate
  // year is used for the year-on-year figure, which is only ever shown at
  // chapter level, so fetching it per chapter would add a third of the calls
  // in this pass for nothing.
  const detailYears = hasKey
    ? productYears
    : productYears.filter((y) => y === latest || y === Math.min(...productYears));
  const chapters = chaptersToDetail(chapterValue);
  for (const chapter of chapters) {
    const codes = hs6CodesInChapter(chapter);
    if (!codes.length) continue;
    for (const [flowCode, flow] of FLOWS) {
      const periods = hasKey ? [detailYears.join(',')] : detailYears.map(String);
      for (const period of periods) {
        if (!period) continue;
        const res = await paced({
          reporterCode: reporter,
          period,
          partnerCode: '0',
          cmdCode: codes.join(','),
          flowCode,
        });
        if (res.error) {
          notes.push(`${flow} chapter ${chapter} ${period}: ${res.error}`);
          continue;
        }
        // A chapter should never fill the cap. If one does, its lines were cut
        // off and the year is not comparable for that chapter.
        if (res.data.length >= PREVIEW_ROW_CAP) {
          for (const y of period.split(',')) truncatedYears.add(Number(y));
        }
        for (const r of aggregatesOnly(res.data)) {
          const value = Number(r.primaryValue ?? 0);
          const year = Number(r.refYear ?? r.period ?? 0);
          if (!(value > 0) || !year) continue;
          const hs = hs6CodeOf(r.cmdCode);
          if (!hs) continue;
          pushRow({
            year,
            flow,
            stream: 'goods',
            partner_iso3: null,
            partner_name: null,
            hs_code: hs,
            product_name: hs6Label(hs, r.cmdDesc || null),
            sector: hs2Sector(hs),
            value_usd: value,
            qty: r.netWgt ?? null,
            qty_unit: r.qtyUnitAbbr ?? null,
            source_ref: SOURCE_REF,
          });
        }
      }
    }
  }

  const coveredShare = shareCovered(chapterValue, chapters);
  const truncationNote = truncatedYears.size
    ? ` Specific-product detail was capped by the source in ${[...truncatedYears].sort().join(', ')}.`
    : '';
  const coverageNote = chapters.length
    ? ` Specific products cover the ${chapters.length} largest chapters, ${(coveredShare * 100).toFixed(0)}% of goods trade.`
    : '';

  return {
    rows,
    source_ref: SOURCE_REF,
    ok: rows.length > 0,
    truncated_years: [...truncatedYears].sort(),
    note: rows.length
      ? `${rows.length} rows from UN Comtrade covering ${available.join(', ') || 'no years'}` +
        (notes.length ? ` (${notes.length} partial failures)` : '') +
        coverageNote +
        truncationNote
      : notes.join('; ') || 'no rows returned',
  };
}

/**
 * How much of a country's goods trade the specific-product pass tries to
 * cover, and the hard ceiling on how many chapters that is allowed to cost.
 *
 * Each chapter is one API call per year per flow, so the ceiling is what keeps
 * a diversified economy from turning into hundreds of calls. Concentrated
 * economies reach the target in a handful of chapters and stop early.
 */
const CHAPTER_COVERAGE_TARGET = 0.92;
const MAX_DETAIL_CHAPTERS = 22;

function chaptersToDetail(chapterValue: Map<string, number>): string[] {
  const total = [...chapterValue.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return [];
  const ranked = [...chapterValue.entries()].sort((a, b) => b[1] - a[1]);
  const picked: string[] = [];
  let running = 0;
  for (const [chapter, value] of ranked) {
    if (picked.length >= MAX_DETAIL_CHAPTERS) break;
    picked.push(chapter);
    running += value;
    if (running / total >= CHAPTER_COVERAGE_TARGET) break;
  }
  return picked;
}

function shareCovered(chapterValue: Map<string, number>, chapters: string[]): number {
  const total = [...chapterValue.values()].reduce((s, v) => s + v, 0);
  if (total <= 0) return 0;
  return chapters.reduce((s, c) => s + (chapterValue.get(c) ?? 0), 0) / total;
}

/** Every HS6 code belonging to one chapter, from the static HS reference. */
function hs6CodesInChapter(chapter: string): string[] {
  const cached = CHAPTER_CODES.get(chapter);
  if (cached) return cached;
  const codes = Object.keys(HS6_LABEL).filter((c) => c.startsWith(chapter));
  CHAPTER_CODES.set(chapter, codes);
  return codes;
}

const CHAPTER_CODES = new Map<string, string[]>();

export interface ComtradeProbe {
  ok: boolean;
  year: number | null;
  export_usd: number | null;
  import_usd: number | null;
}

/**
 * A cheap stand-in for the full fetch above, used to decide whether a country
 * needs the full fetch at all (see local/pipeline.ts). Tries the most recent
 * candidate year first (world totals only, both flows = 2 calls) and falls
 * back one year if that's empty, so it costs 2-4 calls instead of the ~18 a
 * full fetchComtrade() makes keyless.
 */
export async function probeComtrade(
  env: Env,
  iso3: string,
  candidateYearsDescending: number[],
): Promise<ComtradeProbe> {
  const reporter = ISO3_TO_M49[iso3?.toUpperCase()];
  if (!reporter) return { ok: false, year: null, export_usd: null, import_usd: null };
  const hasKey = Boolean(env.COMTRADE_API_KEY);

  for (const year of candidateYearsDescending.slice(0, 2)) {
    const totals: Partial<Record<'export' | 'import', number>> = {};
    for (const [flowCode, flow] of FLOWS) {
      const res = await call(env, hasKey, {
        reporterCode: reporter,
        period: String(year),
        cmdCode: 'TOTAL',
        flowCode,
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

/**
 * Chapter code from an AG2 response. A blank code must never be padded into
 * "00", which is not a real chapter, or unclassified trade would be filed
 * under live animals.
 */
function hs2CodeOf(cmdCode: string | undefined): string | null {
  const raw = String(cmdCode ?? '').trim();
  if (!raw || raw.toUpperCase() === 'TOTAL') return null;
  const hs = raw.padStart(2, '0').slice(0, 2);
  return /^\d{2}$/.test(hs) && hs !== '00' ? hs : null;
}

/**
 * A missing/empty cmdCode must never be treated as chapter "00" -- that
 * chapter doesn't exist, so a blank code silently masquerading as it would
 * corrupt the product mix with a fake category. Also reject anything that
 * isn't a genuine 6-digit leaf code (a shorter code here would mean the API
 * handed back a parent/aggregate row instead of the specific line asked for).
 */
function hs6CodeOf(cmdCode: string | undefined): string | null {
  const raw = String(cmdCode ?? '').trim();
  if (!raw || raw === 'TOTAL') return null;
  const hs = raw.padStart(6, '0');
  if (!/^\d{6}$/.test(hs) || hs.startsWith('00')) return null;
  // 999999 is Comtrade's "commodities not specified according to kind" --
  // real in the totals but not an actual product anyone is shopping for.
  if (hs === '999999') return null;
  return hs;
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
