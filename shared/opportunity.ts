
/**
 * The momentum score: a 0-100 reading of how fast one trade line is moving.
 *
 * Named for what it weighs. Growth and momentum carry 60 of its 100 points, so
 * a line can score highly on a trade that is small, difficult to enter, and
 * already supplied by somebody entrenched. It ranks trajectory in the reported
 * data and nothing else.
 *
 * THIS IS NOT THE SAME NUMBER as the opportunity score on the country
 * opportunities page. That one runs on a single country's own statistics and
 * weighs import dependency, stability and supplier concentration, which are
 * about whether a market can be entered. This one runs on world Comtrade data
 * across countries and asks only how fast a line is moving. The two answer
 * different questions on different data and are not comparable, so they are
 * named differently and captioned wherever either is shown. Two numbers sharing
 * a label is how a reader ends up treating them as one measure that keeps
 * disagreeing with itself.
 *
 * The pipeline stores momentum, growth, confidence and size. Those are the
 * right things to store, but "momentum 0.41" means nothing to somebody
 * deciding where to put money. This turns them into a single number with a
 * stated basis, computed at read time so the weighting can be corrected
 * without re-running the pipeline against live APIs.
 *
 * It is deliberately not a prediction. It ranks how well-evidenced a movement
 * is, which is a different claim, and `SCORE_BASIS` spells that out in the UI.
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

export interface ScoreComponent {
  /** The name a reader sees, not the variable name. */
  label: string;
  /** What this term is measuring, in one sentence. */
  meaning: string;
  /** The figure it was computed from, already formatted. */
  input: string;
  /** 0 to 1, before weighting. */
  normalised: number;
  /** Points out of 100 this term contributed. */
  weight: number;
  points: number;
  /** Said out loud when a term is standing in for a missing number. */
  note: string | null;
}

export interface ScoreExplanation {
  score: number;
  components: ScoreComponent[];
}

/**
 * The score, with the reasoning that produced it.
 *
 * A bare number out of 100 asks to be trusted and gives nobody a way to argue.
 * The same four terms that make the score are returned alongside it so a reader
 * can see that, say, a 62 is mostly size and confidence with almost no growth,
 * and decide for themselves whether that is the trade they want.
 *
 * Same input, same output, as with everything else here. No clock, no network.
 */
export function explainScore(input: ScoreInput): ScoreExplanation {
  const rawGrowth = input.cagr_3y ?? 0;
  const isNew = isNewTrade(rawGrowth);
  const growth = isNew ? 0.8 : clamp01(rawGrowth / 60);
  const momentum = clamp01(input.momentum ?? 0);
  const confidence = clamp01(input.confidence ?? 0);
  const size = sizeTerm(input.value_usd);

  const components: ScoreComponent[] = [
    {
      label: 'Growth',
      meaning: 'How fast the trade has grown over three years. Full marks at 60% a year.',
      input: input.cagr_3y == null ? 'Not available' : `${input.cagr_3y.toFixed(1)}% a year`,
      normalised: growth,
      weight: WEIGHTS.growth,
      points: WEIGHTS.growth * growth,
      note: isNew
        ? 'Growth this steep measures a near-zero starting point rather than compounding, so it is credited as strong rather than infinite.'
        : input.cagr_3y == null
          ? 'No growth rate on record, so this term contributes nothing.'
          : null,
    },
    {
      label: 'Momentum',
      meaning: 'Whether the climb was steady or one freak year, and how much share it took.',
      input: input.momentum == null ? 'Not available' : input.momentum.toFixed(2),
      normalised: momentum,
      weight: WEIGHTS.momentum,
      points: WEIGHTS.momentum * momentum,
      note: input.momentum == null ? 'No momentum on record, so this term contributes nothing.' : null,
    },
    {
      label: 'Confidence',
      meaning: 'How much history and detail sits behind the figures.',
      input: input.confidence == null ? 'Not available' : input.confidence.toFixed(2),
      normalised: confidence,
      weight: WEIGHTS.confidence,
      points: WEIGHTS.confidence * confidence,
      note: input.confidence == null ? 'No confidence on record, so this term contributes nothing.' : null,
    },
    {
      label: 'Market size',
      meaning: 'Value of the trade, on a log scale from $2m to $10bn.',
      input: input.value_usd == null ? 'Not available' : formatUsd(input.value_usd),
      normalised: size,
      weight: WEIGHTS.size,
      points: WEIGHTS.size * size,
      note: input.value_usd == null ? 'No value on record, so this term contributes nothing.' : null,
    },
  ];

  return {
    // Rounded exactly as opportunityScore rounds, so the parts always add to
    // the number shown beside them. A breakdown that does not reconcile is
    // worse than no breakdown.
    score: Math.round(components.reduce((s, c) => s + c.points, 0)),
    components,
  };
}

function formatUsd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)}K`;
  return `$${v.toFixed(0)}`;
}

export type ScoreBand = 'strong' | 'moderate' | 'watch';

/**
 * Fallback cut-offs.
 *
 * The bands that actually apply live in code_setup and are decided on the
 * server, which sends the band along with each product so a badge can never
 * disagree with a count computed from the same numbers. These are what the
 * code shipped with, for anything rendering a bare score with no server band
 * to hand.
 */
export const BAND_STRONG = 74;
export const BAND_MODERATE = 62;

export function scoreBand(
  score: number,
  strong: number = BAND_STRONG,
  moderate: number = BAND_MODERATE,
): ScoreBand {
  if (score >= strong) return 'strong';
  if (score >= moderate) return 'moderate';
  return 'watch';
}

export const SCORE_BAND_LABEL: Record<ScoreBand, string> = {
  strong: 'Strong case',
  moderate: 'Worth a look',
  watch: 'Early days',
};

/** Shown wherever the score is, so nobody reads it as a forecast. */
/** The label shown wherever this number appears. One name, one meaning. */
export const MOMENTUM_SCORE_LABEL = 'Momentum score';

export const SCORE_BASIS =
  'Weighs how fast the trade is growing, how steadily, how well evidenced it is, and how big it ' +
  'already is. Growth and steadiness carry most of it, so this reads movement rather than ease ' +
  'of entry. It is not a forecast of returns.';

/**
 * Said wherever the momentum score sits near anything from the country
 * opportunities page, so nobody reads 83 here and 64 there as the same scale.
 */
export const SCORE_NOT_COMPARABLE =
  'Measured on world trade data across countries. Not the same scale as the opportunity score on a ' +
  "country's own opportunities page, which weighs how enterable a market is.";

