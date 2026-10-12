export interface SupplierShare {
  name: string;
  value_usd: number;
}

export type ConstraintLevel = 'high' | 'moderate' | 'low' | 'insufficient';

export interface SupplyConstraint {
  level: ConstraintLevel;
  reason: string;
  suppliers: number;
  top_supplier: string | null;
  top_share_pct: number | null;
  /** Herfindahl index on a 0 to 1 scale; 1 means a single supplier. */
  hhi: number | null;
  /** Supply swings between years, when at least four years are given. */
  volatility_pct: number | null;
  limitations: string[];
}

const MIN_TOTAL_USD = 100_000;
const HHI_HIGH = 0.25;
const HHI_MODERATE = 0.15;
const TOP_HIGH = 50;
const VOLATILE_PCT = 40;
const MIN_YEARS = 4;

const LIMITATIONS = [
  'Concentration is measured on who this country buys from (or sells to), not on world production, so it shows exposure to a few counterparties rather than a global shortage.',
  'A concentrated market can be a sign of a niche product with few makers, or of a single trade route, and the data cannot tell those apart.',
];

const cv = (xs: number[]) => {
  const mean = xs.reduce((s, v) => s + v, 0) / xs.length;
  if (!(mean > 0)) return null;
  const sd = Math.sqrt(xs.reduce((s, v) => s + (v - mean) ** 2, 0) / xs.length);
  return (sd / mean) * 100;
};

/**
 * How exposed a flow is to a few counterparties, from the shares of its partners
 * and, when given, the year-by-year totals. Thresholds are stated in the reason
 * so a reader can disagree with them.
 */
export function supplyConstraint(partners: SupplierShare[], yearlyTotals: number[] = []): SupplyConstraint {
  const live = partners.filter((p) => p.value_usd > 0).sort((a, b) => b.value_usd - a.value_usd);
  const total = live.reduce((s, p) => s + p.value_usd, 0);
  const empty = { suppliers: live.length, top_supplier: null, top_share_pct: null, hhi: null, volatility_pct: null, limitations: LIMITATIONS };
  if (total < MIN_TOTAL_USD || live.length === 0) {
    return { ...empty, level: 'insufficient', reason: 'Too little trade with named partners to measure concentration.' };
  }
  const shares = live.map((p) => p.value_usd / total);
  const hhi = shares.reduce((s, x) => s + x * x, 0);
  const topShare = shares[0] * 100;
  const years = yearlyTotals.filter((v) => v > 0);
  const vol = years.length >= MIN_YEARS ? cv(years) : null;
  const base = {
    suppliers: live.length, top_supplier: live[0].name, top_share_pct: Math.round(topShare * 10) / 10,
    hhi: Math.round(hhi * 1000) / 1000, volatility_pct: vol == null ? null : Math.round(vol), limitations: LIMITATIONS,
  };
  const volNote = vol != null && vol >= VOLATILE_PCT ? ` Yearly volumes also swing by about ${Math.round(vol)}%.` : '';

  if (hhi >= HHI_HIGH || topShare >= TOP_HIGH) {
    return { ...base, level: 'high', reason: `${live[0].name} supplies ${base.top_share_pct}% and the concentration index is ${base.hhi} (high is ${HHI_HIGH} or more, or one partner above ${TOP_HIGH}%).${volNote}` };
  }
  if (hhi >= HHI_MODERATE || (vol != null && vol >= VOLATILE_PCT)) {
    return { ...base, level: 'moderate', reason: hhi >= HHI_MODERATE
      ? `The concentration index is ${base.hhi} (moderate starts at ${HHI_MODERATE}); the largest partner, ${live[0].name}, has ${base.top_share_pct}%.${volNote}`
      : `Spread across ${live.length} partners (index ${base.hhi}), but yearly volumes swing by about ${Math.round(vol as number)}%.` };
  }
  return { ...base, level: 'low', reason: `Spread across ${live.length} partners; the largest, ${live[0].name}, has ${base.top_share_pct}% and the index is ${base.hhi}.` };
}
