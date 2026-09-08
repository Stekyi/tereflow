/**
 * Turning uploaded indicators and sectors into an investment read of a country.
 *
 * The trade side already has an engine in analyse.ts and is not rebuilt here.
 * What is new is everything that is not trade: the demographic, income, macro,
 * labour, infrastructure and risk indicators, and the sector breakdown.
 *
 * The governing rule, stated in the spec and enforced throughout this file, is
 * that a recommendation is not advice. Every number carries what it was
 * computed from and what was missing, a missing input is never read as a zero,
 * and a score built from three of ten inputs says so and lowers its own
 * confidence. A reader must be able to see the evidence under any figure, or
 * the figure does not appear.
 */

import type { AnalysisBundle } from './analyse';
import type { Settings } from '../lib/settings';

/** One indicator observation, already selected as a national figure for a year. */
export interface IndicatorRow {
  indicator_code: string;
  indicator_name: string | null;
  category: string | null;
  year: number;
  value: number;
  unit: string | null;
  currency: string | null;
  price_basis: string | null;
  sex: string | null;
  age_group: string | null;
  region: string | null;
  urban_rural: string | null;
  income_group: string | null;
  confidence: number | null;
}

/** One sector observation for a year. */
export interface SectorRow {
  sector_code: string;
  sector_name: string | null;
  subsector_code: string | null;
  year: number;
  value: number | null;
  unit: string | null;
  currency: string | null;
  share_of_gdp: number | null;
  growth_rate: number | null;
  employment: number | null;
  employment_share: number | null;
  exports_value: number | null;
  imports_value: number | null;
}

/** How much of what a metric needs it actually had. Never invented. */
export type Confidence = 'high' | 'medium' | 'low' | 'none';

/**
 * The shape every derived figure takes. `value` is null, not zero, when it
 * could not be computed. `basedOn` names the inputs used and `missing` names
 * the inputs a full answer would have used but did not have, so the gap is on
 * the record rather than hidden inside the number.
 */
export interface Metric {
  value: number | null;
  unit: string | null;
  year: number | null;
  method: string;
  basedOn: string[];
  missing: string[];
  confidence: Confidence;
  notes: string[];
}

export interface SectorOpportunity {
  sector_code: string;
  sector_name: string | null;
  year: number;
  score: number | null;
  band: 'strong' | 'moderate' | 'limited' | 'unscored';
  reasons: string[];
  basedOn: string[];
  missing: string[];
}

export interface ManualAnalysis {
  entity: string;
  generated_at: string;
  consumer_market: Metric;
  income_opportunity: Metric;
  labour_availability: Metric;
  infrastructure_readiness: Metric;
  macro_stability: Metric;
  investment_risk: Metric;
  data_confidence: Metric;
  sector_opportunities: SectorOpportunity[];
  trade_summary: {
    present: boolean;
    top_export: string | null;
    top_import: string | null;
    latest_year: number | null;
  };
  missing_data_warnings: string[];
  freshness: {
    latest_indicator_year: number | null;
    latest_sector_year: number | null;
    reference_year: number;
    indicator_age_years: number | null;
    sector_age_years: number | null;
    note: string;
  };
}

/** Latest national observation for a code. National means no breakdown set. */
function latestNational(rows: IndicatorRow[], code: string): IndicatorRow | null {
  const national = rows.filter(
    (r) =>
      r.indicator_code === code &&
      !r.sex &&
      !r.age_group &&
      !r.region &&
      !r.urban_rural &&
      !r.income_group,
  );
  const pool = national.length ? national : rows.filter((r) => r.indicator_code === code);
  if (!pool.length) return null;
  return pool.reduce((a, b) => (b.year > a.year ? b : a));
}

function valueOf(rows: IndicatorRow[], code: string): number | null {
  const r = latestNational(rows, code);
  return r ? r.value : null;
}

function coverageConfidence(present: number, total: number): Confidence {
  if (total === 0 || present === 0) return 'none';
  const frac = present / total;
  if (frac >= 0.75) return 'high';
  if (frac >= 0.5) return 'medium';
  return 'low';
}

/**
 * Map a raw indicator onto 0..100 for a composite, given the plausible range it
 * lives in and whether higher is better. Values outside the range are clamped,
 * not discarded, because an out-of-range figure is still information. A null in
 * never becomes a number: the caller has already decided the input is present.
 *
 * The ranges are the ones the catalogue documents (for example the World Bank
 * governance indicators run about -2.5 to 2.5), which is why they are stated
 * per code rather than guessed here.
 */
function scale(value: number, lo: number, hi: number, higherBetter: boolean): number {
  const clamped = Math.max(lo, Math.min(hi, value));
  const frac = (clamped - lo) / (hi - lo);
  const pct = frac * 100;
  return higherBetter ? pct : 100 - pct;
}

interface Component {
  code: string;
  lo: number;
  hi: number;
  higherBetter: boolean;
}

/**
 * Average the scaled scores of whichever components are present. The score is
 * built only from inputs that exist; the ones that do not are returned so the
 * metric can name them and drop its confidence. A missing component is left out
 * of both the sum and the count, never entered as a zero, because zero is a
 * real electricity-access figure and absence is not.
 */
function composite(
  rows: IndicatorRow[],
  components: Component[],
): { score: number | null; used: string[]; missing: string[]; year: number | null } {
  let sum = 0;
  const used: string[] = [];
  const missing: string[] = [];
  let latestYear: number | null = null;

  for (const comp of components) {
    const row = latestNational(rows, comp.code);
    if (!row) {
      missing.push(comp.code);
      continue;
    }
    sum += scale(row.value, comp.lo, comp.hi, comp.higherBetter);
    used.push(comp.code);
    if (latestYear === null || row.year > latestYear) latestYear = row.year;
  }

  const score = used.length ? Math.round((sum / used.length) * 10) / 10 : null;
  return { score, used, missing, year: latestYear };
}

function consumerMarket(rows: IndicatorRow[]): Metric {
  const notes: string[] = [];
  const spending = latestNational(rows, 'CONSUMER_SPENDING');
  const hhConsumption = latestNational(rows, 'HH_CONSUMPTION');
  const gdp = latestNational(rows, 'GDP');
  const pop = valueOf(rows, 'POP_TOTAL');

  let source: IndicatorRow | null = null;
  let method = '';
  if (spending) {
    source = spending;
    method = 'Reported consumer spending.';
  } else if (hhConsumption) {
    source = hhConsumption;
    method = 'Household consumption, used because consumer spending was not supplied.';
  } else if (gdp) {
    source = gdp;
    method =
      'GDP, used only because no consumer or household consumption figure was supplied. This overstates the addressable consumer market and should be read as an upper bound.';
    notes.push('Headline is GDP, not consumer spending. Treat as an upper bound.');
  }

  const missing: string[] = [];
  if (!spending) missing.push('CONSUMER_SPENDING');
  if (!hhConsumption) missing.push('HH_CONSUMPTION');
  if (!pop) missing.push('POP_TOTAL');

  if (!source) {
    return {
      value: null,
      unit: null,
      year: null,
      method: 'No consumer spending, household consumption or GDP figure was supplied.',
      basedOn: [],
      missing,
      confidence: 'none',
      notes,
    };
  }

  const basedOn = [source.indicator_code];
  if (pop != null) {
    basedOn.push('POP_TOTAL');
    notes.push(
      `Per head of population: ${Math.round(source.value / pop).toLocaleString('en')} ${source.currency ?? source.unit ?? ''}`.trim(),
    );
  }

  // Currency is whatever the file stated. It is never assumed to be dollars.
  const unit = source.currency ?? source.unit ?? null;
  const confidence: Confidence = spending ? 'high' : hhConsumption ? 'medium' : 'low';

  return {
    value: source.value,
    unit,
    year: source.year,
    method,
    basedOn,
    missing,
    confidence,
    notes,
  };
}

function incomeOpportunity(rows: IndicatorRow[]): Metric {
  const gdpPc = latestNational(rows, 'GDP_PER_CAPITA');
  const median = latestNational(rows, 'HH_INCOME_MEDIAN');
  const poverty = valueOf(rows, 'POVERTY_RATE');
  const middle = valueOf(rows, 'MIDDLE_CLASS');

  const source = median ?? gdpPc;
  const notes: string[] = [];
  const missing: string[] = [];
  if (!median) missing.push('HH_INCOME_MEDIAN');
  if (!gdpPc) missing.push('GDP_PER_CAPITA');
  if (poverty == null) missing.push('POVERTY_RATE');
  if (middle == null) missing.push('MIDDLE_CLASS');

  if (!source) {
    return {
      value: null,
      unit: null,
      year: null,
      method: 'No median household income or GDP per capita was supplied.',
      basedOn: [],
      missing,
      confidence: 'none',
      notes,
    };
  }

  const basedOn = [source.indicator_code];
  if (poverty != null) {
    basedOn.push('POVERTY_RATE');
    notes.push(`Poverty rate ${poverty}% qualifies the share of that income that is discretionary.`);
  }
  if (middle != null) {
    basedOn.push('MIDDLE_CLASS');
    notes.push(`Middle-class population reported at ${Math.round(middle).toLocaleString('en')}.`);
  }
  if (median) {
    notes.push('Median income used in preference to GDP per capita: it is closer to a typical household.');
  } else {
    notes.push('GDP per capita used because no median household income was supplied. It sits above the typical household where income is unevenly spread.');
  }

  const confidence: Confidence = median
    ? poverty != null
      ? 'high'
      : 'medium'
    : 'low';

  return {
    value: source.value,
    unit: source.currency ?? source.unit ?? null,
    year: source.year,
    method: 'Income level, with poverty and middle-class figures where present to qualify how much of it is spendable.',
    basedOn,
    missing,
    confidence,
    notes,
  };
}

function labourAvailability(rows: IndicatorRow[]): Metric {
  // Working-age population, participation and skill are the inputs a labour read
  // wants. Score is built from whichever are present.
  const parts: Component[] = [
    { code: 'LABOUR_FORCE_PART', lo: 40, hi: 90, higherBetter: true },
    { code: 'SKILLED_LABOUR', lo: 0, hi: 100, higherBetter: true },
    { code: 'LABOUR_PRODUCTIVITY', lo: 0, hi: 100000, higherBetter: true },
    { code: 'LITERACY', lo: 0, hi: 100, higherBetter: true },
  ];
  const c = composite(rows, parts);
  const pop = valueOf(rows, 'POP_WORKING_AGE');
  const unemp = valueOf(rows, 'UNEMPLOYMENT');
  const wage = latestNational(rows, 'WAGE_AVERAGE');

  const notes: string[] = [];
  const basedOn = [...c.used];
  const missing = [...c.missing];
  if (pop != null) {
    basedOn.push('POP_WORKING_AGE');
    notes.push(`Working-age population ${Math.round(pop).toLocaleString('en')}.`);
  } else {
    missing.push('POP_WORKING_AGE');
  }
  if (unemp != null) {
    basedOn.push('UNEMPLOYMENT');
    notes.push(`Unemployment ${unemp}%: a higher figure means more labour is idle and available.`);
  } else {
    missing.push('UNEMPLOYMENT');
  }
  if (wage) {
    basedOn.push('WAGE_AVERAGE');
    notes.push(`Average wage ${Math.round(wage.value).toLocaleString('en')} ${wage.currency ?? wage.unit ?? ''}.`.trim());
  } else {
    missing.push('WAGE_AVERAGE');
  }

  const present = basedOn.length;
  const total = parts.length + 3;
  return {
    value: c.score,
    unit: c.score == null ? null : 'index_0_100',
    year: c.year,
    method: `Availability index from the labour indicators supplied (${c.used.length} of ${parts.length} scored), with working-age population, unemployment and wages noted alongside.`,
    basedOn,
    missing,
    confidence: coverageConfidence(present, total),
    notes,
  };
}

function infrastructureReadiness(rows: IndicatorRow[]): Metric {
  const parts: Component[] = [
    { code: 'ELECTRICITY_ACCESS', lo: 0, hi: 100, higherBetter: true },
    { code: 'ELECTRICITY_RELIABILITY', lo: 0, hi: 100, higherBetter: true },
    { code: 'BROADBAND', lo: 0, hi: 100, higherBetter: true },
    { code: 'MOBILE_PENETRATION', lo: 0, hi: 150, higherBetter: true },
    { code: 'INTERNET_USERS', lo: 0, hi: 100, higherBetter: true },
    { code: 'ROAD_DENSITY', lo: 0, hi: 150, higherBetter: true },
    { code: 'LOGISTICS_PERFORMANCE', lo: 1, hi: 5, higherBetter: true },
    { code: 'AIRPORT_CONNECTIVITY', lo: 0, hi: 100, higherBetter: true },
    { code: 'COLD_CHAIN', lo: 0, hi: 100, higherBetter: true },
    { code: 'PORT_CAPACITY', lo: 0, hi: 5000000, higherBetter: true },
  ];
  const c = composite(rows, parts);
  const notes: string[] = [];
  if (c.used.length) {
    notes.push(`Scored from ${c.used.length} of ${parts.length} infrastructure indicators.`);
  }
  if (c.missing.length) {
    notes.push(`Not scored, because not supplied: ${c.missing.join(', ')}.`);
  }
  return {
    value: c.score,
    unit: c.score == null ? null : 'index_0_100',
    year: c.year,
    method: 'Mean of the infrastructure indicators supplied, each scaled to its documented range. Missing indicators are excluded, never scored as zero.',
    basedOn: c.used,
    missing: c.missing,
    confidence: coverageConfidence(c.used.length, parts.length),
    notes,
  };
}

function macroStability(rows: IndicatorRow[]): Metric {
  const parts: Component[] = [
    { code: 'INFLATION', lo: 0, hi: 30, higherBetter: false },
    { code: 'GDP_GROWTH', lo: -5, hi: 8, higherBetter: true },
    { code: 'PUBLIC_DEBT', lo: 0, hi: 120, higherBetter: false },
    { code: 'FISCAL_DEFICIT', lo: -15, hi: 5, higherBetter: true },
    { code: 'CURRENT_ACCOUNT', lo: -15, hi: 10, higherBetter: true },
    { code: 'FX_VOLATILITY', lo: 0, hi: 40, higherBetter: false },
  ];
  const c = composite(rows, parts);
  const notes: string[] = [];
  if (c.missing.length) notes.push(`Not supplied: ${c.missing.join(', ')}.`);
  return {
    value: c.score,
    unit: c.score == null ? null : 'index_0_100',
    year: c.year,
    method: 'Mean of the macro indicators supplied, each scaled so a more stable reading scores higher.',
    basedOn: c.used,
    missing: c.missing,
    confidence: coverageConfidence(c.used.length, parts.length),
    notes,
  };
}

function investmentRisk(rows: IndicatorRow[]): Metric {
  // Higher score is a safer environment, so the risk components are oriented so
  // that better governance and lower risk raise the number.
  const parts: Component[] = [
    { code: 'POLITICAL_STABILITY', lo: -2.5, hi: 2.5, higherBetter: true },
    { code: 'RULE_OF_LAW', lo: -2.5, hi: 2.5, higherBetter: true },
    { code: 'REGULATORY_QUALITY', lo: -2.5, hi: 2.5, higherBetter: true },
    { code: 'CORRUPTION_RISK', lo: 0, hi: 100, higherBetter: false },
    { code: 'CONFLICT_RISK', lo: 0, hi: 100, higherBetter: false },
    { code: 'CLIMATE_EXPOSURE', lo: 0, hi: 100, higherBetter: false },
  ];
  const c = composite(rows, parts);
  const notes: string[] = ['Higher is safer. This is an environment reading, not a probability of loss.'];
  if (c.missing.length) notes.push(`Not supplied: ${c.missing.join(', ')}.`);
  return {
    value: c.score,
    unit: c.score == null ? null : 'index_0_100',
    year: c.year,
    method: 'Mean of the governance and risk indicators supplied, oriented so a safer environment scores higher.',
    basedOn: c.used,
    missing: c.missing,
    confidence: coverageConfidence(c.used.length, parts.length),
    notes,
  };
}

/**
 * The core set a full country read wants. Data confidence is how much of it
 * arrived, blended with the per-figure confidence the uploader recorded where
 * they recorded it. It is a statement about the evidence, not about the country.
 */
const CORE_CODES = [
  'POP_TOTAL',
  'GDP',
  'GDP_PER_CAPITA',
  'GDP_GROWTH',
  'INFLATION',
  'CONSUMER_SPENDING',
  'ELECTRICITY_ACCESS',
  'LOGISTICS_PERFORMANCE',
  'POLITICAL_STABILITY',
  'RULE_OF_LAW',
];

function dataConfidence(rows: IndicatorRow[], sectors: SectorRow[]): Metric {
  const present = CORE_CODES.filter((code) => latestNational(rows, code) !== null);
  const missing = CORE_CODES.filter((code) => latestNational(rows, code) === null);

  const stated = rows.map((r) => r.confidence).filter((v): v is number => v != null);
  const avgStated = stated.length ? stated.reduce((a, b) => a + b, 0) / stated.length : null;

  const coverage = present.length / CORE_CODES.length;
  // Coverage is the spine; a stated per-figure confidence can only pull it down,
  // never lift it, because a complete set of figures nobody vouches for is not
  // more trustworthy than the figures themselves claim.
  const blended = avgStated == null ? coverage : Math.min(coverage, coverage * 0.5 + avgStated * 0.5);
  const score = Math.round(blended * 1000) / 10;

  const notes: string[] = [
    `${present.length} of ${CORE_CODES.length} core indicators present.`,
    `${sectors.length} sector rows loaded.`,
  ];
  if (avgStated != null) {
    notes.push(`Mean stated confidence on figures that carried one: ${Math.round(avgStated * 100)}%.`);
  } else {
    notes.push('No per-figure confidence was recorded on any upload.');
  }

  return {
    value: score,
    unit: 'percent',
    year: null,
    method: 'Share of the core indicator set that was supplied, held down by the mean stated confidence where one was given.',
    basedOn: present,
    missing,
    confidence: coverageConfidence(present.length, CORE_CODES.length),
    notes,
  };
}

function sectorOpportunities(sectors: SectorRow[], settings: Settings): SectorOpportunity[] {
  // One row per sector, its latest year.
  const latest = new Map<string, SectorRow>();
  for (const s of sectors) {
    const prev = latest.get(s.sector_code);
    if (!prev || s.year > prev.year) latest.set(s.sector_code, s);
  }

  const out: SectorOpportunity[] = [];
  for (const s of latest.values()) {
    const reasons: string[] = [];
    const basedOn: string[] = [];
    const missing: string[] = [];
    const scores: number[] = [];

    if (s.growth_rate != null) {
      basedOn.push('growth_rate');
      // Growth from -5 to 15 percent onto 0..100. A contracting sector scores
      // low, not zero, because it is still a sector.
      scores.push(scale(s.growth_rate, -5, 15, true));
      reasons.push(`Growth ${s.growth_rate}% a year.`);
    } else {
      missing.push('growth_rate');
    }

    if (s.share_of_gdp != null) {
      basedOn.push('share_of_gdp');
      scores.push(scale(s.share_of_gdp, 0, 30, true));
      reasons.push(`${s.share_of_gdp}% of GDP.`);
    } else {
      missing.push('share_of_gdp');
    }

    if (s.employment_share != null) {
      basedOn.push('employment_share');
      scores.push(scale(s.employment_share, 0, 40, true));
      reasons.push(`Employs ${s.employment_share}% of workers.`);
    } else if (s.employment != null) {
      basedOn.push('employment');
      reasons.push(`Employs ${Math.round(s.employment).toLocaleString('en')}.`);
    } else {
      missing.push('employment_share');
    }

    const score = scores.length ? Math.round((scores.reduce((a, b) => a + b, 0) / scores.length) * 10) / 10 : null;
    let band: SectorOpportunity['band'] = 'unscored';
    if (score != null) {
      band = score >= settings.scoreBandStrong ? 'strong' : score >= settings.scoreBandModerate ? 'moderate' : 'limited';
    }
    if (missing.length) reasons.push(`Scored without: ${missing.join(', ')}.`);

    out.push({
      sector_code: s.sector_code,
      sector_name: s.sector_name,
      year: s.year,
      score,
      band,
      reasons,
      basedOn,
      missing,
    });
  }

  // Scored sectors first, best to worst; unscored fall to the bottom rather
  // than being dropped, because their absence of a score is itself a finding.
  out.sort((a, b) => {
    if (a.score == null && b.score == null) return 0;
    if (a.score == null) return 1;
    if (b.score == null) return -1;
    return b.score - a.score;
  });
  return out;
}

export function analyseCountryData(input: {
  entityName: string;
  indicators: IndicatorRow[];
  sectors: SectorRow[];
  tradeBundle: AnalysisBundle | null;
  settings: Settings;
}): ManualAnalysis {
  const { entityName, indicators, sectors, tradeBundle, settings } = input;

  const consumer_market = consumerMarket(indicators);
  const income_opportunity = incomeOpportunity(indicators);
  const labour_availability = labourAvailability(indicators);
  const infrastructure_readiness = infrastructureReadiness(indicators);
  const macro_stability = macroStability(indicators);
  const investment_risk = investmentRisk(indicators);
  const data_confidence = dataConfidence(indicators, sectors);
  const sector_opportunities = sectorOpportunities(sectors, settings);

  const warnings: string[] = [];
  if (!indicators.length) warnings.push('No indicator data has been loaded for this country.');
  if (!sectors.length) warnings.push('No sector breakdown has been loaded, so sector ranking is unavailable.');
  if (!tradeBundle) warnings.push('No trade data has been loaded, so trade opportunity is not reflected.');
  for (const m of [consumer_market, income_opportunity, macro_stability, investment_risk]) {
    if (m.value == null) warnings.push(`${m.method}`);
  }

  const indicatorYears = indicators.map((r) => r.year);
  const sectorYears = sectors.map((s) => s.year);
  const latestIndicatorYear = indicatorYears.length ? Math.max(...indicatorYears) : null;
  const latestSectorYear = sectorYears.length ? Math.max(...sectorYears) : null;
  // Reference year is the newest year seen in any uploaded figure, so freshness
  // is measured against the country's own most recent data, not a wall clock the
  // analysis has no honest access to.
  const referenceYear = Math.max(latestIndicatorYear ?? 0, latestSectorYear ?? 0, tradeBundle ? latestTradeYear(tradeBundle) ?? 0 : 0) || new Date().getUTCFullYear();

  return {
    entity: entityName,
    generated_at: new Date().toISOString(),
    consumer_market,
    income_opportunity,
    labour_availability,
    infrastructure_readiness,
    macro_stability,
    investment_risk,
    data_confidence,
    sector_opportunities,
    trade_summary: {
      present: !!tradeBundle,
      top_export: tradeBundle?.top_exports?.[0]?.name ?? null,
      top_import: tradeBundle?.top_imports?.[0]?.name ?? null,
      latest_year: tradeBundle ? latestTradeYear(tradeBundle) : null,
    },
    missing_data_warnings: warnings,
    freshness: {
      latest_indicator_year: latestIndicatorYear,
      latest_sector_year: latestSectorYear,
      reference_year: referenceYear,
      indicator_age_years: latestIndicatorYear == null ? null : referenceYear - latestIndicatorYear,
      sector_age_years: latestSectorYear == null ? null : referenceYear - latestSectorYear,
      note: 'Age is measured against the newest year present in this country\'s uploads.',
    },
  };
}

function latestTradeYear(bundle: AnalysisBundle): number | null {
  const years = bundle.yearly_trend?.map((p) => p.year) ?? [];
  return years.length ? Math.max(...years) : null;
}
