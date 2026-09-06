import type {
  Overview,
  RankedItem,
  Recommendation,
  TrendPoint,
} from '../../shared/types';
import type { FactRow } from './types';
import type { WorldBankContext } from './adapters/worldbank';
import { hs2Sector } from './codes';

export interface AnalysisBundle {
  overview: Overview;
  top_exports: RankedItem[];
  top_imports: RankedItem[];
  services: RankedItem[];
  partners_export: RankedItem[];
  partners_import: RankedItem[];
  yearly_trend: TrendPoint[];
  recommendations: Recommendation[];
  signals: SignalDraft[];
}

export interface SignalDraft {
  hs_code: string | null;
  product_name: string;
  flow: 'export' | 'import';
  cagr_3y: number | null;
  momentum: number;
  current_rank: number | null;
  projected_rank: number | null;
  horizon_years: number;
  confidence: number | null;
  rationale: string;
}

const TOP_N = 12;

export function analyse(
  entityName: string,
  rows: FactRow[],
  context: WorldBankContext,
  sourceRefs: string[],
): AnalysisBundle {
  // A year only counts for headline figures if BOTH flows reported a world
  // total. Otherwise the trade balance is comparing a number against nothing.
  const worldTotalYears = (flow: 'export' | 'import') =>
    new Set(
      rows
        .filter(
          (r) =>
            r.flow === flow &&
            r.stream === 'goods' &&
            r.hs_code === null &&
            r.partner_iso3 === null &&
            r.year > 1900,
        )
        .map((r) => r.year),
    );
  const expYears = worldTotalYears('export');
  const impYears = worldTotalYears('import');
  const goodsYears = [...expYears].filter((y) => impYears.has(y)).sort((a, b) => a - b);

  const allYears = [...new Set(rows.map((r) => r.year))].filter((y) => y > 1900).sort((a, b) => a - b);
  const years = goodsYears.length ? goodsYears : allYears;
  const latest = years[years.length - 1] ?? new Date().getUTCFullYear() - 2;
  const prev = years[years.length - 2] ?? null;

  // The product breakdown is fetched for fewer years than the totals, so pick
  // the newest year that actually has products rather than assuming `latest`.
  const productYears = [
    ...new Set(
      rows.filter((r) => r.stream === 'goods' && r.hs_code && r.year > 1900).map((r) => r.year),
    ),
  ].sort((a, b) => a - b);
  const productYear =
    [...productYears].reverse().find((y) => y <= latest) ??
    productYears[productYears.length - 1] ??
    latest;

  const trend = buildTrend(rows, years);
  const latestPoint = trend.find((t) => t.year === latest);
  const prevPoint = prev ? trend.find((t) => t.year === prev) : undefined;

  const topExports = rankProducts(rows, 'export', productYear, productYears);
  const topImports = rankProducts(rows, 'import', productYear, productYears);
  const partnersExport = rankPartners(rows, 'export', latest, years);
  const partnersImport = rankPartners(rows, 'import', latest, years);
  const services = rankServices(context, latest);

  const exportTotal = latestPoint?.export_usd ?? 0;
  const importTotal = latestPoint?.import_usd ?? 0;

  const exportChapterShares = chapterSharesFor(rows, 'export', productYear);

  const overview: Overview = {
    year: latest,
    export_usd: exportTotal,
    import_usd: importTotal,
    balance_usd: exportTotal - importTotal,
    total_trade_usd: exportTotal + importTotal,
    export_yoy_pct: pctChange(prevPoint?.export_usd, exportTotal),
    import_yoy_pct: pctChange(prevPoint?.import_usd, importTotal),
    export_concentration: herfindahl(Object.values(exportChapterShares)),
    // Chapter (2-digit) shares of exports, e.g. { "71": 0.63, "18": 0.14 }.
    // Feeds the traditional/non-traditional dominant-commodity heuristic
    // (see worker/lib/classify.ts) -- kept here because it needs the full
    // distribution, not just the top TOP_N products that get stored/shown.
    export_chapter_shares: exportChapterShares,
    partner_count: new Set(
      rows.filter((r) => r.year === latest && r.partner_iso3).map((r) => r.partner_iso3),
    ).size,
    product_count: new Set(
      rows.filter((r) => r.year === productYear && r.hs_code).map((r) => r.hs_code),
    ).size,
    services_export_usd: nearestYear(context.services_export_by_year, latest)?.value ?? null,
    services_import_usd: nearestYear(context.services_import_by_year, latest)?.value ?? null,
    data_sources: sourceRefs,
    coverage_note: buildCoverageNote(years, latest, productYear),
  };

  const signals = [
    ...detectSignals(rows, 'export', productYears, topExports),
    ...detectSignals(rows, 'import', productYears, topImports),
  ]
    .sort((a, b) => b.momentum - a.momentum)
    .slice(0, 12);

  const recommendations = recommend(
    entityName,
    overview,
    topExports,
    topImports,
    partnersExport,
    partnersImport,
    signals,
    context,
    latest,
  );

  return {
    overview,
    top_exports: topExports,
    top_imports: topImports,
    services,
    partners_export: partnersExport,
    partners_import: partnersImport,
    yearly_trend: trend,
    recommendations,
    signals,
  };
}

// --- building blocks --------------------------------------------------------

function buildTrend(rows: FactRow[], years: number[]): TrendPoint[] {
  return years.map((year) => {
    // Country totals come from the partner rows (cmdCode=TOTAL against World),
    // falling back to summing the product mix when the total row is absent.
    const exp = totalFor(rows, year, 'export');
    const imp = totalFor(rows, year, 'import');
    return { year, export_usd: exp, import_usd: imp, balance_usd: exp - imp };
  });
}

function totalFor(rows: FactRow[], year: number, flow: 'export' | 'import'): number {
  const worldRow = rows.find(
    (r) =>
      r.year === year &&
      r.flow === flow &&
      r.stream === 'goods' &&
      r.hs_code === null &&
      r.partner_iso3 === null,
  );
  if (worldRow) return worldRow.value_usd;
  return rows
    .filter((r) => r.year === year && r.flow === flow && r.stream === 'goods' && r.hs_code)
    .reduce((sum, r) => sum + r.value_usd, 0);
}

function rankProducts(
  rows: FactRow[],
  flow: 'export' | 'import',
  latest: number,
  years: number[],
): RankedItem[] {
  const current = rows.filter(
    (r) => r.year === latest && r.flow === flow && r.stream === 'goods' && r.hs_code,
  );
  const total = current.reduce((s, r) => s + r.value_usd, 0);
  if (total <= 0) return [];

  const threeBack = nearestPastYear(years, latest - 3, latest);
  const prevYear = previousYear(years, latest);

  return current
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, TOP_N)
    .map((r, i) => {
      const past = threeBack != null ? valueOf(rows, threeBack, flow, r.hs_code) : undefined;
      const last = prevYear != null ? valueOf(rows, prevYear, flow, r.hs_code) : undefined;
      return {
        rank: i + 1,
        code: r.hs_code,
        name: r.product_name ?? r.hs_code ?? 'Unclassified',
        value_usd: r.value_usd,
        share_pct: (r.value_usd / total) * 100,
        cagr_3y: threeBack != null ? cagr(past, r.value_usd, latest - threeBack) : null,
        yoy_pct: pctChange(last, r.value_usd),
      };
    });
}

/**
 * Every reported product rolled up to its 2-digit HS chapter, as a share
 * (0..1) of that year's total, over the whole distribution -- not just the
 * top TOP_N shown to the user, or it silently understates concentration for
 * economies with a long tail of similarly-sized products past rank 12.
 *
 * Chapter-level, not per-line-item: products are now stored at the specific
 * HS6 line ("pineapples, fresh or dried"), and several distinct lines can be
 * the same underlying commodity split into forms/grades (several gold
 * sub-headings, say). Computing concentration per-line would make a
 * genuinely concentrated economy look artificially diversified.
 */
function chapterSharesFor(
  rows: FactRow[],
  flow: 'export' | 'import',
  year: number,
): Record<string, number> {
  const current = rows.filter(
    (r) => r.year === year && r.flow === flow && r.stream === 'goods' && r.hs_code,
  );
  const total = current.reduce((s, r) => s + r.value_usd, 0);
  if (total <= 0) return {};
  const byChapter = new Map<string, number>();
  for (const r of current) {
    const ch = (r.hs_code as string).slice(0, 2);
    byChapter.set(ch, (byChapter.get(ch) ?? 0) + r.value_usd);
  }
  return Object.fromEntries([...byChapter].map(([ch, v]) => [ch, v / total]));
}

function rankPartners(
  rows: FactRow[],
  flow: 'export' | 'import',
  latest: number,
  years: number[],
): RankedItem[] {
  const current = rows.filter(
    (r) => r.year === latest && r.flow === flow && r.stream === 'goods' && r.partner_iso3,
  );
  const total = current.reduce((s, r) => s + r.value_usd, 0);
  if (total <= 0) return [];

  const threeBack = nearestPastYear(years, latest - 3, latest);
  const prevYear = previousYear(years, latest);

  return current
    .sort((a, b) => b.value_usd - a.value_usd)
    .slice(0, TOP_N)
    .map((r, i) => {
      const past = threeBack != null ? partnerValue(rows, threeBack, flow, r.partner_iso3) : undefined;
      const last = prevYear != null ? partnerValue(rows, prevYear, flow, r.partner_iso3) : undefined;
      return {
        rank: i + 1,
        code: r.partner_iso3,
        name: r.partner_name ?? r.partner_iso3 ?? 'Unknown',
        value_usd: r.value_usd,
        share_pct: (r.value_usd / total) * 100,
        cagr_3y: threeBack != null ? cagr(past, r.value_usd, latest - threeBack) : null,
        yoy_pct: pctChange(last, r.value_usd),
      };
    });
}

function rankServices(context: WorldBankContext, latest: number): RankedItem[] {
  const out: RankedItem[] = [];
  const se = nearestYear(context.services_export_by_year, latest);
  const si = nearestYear(context.services_import_by_year, latest);
  const total = (se?.value ?? 0) + (si?.value ?? 0);
  if (total <= 0) return out;
  if (se != null)
    out.push({
      rank: 1,
      code: 'SRV-X',
      name: 'Commercial services exported',
      value_usd: se.value,
      share_pct: (se.value / total) * 100,
      cagr_3y: cagr(nearestYear(context.services_export_by_year, se.year - 3)?.value, se.value, 3),
      yoy_pct: pctChange(nearestYear(context.services_export_by_year, se.year - 1, 0)?.value, se.value),
    });
  if (si != null)
    out.push({
      rank: 2,
      code: 'SRV-M',
      name: 'Commercial services imported',
      value_usd: si.value,
      share_pct: (si.value / total) * 100,
      cagr_3y: cagr(nearestYear(context.services_import_by_year, si.year - 3)?.value, si.value, 3),
      yoy_pct: pctChange(nearestYear(context.services_import_by_year, si.year - 1, 0)?.value, si.value),
    });
  return out;
}

function valueOf(
  rows: FactRow[],
  year: number,
  flow: 'export' | 'import',
  hs: string | null,
): number | undefined {
  const r = rows.find(
    (x) => x.year === year && x.flow === flow && x.stream === 'goods' && x.hs_code === hs,
  );
  return r?.value_usd;
}

function partnerValue(
  rows: FactRow[],
  year: number,
  flow: 'export' | 'import',
  iso: string | null,
): number | undefined {
  const r = rows.find(
    (x) => x.year === year && x.flow === flow && x.stream === 'goods' && x.partner_iso3 === iso,
  );
  return r?.value_usd;
}

// --- maths ------------------------------------------------------------------

function pctChange(from: number | undefined, to: number): number | null {
  if (from == null || from <= 0 || !isFinite(to)) return null;
  return ((to - from) / from) * 100;
}

function cagr(from: number | undefined, to: number, periods: number): number | null {
  if (from == null || from <= 0 || to <= 0 || periods <= 0) return null;
  return (Math.pow(to / from, 1 / periods) - 1) * 100;
}

/**
 * The year immediately before `year` in a sorted-ascending, possibly gappy
 * years[] -- e.g. [2019,2021,2022] -> previousYear(2022) is 2021, not 2019 and
 * not the arithmetic `2021` guessed blindly. Mirrors how the headline
 * overview already finds its previous year (`years[years.length-2]`); this
 * generalises that to work when `year` isn't necessarily the last entry.
 */
function previousYear(years: number[], year: number): number | undefined {
  const idx = years.indexOf(year);
  return idx > 0 ? years[idx - 1] : undefined;
}

/**
 * The available year closest to `target`, restricted to years strictly
 * before `before`. Used for the "3 years back" CAGR window so a missing
 * exact year picks the nearest real one instead of silently jumping all the
 * way back to the earliest year on record.
 */
function nearestPastYear(years: number[], target: number, before: number): number | undefined {
  let best: number | undefined;
  let bestDist = Infinity;
  for (const y of years) {
    if (y >= before) continue;
    const dist = Math.abs(y - target);
    if (dist < bestDist) {
      bestDist = dist;
      best = y;
    }
  }
  return best;
}

/**
 * Herfindahl-Hirschman index over export shares, normalised 0..1, computed
 * over every reported product for the year (see productSharesFor) so it is
 * the true concentration, not an artifact of how many products are displayed.
 * Above ~0.25 the country is dangerously dependent on a handful of products —
 * the single most useful risk number for an investor.
 */
function herfindahl(shares: number[]): number | null {
  if (!shares.length) return null;
  return shares.reduce((sum, s) => sum + s * s, 0);
}

/**
 * WB data can lag Comtrade's latest year by 1-2 years; search backward for
 * the nearest year with a real value instead of requiring an exact match,
 * which otherwise silently drops good data whenever the two sources' latest
 * years don't line up exactly.
 */
function nearestYear(
  byYear: Record<number, number>,
  year: number,
  maxBack = 2,
): { year: number; value: number } | undefined {
  for (let y = year; y >= year - maxBack; y--) {
    if (byYear[y] != null) return { year: y, value: byYear[y] };
  }
  return undefined;
}

function buildCoverageNote(
  years: number[],
  latest: number,
  productYear: number,
): string | null {
  const notes: string[] = [];
  const thisYear = new Date().getUTCFullYear();
  const lag = thisYear - latest;
  if (lag >= 3)
    notes.push(
      `Most recent year with both exports and imports reported is ${latest}. Trade statistics normally lag by 1–2 years; this one lags by ${lag}.`,
    );
  if (years.length < 3)
    notes.push(
      `Only ${years.length} comparable year${years.length === 1 ? '' : 's'} available, so trend lines are indicative.`,
    );
  if (productYear !== latest)
    notes.push(
      `Headline totals are for ${latest}; the product breakdown is the most recent available, ${productYear}.`,
    );
  const gaps = years.length > 1 ? years[years.length - 1] - years[0] + 1 - years.length : 0;
  if (gaps > 0)
    notes.push(`${gaps} year${gaps === 1 ? '' : 's'} in this range were not reported and are omitted from the chart.`);
  return notes.length ? notes.join(' ') : null;
}

// --- the premium signal engine ---------------------------------------------

/**
 * An opportunity is a product that is growing fast, is not yet a headline
 * export, and is big enough to be real. Cocoa pod husk before it becomes a
 * category, rather than cocoa beans after everybody knows.
 */
function detectSignals(
  rows: FactRow[],
  flow: 'export' | 'import',
  years: number[],
  currentTop: RankedItem[],
): SignalDraft[] {
  if (years.length < 3) return [];
  const latest = years[years.length - 1];
  const base = nearestPastYear(years, latest - 3, latest);
  if (base == null) return [];
  const span = latest - base;
  if (span < 2) return [];

  const current = rows.filter(
    (r) => r.year === latest && r.flow === flow && r.stream === 'goods' && r.hs_code,
  );
  const total = current.reduce((s, r) => s + r.value_usd, 0);
  if (total <= 0) return [];

  const topCodes = new Set(currentTop.slice(0, 5).map((t) => t.code));
  const ranked = [...current].sort((a, b) => b.value_usd - a.value_usd);
  const rankOf = new Map(ranked.map((r, i) => [r.hs_code, i + 1]));

  const drafts: SignalDraft[] = [];

  for (const r of current) {
    // HS 99 is "commodities not elsewhere specified". It is real in the totals
    // but meaningless as an investment signal, so it never gets surfaced.
    if (r.hs_code === '99') continue;

    const past = valueOf(rows, base, flow, r.hs_code);
    const growth = cagr(past, r.value_usd, span);
    if (growth == null) continue;

    const share = r.value_usd / total;
    // Filter out noise: must be at least 0.2% of trade and growing above 8%/yr.
    if (share < 0.002 || growth < 8) continue;
    // Already a headline product — not an early signal.
    if (topCodes.has(r.hs_code)) continue;

    const shareGain = past ? share - past / sumYear(rows, base, flow) : share;
    const consistency = consistencyScore(rows, flow, r.hs_code, years);

    // Momentum blends how fast it grows, how much share it took, and whether
    // the growth was steady rather than one freak year.
    const momentum = clamp01(
      0.5 * clamp01(growth / 60) + 0.3 * clamp01(shareGain * 40) + 0.2 * consistency,
    );
    if (momentum < 0.25) continue; // below this the signal is too weak to be worth surfacing

    const rank = rankOf.get(r.hs_code) ?? null;
    const projected = rank ? Math.max(1, Math.round(rank * (1 - clamp01(growth / 100)))) : null;

    drafts.push({
      hs_code: r.hs_code,
      product_name: r.product_name ?? r.hs_code ?? 'Unclassified',
      flow,
      cagr_3y: growth,
      momentum,
      current_rank: rank,
      projected_rank: projected,
      // Fixed presentation horizon -- deliberately independent of `span`
      // (the variable CAGR lookback window above), not a bug.
      horizon_years: 4,
      confidence: clamp01(0.4 + 0.4 * consistency + 0.2 * clamp01(share * 30)),
      rationale:
        `${sector(r.hs_code)}: growing ${growth.toFixed(0)}% a year since ${base}, ` +
        `now ${(share * 100).toFixed(2)}% of ${flow}s at rank ${rank ?? '?'}. ` +
        (consistency > 0.6
          ? 'Growth has been steady rather than a single spike.'
          : 'Growth is uneven, so treat the projection as directional.'),
    });
  }

  return drafts.sort((a, b) => b.momentum - a.momentum).slice(0, 8);
}

function sumYear(rows: FactRow[], year: number, flow: 'export' | 'import'): number {
  const t = rows
    .filter((r) => r.year === year && r.flow === flow && r.stream === 'goods' && r.hs_code)
    .reduce((s, r) => s + r.value_usd, 0);
  return t || 1;
}

/** Fraction of year-on-year steps that were positive. Rewards steady climbers. */
function consistencyScore(
  rows: FactRow[],
  flow: 'export' | 'import',
  hs: string | null,
  years: number[],
): number {
  const series = years
    .map((y) => valueOf(rows, y, flow, hs))
    .filter((v): v is number => v != null && v > 0);
  if (series.length < 3) return 0.3;
  let up = 0;
  for (let i = 1; i < series.length; i++) if (series[i] > series[i - 1]) up++;
  return up / (series.length - 1);
}

function sector(hs: string | null): string {
  return hs2Sector(hs);
}

function clamp01(n: number): number {
  if (!isFinite(n)) return 0;
  return Math.max(0, Math.min(1, n));
}

// --- the plain-English layer ------------------------------------------------

/**
 * Turns the numbers into the handful of sentences an investor actually reads.
 * Every recommendation carries its evidence so nothing here is a black box.
 */
function recommend(
  name: string,
  overview: Overview,
  topExports: RankedItem[],
  topImports: RankedItem[],
  partnersExport: RankedItem[],
  partnersImport: RankedItem[],
  signals: SignalDraft[],
  context: WorldBankContext,
  latest: number,
): Recommendation[] {
  const out: Recommendation[] = [];
  const usd = (v: number) => `$${(v / 1e9).toFixed(1)}bn`;

  // 1. Concentration risk.
  const hhi = overview.export_concentration;
  if (hhi != null && topExports.length) {
    const lead = topExports[0];
    if (hhi > 0.25) {
      out.push({
        headline: `${name} leans heavily on ${lead.name.toLowerCase()}`,
        detail:
          `${lead.name} alone is ${lead.share_pct.toFixed(0)}% of exports. A concentrated ` +
          `export base means a price shock in one market moves the whole economy, and it ` +
          `also means the supporting trade infrastructure is built around that product.`,
        angle: 'risk',
        strength: hhi > 0.4 ? 'strong' : 'moderate', // 0.4 = textbook "highly concentrated" HHI cutoff
        evidence: [
          `Export concentration (HHI) ${hhi.toFixed(2)} on the top ${topExports.length} products`,
          `${lead.name}: ${usd(lead.value_usd)} in ${latest}`,
        ],
      });
    } else if (hhi < 0.12) {
      // 0.12 = textbook "unconcentrated" HHI cutoff -- the mirror image of 0.25 above.
      out.push({
        headline: `${name} has a broad export base`,
        detail:
          `No single product dominates. The largest is ${lead.name.toLowerCase()} at ` +
          `${lead.share_pct.toFixed(0)}%. Diversified exporters are more resilient and ` +
          `usually have the customs, logistics and finance capacity to handle varied goods.`,
        angle: 'entry',
        strength: 'moderate',
        evidence: [`Export concentration (HHI) ${hhi.toFixed(2)}`],
      });
    }
  }

  // 2. Import gaps — what the country buys is what you could sell it.
  // 10%/yr = "clearly rising" floor; top 3 keeps the headline scannable.
  const risingImports = topImports
    .filter((p) => (p.cagr_3y ?? 0) > 10)
    .slice(0, 3);
  if (risingImports.length) {
    out.push({
      headline: `Growing demand for ${risingImports.map((p) => p.name.toLowerCase()).join(', ')}`,
      detail:
        `These are the fastest-growing things ${name} buys from abroad. Rising imports mean ` +
        `domestic demand is outpacing domestic supply. That gap is either a place to sell ` +
        `into, or a place to produce locally and displace the import.`,
      angle: 'gap',
      strength: risingImports[0].cagr_3y! > 20 ? 'strong' : 'moderate', // 20%/yr = "strong" gap floor
      evidence: risingImports.map(
        (p) => `${p.name}: ${usd(p.value_usd)}, growing ${p.cagr_3y!.toFixed(0)}%/yr`,
      ),
    });
  }

  // 3. Partner concentration — who you would really be selling to.
  if (partnersExport.length) {
    const top3 = partnersExport.slice(0, 3);
    const share = top3.reduce((s, p) => s + p.share_pct, 0);
    // 60% = "narrow routes" floor for the top 3 partners combined.
    out.push({
      headline: `${top3.map((p) => p.name).join(', ')} take ${share.toFixed(0)}% of exports`,
      detail:
        share > 60
          ? `Export routes are narrow. Trade finance, shipping lanes and standards compliance ` +
            `are all built around these markets, which lowers your setup cost if you sell into ` +
            `them and raises it sharply if you do not.`
          : `Export destinations are reasonably spread, which means established routes and ` +
            `documentation for several markets rather than just one.`,
      angle: 'partner',
      strength: share > 60 ? 'strong' : 'moderate',
      evidence: top3.map((p) => `${p.name}: ${p.share_pct.toFixed(1)}% (${usd(p.value_usd)})`),
    });
  }

  // 4. Where the buying power comes from.
  if (partnersImport.length) {
    const lead = partnersImport[0];
    out.push({
      headline: `Most imports arrive from ${lead.name}`,
      detail:
        `${lead.name} supplies ${lead.share_pct.toFixed(0)}% of what ${name} imports. If you ` +
        `are sourcing to sell here, that is your incumbent competition and the price you have ` +
        `to beat. If you are buying, those trade lanes already exist.`,
      angle: 'partner',
      strength: 'moderate',
      evidence: partnersImport
        .slice(0, 3)
        .map((p) => `${p.name}: ${p.share_pct.toFixed(1)}% (${usd(p.value_usd)})`),
    });
  }

  // 5. Trade balance and direction of travel.
  const bal = overview.balance_usd;
  const dir = bal >= 0 ? 'surplus' : 'deficit';
  out.push({
    headline: `${latest} trade ${dir} of ${usd(Math.abs(bal))}`,
    detail:
      bal >= 0
        ? `${name} sells more than it buys. Surplus economies usually have foreign currency ` +
          `available, which makes getting paid and repatriating profit simpler.`
        : `${name} buys more than it sells. Deficit economies can face foreign-exchange ` +
          `shortages, so check currency availability and payment terms before committing.`,
    angle: 'risk',
    strength: Math.abs(bal) > overview.total_trade_usd * 0.2 ? 'strong' : 'watch', // 20% of total trade = a severe imbalance
    evidence: [
      `Exports ${usd(overview.export_usd)} vs imports ${usd(overview.import_usd)} in ${latest}`,
      overview.export_yoy_pct != null
        ? `Exports moved ${overview.export_yoy_pct.toFixed(1)}% year on year`
        : 'Year-on-year comparison unavailable',
    ],
  });

  // 6. Services, where they matter.
  const svcExport = nearestYear(context.services_export_by_year, latest);
  const gdpPoint = nearestYear(context.gdp_by_year, latest);
  // 5% of GDP = the floor for calling services "a real part of the economy".
  if (svcExport && gdpPoint && svcExport.value / gdpPoint.value > 0.05) {
    const sx = svcExport.value;
    const gdp = gdpPoint.value;
    // World Bank series don't always share a latest year, so say so honestly
    // rather than blindly labelling both figures with the outer `latest`.
    const yearLabel =
      svcExport.year === gdpPoint.year
        ? `${svcExport.year}`
        : `services ${svcExport.year}, GDP ${gdpPoint.year}`;
    out.push({
      headline: `Services are a real part of this economy`,
      detail:
        `Commercial services exports are ${usd(sx)}, about ${((sx / gdp) * 100).toFixed(0)}% of ` +
        `GDP. That usually signals working payment rails, English or lingua-franca business ` +
        `capability, and buyers already used to contracting across borders.`,
      angle: 'entry',
      strength: 'moderate',
      evidence: [`Services exports ${usd(sx)} against GDP ${usd(gdp)} (${yearLabel})`],
    });
  }

  // 7. The forward-looking one, teased for free users.
  if (signals.length) {
    const s = signals[0];
    out.push({
      headline: `Early signal: ${s.product_name.toLowerCase()}`,
      detail:
        `Not a headline product yet, but growing ${s.cagr_3y!.toFixed(0)}% a year. ` +
        `Categories that hold that rate tend to reprice the market before they show up in ` +
        `the top ten, which is the window where entry is cheapest.`,
      angle: 'timing',
      strength: s.momentum > 0.6 ? 'strong' : 'watch',
      evidence: [s.rationale],
    });
  }

  return out;
}
