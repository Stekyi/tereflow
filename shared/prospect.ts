export interface SupplierShare {
  name: string;
  value_usd: number;
}

export type SaturationLevel = 'dominated' | 'few-main' | 'competitive' | 'insufficient';

export interface Saturation {
  level: SaturationLevel;
  label: string;
  reason: string;
  suppliers: number;
  top_supplier: string | null;
  top_share_pct: number | null;
  top3_share_pct: number | null;
  /** Herfindahl index on a 0 to 1 scale; 1 means a single supplier. */
  hhi: number | null;
  limitations: string[];
}

const MIN_TOTAL_USD = 100_000;
const DOMINATED_TOP = 50;
const COMPETITIVE_SUPPLIERS = 10;
const COMPETITIVE_HHI = 0.15;

const SAT_LIMITS = [
  'Saturation is measured on what one buyer country already imports, by who supplies it. It is not world supply and says nothing about demand.',
  'A dominated market can be hard to enter, or can be one with a single dependable incumbent and room for a second source. The data cannot tell which.',
];

/**
 * How crowded a buyer's supply is, from the shares of its current suppliers. The three bands and their
 * cut-offs are stated in the reason so a reader can disagree with them.
 */
export function saturation(suppliers: SupplierShare[]): Saturation {
  const live = suppliers.filter((s) => s.value_usd > 0).sort((a, b) => b.value_usd - a.value_usd);
  const total = live.reduce((s, x) => s + x.value_usd, 0);
  const none = { suppliers: live.length, top_supplier: null, top_share_pct: null, top3_share_pct: null, hhi: null, limitations: SAT_LIMITS };
  if (total < MIN_TOTAL_USD || !live.length) {
    return { ...none, level: 'insufficient', label: 'Not enough imports to judge', reason: 'Too little trade with named suppliers to measure how crowded this market is.' };
  }
  const shares = live.map((s) => s.value_usd / total);
  const hhi = shares.reduce((s, x) => s + x * x, 0);
  const top = shares[0] * 100;
  const top3 = shares.slice(0, 3).reduce((s, x) => s + x, 0) * 100;
  const base = {
    suppliers: live.length, top_supplier: live[0].name, top_share_pct: Math.round(top * 10) / 10,
    top3_share_pct: Math.round(top3 * 10) / 10, hhi: Math.round(hhi * 1000) / 1000, limitations: SAT_LIMITS,
  };
  if (top >= DOMINATED_TOP) {
    return { ...base, level: 'dominated', label: 'Dominated by one supplier', reason: `${live[0].name} supplies ${base.top_share_pct}% and the concentration index is ${base.hhi} (dominated is a top share of ${DOMINATED_TOP}% or more).` };
  }
  if (live.length >= COMPETITIVE_SUPPLIERS && hhi < COMPETITIVE_HHI) {
    return { ...base, level: 'competitive', label: 'Many competing suppliers', reason: `${live.length} suppliers, the largest with ${base.top_share_pct}% and an index of ${base.hhi} (competitive is ${COMPETITIVE_SUPPLIERS} or more suppliers and an index under ${COMPETITIVE_HHI}). Expect price pressure.` };
  }
  return { ...base, level: 'few-main', label: 'A few main suppliers', reason: `${live.length} suppliers; the top three hold ${base.top3_share_pct}% and the index is ${base.hhi}.` };
}

export interface FxPoint {
  year: number;
  /** Local currency units per US dollar, annual average. */
  rate: number;
}

export type FxLevel = 'low' | 'moderate' | 'high' | 'insufficient';

export interface FxRisk {
  level: FxLevel;
  reason: string;
  years: number[];
  /** Standard deviation of the yearly percentage change in the rate. */
  volatility_pct: number | null;
  /** Largest single-year fall in the local currency against the dollar. */
  worst_year: { year: number; depreciation_pct: number } | null;
  /** Change in the local currency's dollar value over the whole span; negative means it lost value. */
  span_change_pct: number | null;
  limitations: string[];
}

const FX_LOW = 8;
const FX_HIGH = 20;
const FX_MIN_CHANGES = 4;

const FX_LIMITS = [
  'These are official annual average rates from the World Bank. A currency with a large gap between the official and street rate can be riskier than these figures show.',
  'This describes what the currency did, not what it will do.',
];

/**
 * Currency risk against the dollar from annual rates: how much the yearly change swings, and the worst
 * year. Needs at least four year-on-year changes; fewer gives no verdict.
 */
export function fxRisk(points: FxPoint[]): FxRisk {
  const pts = points.filter((p) => Number.isFinite(p.rate) && p.rate > 0).sort((a, b) => a.year - b.year);
  const changes: { year: number; pct: number }[] = [];
  for (let i = 1; i < pts.length; i++) {
    if (pts[i].year - pts[i - 1].year !== 1) continue;
    changes.push({ year: pts[i].year, pct: ((pts[i].rate - pts[i - 1].rate) / pts[i - 1].rate) * 100 });
  }
  const years = pts.map((p) => p.year);
  if (changes.length < FX_MIN_CHANGES) {
    return { level: 'insufficient', reason: `Only ${changes.length} year-on-year change(s) are available; at least ${FX_MIN_CHANGES} are needed.`, years, volatility_pct: null, worst_year: null, span_change_pct: null, limitations: FX_LIMITS };
  }
  const mean = changes.reduce((s, c) => s + c.pct, 0) / changes.length;
  const sd = Math.sqrt(changes.reduce((s, c) => s + (c.pct - mean) ** 2, 0) / changes.length);
  if (changes.every((c) => c.pct === 0)) {
    return { level: 'low', reason: 'The rate did not change over the years shown: the local currency is the US dollar, or is held fixed against it.', years, volatility_pct: 0, worst_year: null, span_change_pct: 0, limitations: FX_LIMITS };
  }
  const worst = changes.reduce((w, c) => (c.pct > w.pct ? c : w), changes[0]);
  // The rate is local units per dollar, so a rising rate is the local currency losing value.
  const dep = (r0: number, r1: number) => (1 / r1 / (1 / r0) - 1) * 100;
  const first = pts[0];
  const last = pts[pts.length - 1];
  const span = dep(first.rate, last.rate);
  const level: FxLevel = sd >= FX_HIGH ? 'high' : sd >= FX_LOW ? 'moderate' : 'low';
  const worstDep = worst.pct > 0 ? worst.pct : 0;
  return {
    level,
    reason: `Yearly moves against the dollar swing by ${sd.toFixed(1)} points (low is under ${FX_LOW}, high is ${FX_HIGH} or more). The worst year was ${worst.year}, with the local currency losing ${(worstDep / (1 + worstDep / 100)).toFixed(0)}% of its dollar value.`,
    years,
    volatility_pct: Math.round(sd * 10) / 10,
    worst_year: { year: worst.year, depreciation_pct: Math.round((worstDep / (1 + worstDep / 100)) * 10) / 10 },
    span_change_pct: Math.round(span * 10) / 10,
    limitations: FX_LIMITS,
  };
}
