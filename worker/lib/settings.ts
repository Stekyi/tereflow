import type { Env } from './db';

/**
 * Admin-editable settings.
 *
 * Everything here used to be a literal in the source. The rule is that a
 * number somebody might reasonably want to change should not require a deploy
 * to change, so they live in code_setup and are read through here.
 *
 * Reads are cached for the lifetime of one request rather than one process:
 * a Worker isolate can live for a long time, and a setting changed in the
 * portal that only takes effect on the next cold start is worse than no
 * setting at all.
 */

export interface Settings {
  scoreBandStrong: number;
  scoreBandModerate: number;
  scoreWeightGrowth: number;
  scoreWeightMomentum: number;
  scoreWeightConfidence: number;
  scoreWeightSize: number;
  newTradeCagrPct: number;
  noiseFloorHs6Usd: number;
  noiseFloorHs6Share: number;
  noiseFloorHs2Usd: number;
  noiseFloorHs2Share: number;
  minGrowthPct: number;
  growthBaseDivisor: number;
  signalsPerCountry: number;
  signalsPerFlow: number;
  marketTopN: number;
  topOpportunities: number;
  chapterCoverageTarget: number;
  maxDetailChapters: number;
  dominantShareThreshold: number;
  pricePremiumHigh: number;
  pricePremiumLow: number;
  pricingMinValueUsd: number;
  pricingMaxDeviation: number;
}

/**
 * The values the code shipped with.
 *
 * Used when a row is missing, which happens on a database that has not run the
 * migration yet, and as the floor under a row somebody has emptied. Behaviour
 * without code_setup is therefore identical to behaviour before it existed.
 */
export const DEFAULTS: Settings = {
  scoreBandStrong: 65,
  scoreBandModerate: 45,
  scoreWeightGrowth: 34,
  scoreWeightMomentum: 26,
  scoreWeightConfidence: 22,
  scoreWeightSize: 18,
  newTradeCagrPct: 300,
  noiseFloorHs6Usd: 2_000_000,
  noiseFloorHs6Share: 0.0002,
  noiseFloorHs2Usd: 5_000_000,
  noiseFloorHs2Share: 0.002,
  minGrowthPct: 8,
  growthBaseDivisor: 20,
  signalsPerCountry: 40,
  signalsPerFlow: 25,
  marketTopN: 10,
  topOpportunities: 5,
  chapterCoverageTarget: 0.92,
  maxDetailChapters: 22,
  dominantShareThreshold: 0.25,
  pricePremiumHigh: 1.15,
  pricePremiumLow: 0.85,
  pricingMinValueUsd: 1_000_000,
  pricingMaxDeviation: 10,
};

const CODE_TO_KEY: Record<string, keyof Settings> = {
  SCORE_BAND_STRONG: 'scoreBandStrong',
  SCORE_BAND_MODERATE: 'scoreBandModerate',
  SCORE_WEIGHT_GROWTH: 'scoreWeightGrowth',
  SCORE_WEIGHT_MOMENTUM: 'scoreWeightMomentum',
  SCORE_WEIGHT_CONFIDENCE: 'scoreWeightConfidence',
  SCORE_WEIGHT_SIZE: 'scoreWeightSize',
  NEW_TRADE_CAGR_PCT: 'newTradeCagrPct',
  NOISE_FLOOR_HS6_USD: 'noiseFloorHs6Usd',
  NOISE_FLOOR_HS6_SHARE: 'noiseFloorHs6Share',
  NOISE_FLOOR_HS2_USD: 'noiseFloorHs2Usd',
  NOISE_FLOOR_HS2_SHARE: 'noiseFloorHs2Share',
  MIN_GROWTH_PCT: 'minGrowthPct',
  GROWTH_BASE_DIVISOR: 'growthBaseDivisor',
  SIGNALS_PER_COUNTRY: 'signalsPerCountry',
  SIGNALS_PER_FLOW: 'signalsPerFlow',
  MARKET_TOP_N: 'marketTopN',
  TOP_OPPORTUNITIES: 'topOpportunities',
  CHAPTER_COVERAGE_TARGET: 'chapterCoverageTarget',
  MAX_DETAIL_CHAPTERS: 'maxDetailChapters',
  DOMINANT_SHARE_THRESHOLD: 'dominantShareThreshold',
  PRICE_PREMIUM_HIGH: 'pricePremiumHigh',
  PRICE_PREMIUM_LOW: 'pricePremiumLow',
  PRICING_MIN_VALUE_USD: 'pricingMinValueUsd',
  PRICING_MAX_DEVIATION: 'pricingMaxDeviation',
};

export async function loadSettings(env: Env): Promise<Settings> {
  const settings: Settings = { ...DEFAULTS };
  try {
    const { results } = await env.DB.prepare('SELECT code, value FROM code_setup').all<{
      code: string;
      value: string;
    }>();
    for (const row of results ?? []) {
      const key = CODE_TO_KEY[row.code];
      if (!key) continue;
      const n = Number(row.value);
      // A setting that will not parse is ignored rather than allowed to poison
      // the maths with NaN. The portal validates on write; this is the guard
      // for a row edited directly against the database.
      if (Number.isFinite(n)) settings[key] = n;
    }
  } catch {
    // No table yet, or the database is unreachable. The shipped values are
    // correct behaviour, so there is nothing to report.
  }
  return settings;
}

export interface SetupRow {
  code: string;
  name: string;
  description: string;
  value: string;
  default_value: string;
  kind: 'number' | 'text' | 'percent' | 'usd';
  category: string;
  updated_at: string;
}
