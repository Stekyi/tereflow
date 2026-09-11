/**
 * Deterministic analytics over trade observations.
 *
 * Country-agnostic on purpose: nothing here knows about Ghana, StatBank or HS2.
 * Give it observations and it returns metrics, so adding another statistical
 * office later means a new provider rather than a second copy of this maths.
 *
 * Three rules run through all of it.
 *
 * Missing is not zero. A product with no weight reported has no unit value, not
 * a unit value of zero. A series too short for a five year CAGR has no five year
 * CAGR, not a CAGR of nothing. Every one of those absences is returned as null
 * and named in `limitations`, because a zero in a ranking is a claim and a null
 * is an admission.
 *
 * Nothing is judged here. These are the numbers a second person with the same
 * rows would get. Whether a number is good is the scorer's problem.
 *
 * Nothing is fetched here. No clock, no network, no randomness, so the same
 * observations always produce the same metrics.
 */
import type { ClassificationLevel, TradeFlow, TradeObservation } from '../providers/types';

export type Trend = 'growing' | 'stable' | 'declining' | 'volatile' | 'insufficient_data';

export interface PartnerShare {
  partner: string;
  iso3: string | null;
  value_usd: number;
  share_pct: number;
}

export interface ProductMetrics {
  country_code: string;
  trade_flow: TradeFlow;
  classification_system: 'HS';
  classification_level: ClassificationLevel;
  product_code: string;
  product_description: string | null;

  latest_year: number;
  earliest_year: number;
  years_available: number;

  import_value_usd: number;
  net_weight_kg: number | null;
  /** Dollars per kilogram. Null when weight is missing or zero. */
  unit_value_usd_per_kg: number | null;

  yoy_value_pct: number | null;
  yoy_volume_pct: number | null;
  cagr_3y_pct: number | null;
  cagr_5y_pct: number | null;

  trend: Trend;
  /** Spread of the year-on-year changes. */
  volatility_pct: number | null;

  top_partner: string | null;
  top_partner_share_pct: number | null;
  /** 0 to 1. One supplier is 1. Null when too few partners to mean anything. */
  supplier_hhi: number | null;
  partner_count: number;
  partner_shares: PartnerShare[];

  /** What could not be computed, in words a reader can act on. */
  limitations: string[];
  /** True when the latest year covers fewer than twelve months. */
  latest_year_partial: boolean;
  months_in_latest_year: number | null;
}

interface YearTotal {
  year: number;
  value: number;
  weight: number | null;
  months: number;
  partners: Map<string, { value: number; iso3: string | null }>;
}

// Below this a year-on-year percentage is arithmetic noise: a product going
// from 3,000 to 30,000 dollars is up 900% and is still nothing.
const MEANINGFUL_BASE_USD = 100_000;

// A series whose year-on-year swings vary by more than this is called volatile
// rather than growing or declining, because the direction is not the story.
const VOLATILE_CV_PCT = 60;

// Inside this band a series is flat rather than moving.
const STABLE_BAND_PCT = 5;

export function computeMetrics(
  observations: TradeObservation[],
  options: { minYearsForTrend?: number } = {},
): ProductMetrics[] {
  const minYears = options.minYearsForTrend ?? 3;

  const groups = new Map<string, TradeObservation[]>();
  for (const o of observations) {
    // Annual rows only. Months are the source's detail, not the unit of
    // analysis, and mixing them would double every total.
    if (o.month !== 0) continue;
    const key = `${o.country_code}|${o.trade_flow}|${o.classification_level}|${o.product_code}`;
    const list = groups.get(key) ?? [];
    list.push(o);
    groups.set(key, list);
  }

  const out: ProductMetrics[] = [];
  for (const [, rows] of groups) {
    const m = metricsForOne(rows, minYears);
    if (m) out.push(m);
  }
  return out.sort((a, b) => b.import_value_usd - a.import_value_usd);
}

function metricsForOne(rows: TradeObservation[], minYears: number): ProductMetrics | null {
  if (!rows.length) return null;
  const first = rows[0];
  const limitations: string[] = [];

  const byYear = new Map<number, YearTotal>();
  for (const r of rows) {
    if (r.import_value_usd == null) continue;
    const y = byYear.get(r.year) ?? {
      year: r.year,
      value: 0,
      weight: null,
      months: 0,
      partners: new Map<string, { value: number; iso3: string | null }>(),
    };
    y.value += r.import_value_usd;
    if (r.net_weight_kg != null && r.net_weight_kg > 0) {
      y.weight = (y.weight ?? 0) + r.net_weight_kg;
    }
    y.months = Math.max(y.months, r.months_counted ?? 12);
    const p = y.partners.get(r.partner_country) ?? { value: 0, iso3: r.partner_iso3 };
    p.value += r.import_value_usd;
    y.partners.set(r.partner_country, p);
    byYear.set(r.year, y);
  }

  const years = [...byYear.values()].sort((a, b) => a.year - b.year);
  if (!years.length) return null;

  const latest = years[years.length - 1];
  const earliest = years[0];

  let unitValue: number | null = null;
  if (latest.weight != null && latest.weight > 0) {
    unitValue = latest.value / latest.weight;
  } else {
    limitations.push('Import volume is not reported, so no unit value can be calculated.');
  }

  const prior = years.length >= 2 ? years[years.length - 2] : null;
  const yoyValue = prior ? pctChange(prior.value, latest.value) : null;
  if (!prior) {
    limitations.push('Only one year of data, so year-on-year growth cannot be calculated.');
  }
  const yoyVolume =
    prior && prior.weight != null && prior.weight > 0 && latest.weight != null
      ? pctChange(prior.weight, latest.weight)
      : null;

  const cagr3 = cagrOver(years, 3);
  const cagr5 = cagrOver(years, 5);
  if (cagr3 == null) {
    limitations.push(spanLimitation(years, 3));
  }
  if (cagr5 == null) {
    limitations.push(spanLimitation(years, 5));
  }

  const changes: number[] = [];
  for (let i = 1; i < years.length; i++) {
    const c = pctChange(years[i - 1].value, years[i].value);
    if (c != null) changes.push(c);
  }
  const volatility = changes.length >= 2 ? coefficientOfVariation(changes) : null;

  const trend = classifyTrend({ years, changes, volatility, minYears, latestValue: latest.value });
  if (trend === 'insufficient_data') {
    limitations.push(`At least ${minYears} years of meaningful trade are needed to describe a trend.`);
  }

  const partnerTotal = [...latest.partners.values()].reduce((s, p) => s + p.value, 0);
  const shares: PartnerShare[] = [...latest.partners.entries()]
    .map(([partner, p]) => ({
      partner,
      iso3: p.iso3,
      value_usd: p.value,
      share_pct: partnerTotal > 0 ? (p.value / partnerTotal) * 100 : 0,
    }))
    .sort((a, b) => b.value_usd - a.value_usd);

  const topPartner = shares.length ? shares[0] : null;
  // HHI over one supplier is 1 by definition. That says the query found one
  // partner, not that the market is concentrated, so it is withheld.
  const hhi = shares.length >= 2 ? herfindahl(shares.map((s) => s.share_pct / 100)) : null;
  if (shares.length < 2) {
    limitations.push('Fewer than two partner countries reported, so supplier concentration cannot be assessed.');
  }

  const latestPartial = latest.months > 0 && latest.months < 12;
  if (latestPartial) {
    limitations.push(
      `${latest.year} covers ${latest.months} month${latest.months === 1 ? '' : 's'} rather than a full year, ` +
        'so it is not comparable with earlier years.',
    );
  }

  if (first.classification_level === 'HS2') {
    limitations.push(
      'Source data is at HS2 chapter level. This is a sector signal rather than a specific product opportunity.',
    );
  }

  return {
    country_code: first.country_code,
    trade_flow: first.trade_flow,
    classification_system: 'HS',
    classification_level: first.classification_level,
    product_code: first.product_code,
    product_description: first.product_description,

    latest_year: latest.year,
    earliest_year: earliest.year,
    years_available: years.length,

    import_value_usd: latest.value,
    net_weight_kg: latest.weight,
    unit_value_usd_per_kg: unitValue,

    yoy_value_pct: yoyValue,
    yoy_volume_pct: yoyVolume,
    cagr_3y_pct: cagr3,
    cagr_5y_pct: cagr5,

    trend,
    volatility_pct: volatility,

    top_partner: topPartner?.partner ?? null,
    top_partner_share_pct: topPartner?.share_pct ?? null,
    supplier_hhi: hhi,
    partner_count: shares.length,
    partner_shares: shares,

    limitations,
    latest_year_partial: latestPartial,
    months_in_latest_year: latest.months || null,
  };
}

/**
 * Why a growth rate over this span could not be computed.
 *
 * Says the span rather than the year count. "Insufficient history for a five
 * year growth rate: 5 years available" is the kind of sentence that makes a
 * reader distrust everything around it, because it reads as a contradiction. It
 * is not: five calendar years is four intervals, and a five year rate needs a
 * reading from five years before the latest one.
 */
function spanLimitation(years: Array<{ year: number }>, span: number): string {
  const word = span === 3 ? 'three' : span === 5 ? 'five' : String(span);
  if (years.length < 2) {
    return `A ${word} year growth rate needs at least two years of data.`;
  }
  const latest = years[years.length - 1].year;
  const earliest = years[0].year;
  const covered = latest - earliest;
  return (
    `No ${word} year growth rate: the data spans ${covered} year${covered === 1 ? '' : 's'} ` +
    `(${earliest} to ${latest}) and a ${word} year rate needs a reading from ${latest - span}.`
  );
}
export function pctChange(from: number, to: number): number | null {
  if (!Number.isFinite(from) || !Number.isFinite(to)) return null;
  // Growth from nothing is not a percentage. Returning a huge number here is
  // how a product that barely exists reaches the top of a ranking.
  if (from <= 0) return null;
  return ((to - from) / from) * 100;
}

/**
 * Compound annual growth over a span, using real endpoints.
 *
 * Returns null rather than reaching for a shorter window. A "five year CAGR"
 * computed over two years answers a different question than its label asks.
 */
export function cagrOver(
  years: Array<{ year: number; value: number }>,
  span: number,
): number | null {
  if (years.length < 2) return null;
  const latest = years[years.length - 1];
  const start = years.find((y) => y.year === latest.year - span);
  if (!start) return null;
  if (start.value <= 0 || latest.value <= 0) return null;
  return (Math.pow(latest.value / start.value, 1 / span) - 1) * 100;
}

/** Spread of the year-on-year changes, relative to their average size. */
export function coefficientOfVariation(values: number[]): number | null {
  if (values.length < 2) return null;
  const mean = values.reduce((s, v) => s + v, 0) / values.length;
  const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / values.length;
  const sd = Math.sqrt(variance);
  // Around a mean of zero the ratio explodes and means nothing, so the spread
  // itself is the honest answer.
  if (Math.abs(mean) < 1) return sd;
  return Math.abs(sd / mean) * 100;
}

/** Herfindahl index over shares expressed as fractions. */
export function herfindahl(fractions: number[]): number {
  return fractions.reduce((s, f) => s + f * f, 0);
}

function classifyTrend(input: {
  years: Array<{ year: number; value: number }>;
  changes: number[];
  volatility: number | null;
  minYears: number;
  latestValue: number;
}): Trend {
  const { years, changes, volatility, minYears, latestValue } = input;
  if (years.length < minYears) return 'insufficient_data';
  if (!changes.length) return 'insufficient_data';

  // A market too small for its percentages to mean anything is not growing,
  // whatever the arithmetic says.
  if (latestValue < MEANINGFUL_BASE_USD) return 'insufficient_data';

  if (volatility != null && volatility > VOLATILE_CV_PCT) return 'volatile';

  // Fit a line through every year rather than comparing the first with the
  // last. Ghana's plastics imports fell for three years then recovered, ending
  // 6% below where they started, and endpoint-only comparison called that
  // "declining" while the three year rate said plus one percent. Two numbers on
  // the same card disagreeing is how a reader stops believing either.
  const slope = trendSlope(years);
  if (slope == null) return 'insufficient_data';

  const mean = years.reduce((s, y) => s + y.value, 0) / years.length;
  if (mean <= 0) return 'insufficient_data';
  // Slope is per year, so express it as a share of the average level to get a
  // rate comparable across products of wildly different sizes.
  const ratePct = (slope / mean) * 100;

  if (Math.abs(ratePct) <= STABLE_BAND_PCT) return 'stable';
  return ratePct > 0 ? 'growing' : 'declining';
}

/** Least squares slope of value against year, in dollars per year. */
export function trendSlope(points: Array<{ year: number; value: number }>): number | null {
  if (points.length < 2) return null;
  const n = points.length;
  const meanX = points.reduce((s, p) => s + p.year, 0) / n;
  const meanY = points.reduce((s, p) => s + p.value, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of points) {
    num += (p.year - meanX) * (p.value - meanY);
    den += (p.year - meanX) ** 2;
  }
  if (den === 0) return null;
  return num / den;
}
