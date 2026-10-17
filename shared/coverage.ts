/**
 * Data coverage for rankings that compare countries.
 *
 * A ranking mixes countries whose data can differ in how recent it is and how many years it spans. Comparing them
 * as if they were alike would reward whichever country simply has more data. So a product is ranked only when it has
 * enough comparable years, missing figures are never read as zero, and every difference in coverage between the
 * countries in a ranking is stated next to it.
 */
export const MIN_YEARS_TO_RANK = 3;
/** A country whose latest year trails the newest by more than this is not compared with the newest. */
export const MAX_YEAR_LAG = 1;

export type CoverageLevel = 'complete' | 'partial' | 'limited';

export interface CoverageItem {
  years_available: number | null;
  confidence?: string | null;
}

export interface CountryInput {
  iso3: string;
  name: string;
  latest_year: number;
  items: CoverageItem[];
}

export interface CountryCoverage {
  iso3: string;
  name: string;
  latest_year: number;
  /** The span of years behind the deepest product, for example "2021 to 2025". */
  period: string | null;
  items_considered: number;
  items_ranked: number;
  items_excluded: number;
  excluded_for_few_years: number;
  /** True when this country's latest year trails the newest in the ranking by more than the allowed lag. */
  stale: boolean;
  /** Share of considered products that have enough years to be ranked. */
  completeness_pct: number;
  level: CoverageLevel;
  note: string;
}

export interface CoverageAssessment {
  newest_year: number | null;
  countries: CountryCoverage[];
  /** True only when every country has the same latest year and the same completeness level. */
  comparable: boolean;
  /** A plain sentence naming the differences, or null when there is nothing to disclose. */
  disclosure: string | null;
}

/** Whether one product has enough comparable data to be ranked, and if not, why. */
export function itemRankable(yearsAvailable: number | null | undefined, countryLatest: number, newest: number): { ok: boolean; reason: string | null } {
  if (countryLatest < newest - MAX_YEAR_LAG) return { ok: false, reason: `Its latest year, ${countryLatest}, trails the newest in this ranking, ${newest}.` };
  if (yearsAvailable == null) return { ok: false, reason: 'The number of years of data is not known.' };
  if (yearsAvailable < MIN_YEARS_TO_RANK) return { ok: false, reason: `Only ${yearsAvailable} year${yearsAvailable === 1 ? '' : 's'} of data; ${MIN_YEARS_TO_RANK} are needed.` };
  return { ok: true, reason: null };
}

const levelFor = (completeness: number, stale: boolean): CoverageLevel => (stale ? 'limited' : completeness >= 80 ? 'complete' : completeness >= 40 ? 'partial' : 'limited');

export function assessCoverage(inputs: CountryInput[]): CoverageAssessment {
  if (!inputs.length) return { newest_year: null, countries: [], comparable: true, disclosure: null };
  const newest = Math.max(...inputs.map((c) => c.latest_year));
  const countries: CountryCoverage[] = inputs.map((c) => {
    const stale = c.latest_year < newest - MAX_YEAR_LAG;
    const verdicts = c.items.map((i) => itemRankable(i.years_available, c.latest_year, newest));
    const ranked = verdicts.filter((v) => v.ok).length;
    const fewYears = c.items.filter((i) => (i.years_available ?? 0) < MIN_YEARS_TO_RANK).length;
    const deepest = Math.max(0, ...c.items.map((i) => i.years_available ?? 0));
    const completeness = c.items.length ? (ranked / c.items.length) * 100 : 0;
    const level = levelFor(completeness, stale);
    const period = deepest > 0 ? `${c.latest_year - deepest + 1} to ${c.latest_year}` : null;
    const note = stale
      ? `Latest year is ${c.latest_year}, behind ${newest}, so its products are not ranked against newer data.`
      : level === 'complete'
        ? `${ranked} of ${c.items.length} products have at least ${MIN_YEARS_TO_RANK} years of data.`
        : `${ranked} of ${c.items.length} products have at least ${MIN_YEARS_TO_RANK} years of data; ${fewYears} are left out of the ranking for having fewer.`;
    return {
      iso3: c.iso3, name: c.name, latest_year: c.latest_year, period, items_considered: c.items.length, items_ranked: stale ? 0 : ranked,
      items_excluded: stale ? c.items.length : c.items.length - ranked, excluded_for_few_years: fewYears, stale,
      completeness_pct: Math.round(completeness), level, note,
    };
  });
  const years = new Set(countries.map((c) => c.latest_year));
  const levels = new Set(countries.map((c) => c.level));
  const comparable = years.size === 1 && levels.size === 1;
  let disclosure: string | null = null;
  if (!comparable) {
    const parts = countries.map((c) => `${c.name}: ${c.period ?? 'no period'}, ${c.level}`);
    disclosure = `The countries in this ranking differ in data coverage (${parts.join('; ')}). Scores are not adjusted for this, so a difference may reflect how much data a country has rather than how good a market is.`;
  }
  return { newest_year: newest, countries, comparable, disclosure };
}