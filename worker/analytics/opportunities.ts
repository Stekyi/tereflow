/**
 * Scoring, filtering and explanation.
 *
 * Deterministic throughout: same metrics in, same score out, every time. No
 * clock, no network, no randomness, and no language model anywhere in the path.
 * A score somebody cannot reproduce is a score they cannot argue with, and this
 * product is meant to be argued with.
 *
 * Score and confidence are kept apart on purpose. Score answers "how
 * interesting is this". Confidence answers "how much do we actually know". A
 * product can score 88 on two years of chapter-level data, and saying both
 * numbers is the honest version of that sentence.
 */
import type { CountryConfig, ExclusionRule, ScoringWeights } from '../providers/types';
import type { ProductMetrics, Trend } from './metrics';

export type SignalType = 'import_substitution' | 'export_growth' | 'supplier_diversification';
export type Confidence = 'high' | 'medium' | 'low';

export interface ScoreBreakdown {
  market_size: number;
  growth: number;
  import_dependency: number;
  stability: number;
  supplier_concentration: number;
}

export interface Opportunity {
  country_code: string;
  trade_flow: ProductMetrics['trade_flow'];
  classification_system: 'HS';
  classification_level: ProductMetrics['classification_level'];
  product_code: string;
  product_name: string;

  opportunity_score: number;
  score_breakdown: ScoreBreakdown;
  signal_type: SignalType;

  data_confidence: Confidence;
  confidence_reasons: string[];

  explanation: string;
  evidence: string[];
  limitations: string[];

  is_excluded: boolean;
  excluded_reason: string | null;

  metrics: ProductMetrics;
}

/**
 * Does a traditional-commodity rule match this product?
 *
 * Returns the reason rather than a boolean so the exclusion can be shown. A
 * filter nobody can inspect is a filter nobody can correct, and the risk with
 * this one is hiding a real opportunity rather than showing a bad one.
 */
export function exclusionFor(
  productCode: string,
  description: string | null,
  rules: ExclusionRule[],
): string | null {
  for (const rule of rules) {
    if (rule.codes?.some((c) => productCode === c || productCode.startsWith(c))) {
      return rule.reason;
    }
    if (rule.pattern && description) {
      if (new RegExp(rule.pattern, 'i').test(description)) return rule.reason;
    }
  }
  return null;
}

/**
 * Normalise a value onto 0..1 relative to the largest product in the run.
 *
 * A log scale was tried first and it flattered small markets badly: against a
 * 3.2 billion dollar ceiling, a 100,000 dollar market scored 0.53 while the
 * ceiling itself scored 1.0. A market thirty thousand times larger was not
 * twice as good, and the result was silk at half a million dollars outranking
 * a two billion dollar machinery market.
 *
 * The share of the ceiling under a root keeps the ordering, gives the middle of
 * the range room to breathe, and puts a tiny market where it belongs. The
 * exponent is a judgement about how much to reward scale and is kept here as a
 * named constant rather than buried in the expression.
 */
const SIZE_CURVE = 0.35;

function sizeScore(value: number, ceiling: number): number {
  if (!Number.isFinite(value) || value <= 0 || ceiling <= 0) return 0;
  return Math.max(0, Math.min(1, Math.pow(value / ceiling, SIZE_CURVE)));
}

/**
 * Below this a market is too small to be worth an entrepreneur's attention,
 * whatever its growth rate looks like as a percentage.
 *
 * Ghana's furskin imports are about a hundred thousand dollars a year across
 * the whole country. Nothing built on that is a business, and a ranking that
 * puts it above machinery is not describing the world.
 */
const MIN_MARKET_USD = 1_000_000;

/** Map growth onto 0..1, where flat is a half and 50% a year is full marks. */
function growthScore(pct: number | null): number {
  if (pct == null) return 0.5; // unknown is not bad, it is unknown
  if (pct <= -50) return 0;
  if (pct >= 50) return 1;
  return (pct + 50) / 100;
}

function stabilityScore(trend: Trend, volatility: number | null): number {
  // Steady demand is what somebody building a business needs. A market that
  // doubles and halves is worth less than one that grows predictably, even if
  // the average growth is the same.
  if (trend === 'insufficient_data') return 0.4;
  if (trend === 'volatile') return 0.15;
  if (volatility == null) return 0.5;
  if (volatility <= 15) return 1;
  if (volatility >= 80) return 0.1;
  return 1 - (volatility - 15) / 65 * 0.9;
}

/**
 * How concentrated the supply is, scored as an opportunity rather than a risk.
 *
 * A market supplied by one country is easier to displace than one already
 * served by twenty competing exporters, so high concentration scores high here.
 * That is the import-substitution reading, and it is the opposite of how the
 * same number would be read as a supply-chain risk. Stated because the sign is
 * genuinely arguable.
 */
function concentrationScore(hhi: number | null): number {
  if (hhi == null) return 0.4;
  return Math.max(0, Math.min(1, hhi));
}

/**
 * Import dependence: how much of this demand is met from abroad.
 *
 * Without domestic production figures this cannot be measured properly, and
 * inventing it would be exactly the fabrication the whole design refuses. What
 * is used instead is the observable part: a large, growing import bill is
 * evidence of demand being met from abroad. The limitation is carried into the
 * opportunity so the reader knows what this leg of the score is and is not.
 */
function importDependencyScore(m: ProductMetrics, ceiling: number): number {
  const size = sizeScore(m.import_value_usd, ceiling);
  const growing = m.trend === 'growing' ? 1 : m.trend === 'stable' ? 0.6 : 0.3;
  return size * 0.6 + growing * 0.4;
}

export function scoreOne(
  m: ProductMetrics,
  weights: ScoringWeights,
  context: { valueCeiling: number },
): { score: number; breakdown: ScoreBreakdown } {
  const breakdown: ScoreBreakdown = {
    market_size: sizeScore(m.import_value_usd, context.valueCeiling),
    // Prefer the three year rate over one year: a single year's jump is often
    // a restock or a one-off shipment.
    growth: growthScore(m.cagr_3y_pct ?? m.yoy_value_pct),
    import_dependency: importDependencyScore(m, context.valueCeiling),
    stability: stabilityScore(m.trend, m.volatility_pct),
    supplier_concentration: concentrationScore(m.supplier_hhi),
  };

  const score =
    breakdown.market_size * weights.market_size +
    breakdown.growth * weights.growth +
    breakdown.import_dependency * weights.import_dependency +
    breakdown.stability * weights.stability +
    breakdown.supplier_concentration * weights.supplier_concentration;

  // Rounded to one decimal so a rerun on identical data produces a byte
  // identical score rather than one differing in the fifteenth place.
  return { score: Math.round(score * 1000) / 10, breakdown };
}

/**
 * How much do we actually know about this product?
 *
 * Derived only from the shape of the evidence: years of history, granularity,
 * whether volume and partners were reported, whether the latest year is
 * complete. Never from the score, because "we are confident because the number
 * is high" is circular.
 */
export function confidenceFor(m: ProductMetrics): { level: Confidence; reasons: string[] } {
  const reasons: string[] = [];
  let points = 0;

  if (m.years_available >= 5) {
    points += 2;
    reasons.push(`${m.years_available} years of history.`);
  } else if (m.years_available >= 3) {
    points += 1;
    reasons.push(`${m.years_available} years of history, enough for a trend but not a long one.`);
  } else {
    reasons.push(`Only ${m.years_available} year${m.years_available === 1 ? '' : 's'} of history.`);
  }

  if (m.classification_level === 'HS6' || m.classification_level === 'HS10') {
    points += 2;
    reasons.push(`Product-level detail (${m.classification_level}).`);
  } else {
    reasons.push(`${m.classification_level} chapter level, which describes a sector rather than a product.`);
  }

  if (m.net_weight_kg != null) {
    points += 1;
    reasons.push('Volume reported alongside value.');
  } else {
    reasons.push('No volume reported.');
  }

  if (m.partner_count >= 3) {
    points += 1;
    reasons.push(`${m.partner_count} partner countries reported.`);
  } else {
    reasons.push(`Only ${m.partner_count} partner countr${m.partner_count === 1 ? 'y' : 'ies'} reported.`);
  }

  if (m.latest_year_partial) {
    points -= 1;
    reasons.push(`The latest year is incomplete (${m.months_in_latest_year} months).`);
  }

  const level: Confidence = points >= 5 ? 'high' : points >= 3 ? 'medium' : 'low';
  return { level, reasons };
}

const TREND_PHRASE: Record<Trend, string> = {
  growing: 'grown',
  declining: 'fallen',
  stable: 'held roughly level',
  volatile: 'moved unevenly',
  insufficient_data: 'not been measured over enough years to describe',
};

/**
 * The explanation, assembled from the metrics by rule.
 *
 * No language model, and none needed. Every sentence is a template filled from
 * a number that exists, and a sentence whose number is missing is left out
 * rather than hedged. That is why "insufficient evidence" reads as a finding
 * here instead of an apology.
 */
export function explain(m: ProductMetrics, signal: SignalType): { text: string; evidence: string[] } {
  const evidence: string[] = [];
  const parts: string[] = [];
  const name = m.product_description ?? `HS ${m.product_code}`;
  const flowWord = m.trade_flow === 'import' ? 'Imports' : 'Exports';

  parts.push(`${flowWord} of ${name} reached ${usd(m.import_value_usd)} in ${m.latest_year}.`);
  evidence.push(`${m.latest_year} value: ${usd(m.import_value_usd)} (${m.import_value_usd.toFixed(0)} USD)`);

  if (m.trend !== 'insufficient_data') {
    const span = `${m.earliest_year} to ${m.latest_year}`;
    parts.push(`Value has ${TREND_PHRASE[m.trend]} over ${span}.`);
    evidence.push(`trend: ${m.trend} across ${m.years_available} years`);
  }

  if (m.cagr_3y_pct != null) {
    parts.push(`That is ${signed(m.cagr_3y_pct)}% a year over three years.`);
    evidence.push(`3 year CAGR: ${m.cagr_3y_pct.toFixed(1)}%`);
  } else if (m.yoy_value_pct != null) {
    parts.push(`Year on year the change was ${signed(m.yoy_value_pct)}%.`);
    evidence.push(`year on year: ${m.yoy_value_pct.toFixed(1)}%`);
  }

  if (m.top_partner && m.top_partner_share_pct != null) {
    parts.push(
      `${m.top_partner} supplied ${m.top_partner_share_pct.toFixed(0)}% of it` +
        (m.partner_count > 1 ? `, of ${m.partner_count} reporting partners.` : '.'),
    );
    evidence.push(`top partner: ${m.top_partner} at ${m.top_partner_share_pct.toFixed(1)}%`);
  }

  if (m.unit_value_usd_per_kg != null) {
    evidence.push(`unit value: $${m.unit_value_usd_per_kg.toFixed(2)} per kg`);
  }
  if (m.supplier_hhi != null) {
    evidence.push(`supplier concentration (HHI): ${m.supplier_hhi.toFixed(2)}`);
  }

  if (signal === 'import_substitution') {
    parts.push('Sustained imports of a product at this scale are a potential import-substitution signal.');
  } else if (signal === 'supplier_diversification') {
    parts.push(
      'Supply is concentrated in few countries, which is a potential opening for an alternative supplier ' +
        'as well as a risk to buyers who depend on it.',
    );
  } else {
    parts.push('Export growth at this rate is worth examining alongside the destination markets.');
  }

  // Said on every opportunity, whatever kind it is. These two sentences are the
  // difference between a signal and a recommendation, and they were originally
  // only on the import-substitution branch, which meant the other two kinds
  // went out sounding more certain than the data supports.
  parts.push(
    'This is a signal rather than a recommendation: nothing here measures local production capacity, ' +
      'input costs, or whether anybody can compete on it.',
  );

  return { text: parts.join(' '), evidence };
}

export function classifySignal(m: ProductMetrics): SignalType {
  if (m.trade_flow === 'export') return 'export_growth';
  // A market supplied overwhelmingly by one country is a different opening
  // than a broadly supplied one, and worth naming separately.
  if (m.supplier_hhi != null && m.supplier_hhi >= 0.5) return 'supplier_diversification';
  // One reporting partner means concentration could not be measured, but it is
  // certainly not a broadly supplied market. Calling it import substitution
  // would put the words "supplied from many countries" over a single supplier.
  if (m.supplier_hhi == null && m.partner_count <= 1) return 'supplier_diversification';
  return 'import_substitution';
}

/** Build a scored, filtered, explained opportunity for each metric. */
export function buildOpportunities(
  metrics: ProductMetrics[],
  config: CountryConfig,
): Opportunity[] {
  if (!metrics.length) return [];

  // The ceiling is the largest product in this run, so scores are relative to
  // the market being looked at rather than to a number picked in advance.
  const valueCeiling = Math.max(...metrics.map((m) => m.import_value_usd), 1);

  return metrics
    .map((m) => {
      const { score, breakdown } = scoreOne(m, config.scoring, { valueCeiling });
      const signal = classifySignal(m);
      const { level, reasons } = confidenceFor(m);
      const { text, evidence } = explain(m, signal);

      const limitations = [...m.limitations];
      if (m.trade_flow === 'import') {
        limitations.push(
          'Domestic production is not in this dataset, so the gap between local supply and demand cannot be established.',
        );
      }

      // A market below the floor is excluded by the same mechanism as a
      // traditional commodity: kept, marked, and explained. Ghana imports about
      // a hundred thousand dollars of furskins a year across the whole country,
      // and a percentage growth rate on that is arithmetic rather than an
      // opportunity.
      let excluded = exclusionFor(m.product_code, m.product_description, config.filters.excluded);
      if (!excluded && m.import_value_usd < MIN_MARKET_USD) {
        excluded =
          `The whole national market is ${usd(m.import_value_usd)} a year, which is too small ` +
          'to support a business however fast it is growing.';
      }

      return {
        country_code: m.country_code,
        trade_flow: m.trade_flow,
        classification_system: 'HS' as const,
        classification_level: m.classification_level,
        product_code: m.product_code,
        product_name: m.product_description ?? `HS ${m.product_code}`,
        opportunity_score: score,
        score_breakdown: breakdown,
        signal_type: signal,
        data_confidence: level,
        confidence_reasons: reasons,
        explanation: text,
        evidence,
        limitations,
        is_excluded: excluded != null,
        excluded_reason: excluded,
        metrics: m,
      };
    })
    .sort((a, b) => b.opportunity_score - a.opportunity_score);
}

function usd(v: number): string {
  const abs = Math.abs(v);
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)} billion`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)} million`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(0)} thousand`;
  return `$${v.toFixed(0)}`;
}

function signed(v: number): string {
  return `${v > 0 ? '+' : ''}${v.toFixed(1)}`;
}
