export interface MonthlyRow {
  year: number;
  month: number;
  value_usd: number;
}

export type SeasonVerdict = 'seasonal' | 'mildly-seasonal' | 'not-seasonal' | 'insufficient';

export interface SeasonalitySignal {
  verdict: SeasonVerdict;
  reason: string;
  /** Complete years used, oldest first. */
  years: number[];
  /** Twelve values, January first: the month's average share of a year times twelve, so 1.0 is an average month. */
  index: number[] | null;
  peak_month: number | null;
  trough_month: number | null;
  peak_index: number | null;
  /** Share of the years in which the peak month ran at least 1.2 times an average month. */
  consistency_pct: number | null;
  limitations: string[];
}

const MIN_YEARS = 3;
const MIN_AVG_ANNUAL_USD = 250_000;
const SEASONAL_PEAK = 1.4;
const MILD_PEAK = 1.2;
const CONSISTENT_PCT = 66;

const LIMITATIONS = [
  'Each month is its share of that year, averaged over the years shown, so a country growing fast inside a year can look more seasonal than it is.',
  'Customs months follow when goods were recorded, not when they were made or sold, and one large shipment can move a month.',
];

const NONE = { index: null, peak_month: null, trough_month: null, peak_index: null, consistency_pct: null };

/**
 * Seasonality for one product from monthly values. Only years with all twelve
 * months present are used. 'seasonal' needs a clear peak that recurs; anything
 * weaker is reported as milder or absent, and too little data says so.
 */
export function seasonality(rows: MonthlyRow[]): SeasonalitySignal {
  const byYear = new Map<number, number[]>();
  for (const r of rows) {
    if (!(r.month >= 1 && r.month <= 12) || !(r.value_usd > 0)) continue;
    const arr = byYear.get(r.year) ?? new Array(12).fill(0);
    arr[r.month - 1] += r.value_usd;
    byYear.set(r.year, arr);
  }
  const complete = [...byYear.entries()].filter(([, a]) => a.every((v) => v > 0)).sort((a, b) => a[0] - b[0]);
  const years = complete.map(([y]) => y);
  const base = { years, limitations: LIMITATIONS };

  if (complete.length < MIN_YEARS) {
    return { ...base, ...NONE, verdict: 'insufficient',
      reason: `Only ${complete.length} year${complete.length === 1 ? ' has' : 's have'} a value in all twelve months; ${MIN_YEARS} are needed.` };
  }
  const totals = complete.map(([, a]) => a.reduce((s, v) => s + v, 0));
  const avgAnnual = totals.reduce((s, v) => s + v, 0) / totals.length;
  if (avgAnnual < MIN_AVG_ANNUAL_USD) {
    return { ...base, ...NONE, verdict: 'insufficient',
      reason: `Average annual trade of about $${Math.round(avgAnnual).toLocaleString('en-US')} is too small to read a monthly pattern from.` };
  }

  const shares = complete.map(([, a], i) => a.map((v) => v / totals[i]));
  const index = Array.from({ length: 12 }, (_, m) => (shares.reduce((s, y) => s + y[m], 0) / shares.length) * 12);
  const peak = index.indexOf(Math.max(...index));
  const trough = index.indexOf(Math.min(...index));
  const inTopThree = shares.filter((y) => y[peak] * 12 >= MILD_PEAK).length;
  const consistency = Math.round((inTopThree / shares.length) * 100);
  const peakIndex = Math.round(index[peak] * 100) / 100;
  const out = {
    ...base, index: index.map((v) => Math.round(v * 100) / 100), peak_month: peak + 1, trough_month: trough + 1,
    peak_index: peakIndex, consistency_pct: consistency,
  };

  if (index[peak] >= SEASONAL_PEAK && consistency >= CONSISTENT_PCT) {
    return { ...out, verdict: 'seasonal', reason: `Month ${peak + 1} runs at ${peakIndex} times an average month, and at least 1.2 times in ${consistency}% of the years.` };
  }
  if (index[peak] >= MILD_PEAK && consistency >= CONSISTENT_PCT) {
    return { ...out, verdict: 'mildly-seasonal', reason: `A modest peak in month ${peak + 1} (${peakIndex} times an average month) that recurs in ${consistency}% of the years.` };
  }
  return { ...out, verdict: 'not-seasonal',
    reason: index[peak] < MILD_PEAK ? `No month runs more than ${MILD_PEAK} times an average month.` : `The highest month (${peak + 1}) does not recur reliably: it is clearly above average in only ${consistency}% of the years.` };
}
