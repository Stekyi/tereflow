import type { Flow } from './types';

/**
 * A 0-100 readability score for one opportunity.
 *
 * The pipeline stores momentum, growth, confidence and size. Those are the
 * right things to store, but "momentum 0.41" means nothing to somebody
 * deciding where to put money. This turns them into a single number with a
 * stated basis, computed at read time so the weighting can be corrected
 * without re-running the pipeline against live APIs.
 *
 * It is deliberately not a prediction. It ranks how well-evidenced an opening
 * is, which is a different claim, and `scoreBasis` spells that out in the UI.
 */

/**
 * Above this compound rate the line grew more than 60-fold over the window,
 * which means the earlier year was negligible rather than that the trade is
 * compounding at that rate. South Africa's plug-in hybrid exports went from
 * $0.2m to $1,549m, which is arithmetically 1811% a year and tells the reader
 * nothing true. Those are reported as newly established trade instead.
 */
export const NEW_TRADE_CAGR_THRESHOLD = 300;

export function isNewTrade(cagr: number | null): boolean {
  return cagr != null && cagr > NEW_TRADE_CAGR_THRESHOLD;
}

/**
 * What to print where a growth rate would go. Returns null when the ordinary
 * percentage is the honest answer, so the caller formats it as usual.
 */
export function growthLabel(cagr: number | null): string | null {
  if (cagr == null) return 'Growth not comparable';
  if (isNewTrade(cagr)) return 'Newly established trade';
  return null;
}
export interface ScoreInput {
  cagr_3y: number | null;
  momentum: number | null;
  confidence: number | null;
  value_usd: number | null;
}

const WEIGHTS = {
  growth: 34,
  momentum: 26,
  confidence: 22,
  size: 18,
} as const;

function clamp01(n: number): number {
  return Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : 0;
}

/**
 * Trade values span roughly $1m to $100bn, so a linear size term would give
 * every SME-scale product the same zero. Log scale spreads that range: $2m
 * scores near 0, $10bn near 1.
 */
function sizeTerm(valueUsd: number | null): number {
  if (!valueUsd || valueUsd <= 0) return 0;
  const low = Math.log10(2_000_000);
  const high = Math.log10(10_000_000_000);
  return clamp01((Math.log10(valueUsd) - low) / (high - low));
}

export function opportunityScore(input: ScoreInput): number {
  // A rate this high measures a negligible starting point, not compounding.
  // Feeding it into the growth term straight would rank every newly reported
  // line above every genuinely growing one. Newly established trade is
  // credited as strong growth, not infinite growth.
  const rawGrowth = input.cagr_3y ?? 0;
  const growth = isNewTrade(rawGrowth) ? 0.8 : clamp01(rawGrowth / 60);
  const momentum = clamp01(input.momentum ?? 0);
  const confidence = clamp01(input.confidence ?? 0);
  const size = sizeTerm(input.value_usd);

  return Math.round(
    WEIGHTS.growth * growth +
      WEIGHTS.momentum * momentum +
      WEIGHTS.confidence * confidence +
      WEIGHTS.size * size,
  );
}

export type ScoreBand = 'strong' | 'moderate' | 'watch';

export function scoreBand(score: number): ScoreBand {
  if (score >= 65) return 'strong';
  if (score >= 45) return 'moderate';
  return 'watch';
}

export const SCORE_BAND_LABEL: Record<ScoreBand, string> = {
  strong: 'Strong case',
  moderate: 'Worth a look',
  watch: 'Early days',
};

/** Shown wherever the score is, so nobody reads it as a forecast. */
export const SCORE_BASIS =
  'Blends growth rate, share gained, how steady the growth has been, and how big the trade already is. ' +
  'It ranks how well evidenced an opening is in the reported data. It is not a forecast of returns.';

/**
 * Plain-English one-liner for a signal, used on cards where there is no room
 * for the full rationale.
 */
export function opportunityHeadline(
  productName: string,
  flow: Flow,
  countryName: string,
  bestMarket: string | null,
): string {
  return flow === 'export'
    ? `${countryName} sells more ${productName.toLowerCase()} every year` +
        (bestMarket ? `, mostly to ${bestMarket}` : '')
    : `${countryName} buys more ${productName.toLowerCase()} every year` +
        (bestMarket ? `, mostly from ${bestMarket}` : '');
}
