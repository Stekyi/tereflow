import type { D1Database } from '@cloudflare/workers-types';

/**
 * Blue oceans: lines where the opening is not already crowded.
 *
 * A high opportunity score says a trade is large and growing. It says nothing
 * about whether anybody can get into it. A market can score well and still be
 * shut: one incumbent supplying nearly all of it, or a product a country
 * already dominates, leaves a newcomer nothing to take.
 *
 * So this filters the scored opportunities down to the ones where the data
 * shows room, using two shapes that the analysis already measures:
 *
 *   concentrated_supply  the country imports a lot of this and one or two
 *                        partners carry most of it. A single dependency is a
 *                        risk to the buyer and an opening to anyone who can
 *                        offer a second source.
 *
 *   growing_unserved     the trade is growing and the country's own share of
 *                        it is small. The demand is moving and the country is
 *                        not the one meeting it.
 *
 * What this is not: a forecast, a recommendation, or a claim that a business
 * will work. Nothing in trade data measures whether a newcomer can actually
 * produce the thing, at what cost, or against what local competition. The
 * limitations travel with every row so they cannot be dropped by a caller that
 * only wants the headline.
 */

/**
 * The concentration above which supply counts as held by few hands.
 *
 * 0.15 is the standard boundary between an unconcentrated and a moderately
 * concentrated market in Herfindahl-Hirschman terms, the measure competition
 * authorities use on the same question. Borrowed rather than invented, because
 * a threshold chosen to make particular countries qualify is a threshold that
 * will be chosen again the next time the answer is inconvenient.
 *
 * Ghana's vehicle imports sit at 0.16 with the United States on 27.5% of 62
 * partners: moderately concentrated, one clear lead supplier.
 */
const CONCENTRATED_HHI = 0.15;

/**
 * A lead supplier has to be identifiable for the finding to be sayable.
 *
 * This is not a second concentration test. HHI already measures the whole
 * distribution, and gating on both would count the same fact twice and reject
 * genuinely concentrated markets for having their weight spread over three
 * suppliers rather than one. This only asks that there is somebody to name.
 */
const NAMEABLE_PARTNER_SHARE = 15;

/** Below this score there is no case to answer, crowded or not. */
const MIN_SCORE = 45;

export type BlueOceanKind = 'concentrated_supply' | 'growing_unserved';

export interface BlueOcean {
  product_code: string;
  product_name: string;
  trade_flow: string;
  /** The scored opportunity this was drawn from, unchanged. */
  opportunity_score: number;
  kind: BlueOceanKind;
  /** Why this line counts as uncontested, in the terms that were measured. */
  reason: string;
  /** The figures the reason rests on, so a reader can check it. */
  evidence: string[];
  /** What the figures do not cover. Travels with the row, never separately. */
  limitations: string[];
  top_partner: string | null;
  top_partner_share_pct: number | null;
  supplier_hhi: number | null;
  value_usd: number | null;
  cagr_pct: number | null;
  data_confidence: number | null;
}

export type BlueOceanVisibility = 'hidden' | 'premium' | 'registered';

/** Who is asking. Signed-out visitors are not a tier, they are the absence of one. */
export type ViewerTier = 'anonymous' | 'registered' | 'premium';

export interface BlueOceanResult {
  /** Null when the viewer is not allowed to see them. Empty means none were found. */
  blue_oceans: BlueOcean[] | null;
  visibility: BlueOceanVisibility;
  /** Present when nothing is returned, saying which of the two reasons applies. */
  withheld_reason: string | null;
}

interface OpportunityRow {
  product_code: string;
  product_name: string;
  trade_flow: string;
  opportunity_score: number;
  signal_type: string;
  score_breakdown_json: string | null;
  evidence_json: string | null;
  limitations_json: string | null;
  data_confidence: number | null;
}

function parseJson<T>(raw: string | null, fallback: T): T {
  if (!raw) return fallback;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

/**
 * Pulls a figure back out of the evidence lines.
 *
 * The analytics step writes its working as prose, which is right for a reader
 * and awkward here. Returning null on no match matters: a missing HHI must not
 * become zero, because zero means perfectly open supply, which is the opposite
 * of unknown.
 */
function fromEvidence(evidence: string[], pattern: RegExp): string | null {
  for (const line of evidence) {
    const m = line.match(pattern);
    if (m) return m[1];
  }
  return null;
}

function numberOrNull(text: string | null): number | null {
  if (text == null) return null;
  const n = Number(text.replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}

/**
 * Decides whether a viewer may see a country's blue oceans.
 *
 * Written as its own function so the rule has one home. A gate spread across
 * the handler and the query is a gate that eventually disagrees with itself.
 */
export function canView(visibility: BlueOceanVisibility, viewer: ViewerTier): boolean {
  if (visibility === 'hidden') return false;
  if (viewer === 'anonymous') return false;
  if (visibility === 'premium') return viewer === 'premium';
  return true;
}

/** The sentence shown in place of the analysis, saying which rule applied. */
function withheldReason(visibility: BlueOceanVisibility, viewer: ViewerTier): string {
  if (visibility === 'hidden') {
    return 'Blue ocean analysis has not been published for this country yet.';
  }
  if (viewer === 'anonymous') {
    return 'Sign in to see the blue ocean analysis for this country.';
  }
  return 'Blue ocean analysis for this country is available to premium accounts.';
}

export async function loadBlueOceans(
  db: D1Database,
  countryCode: string,
  visibility: BlueOceanVisibility,
  viewer: ViewerTier,
  limit = 12,
): Promise<BlueOceanResult> {
  if (!canView(visibility, viewer)) {
    return { blue_oceans: null, visibility, withheld_reason: withheldReason(visibility, viewer) };
  }

  const { results } = await db
    .prepare(
      `SELECT product_code, product_name, trade_flow, opportunity_score, signal_type,
              score_breakdown_json, evidence_json, limitations_json, data_confidence
       FROM opportunities
       WHERE country_code = ?1
         AND is_excluded = 0
         AND opportunity_score >= ?2
       ORDER BY opportunity_score DESC`,
    )
    .bind(countryCode, MIN_SCORE)
    .all<OpportunityRow>();

  const found: BlueOcean[] = [];

  for (const row of results ?? []) {
    const evidence = parseJson<string[]>(row.evidence_json, []);
    const limitations = parseJson<string[]>(row.limitations_json, []);
    const breakdown = parseJson<Record<string, number>>(row.score_breakdown_json, {});

    const hhi = numberOrNull(fromEvidence(evidence, /supplier concentration \(HHI\): ([\d.]+)/i));
    const partnerLine = fromEvidence(evidence, /top partner: (.+?) at [\d.]+%/i);
    const partnerShare = numberOrNull(fromEvidence(evidence, /top partner: .+? at ([\d.]+)%/i));
    const value = numberOrNull(fromEvidence(evidence, /\((\d+) USD\)/));
    const cagr = numberOrNull(fromEvidence(evidence, /3 year CAGR: (-?[\d.]+)%/i));

    let kind: BlueOceanKind | null = null;
    let reason = '';

    if (
      row.signal_type === 'import_substitution' &&
      hhi != null &&
      hhi >= CONCENTRATED_HHI &&
      partnerLine != null &&
      partnerShare != null &&
      partnerShare >= NAMEABLE_PARTNER_SHARE
    ) {
      kind = 'concentrated_supply';
      reason =
        `${partnerLine} supplies ${partnerShare.toFixed(0)}% of what the country buys here, and ` +
        `supply overall is concentrated. That is a single dependency for the buyer and room for ` +
        `a second source.`;
    } else if (
      row.signal_type === 'export_growth' &&
      cagr != null &&
      cagr > 0 &&
      // A low import_dependency term means the country is not itself the one
      // meeting this demand, which is what leaves the space open.
      (breakdown.import_dependency ?? 1) < 0.5
    ) {
      kind = 'growing_unserved';
      reason =
        `Demand here is growing at ${cagr.toFixed(0)}% a year and the country holds only a small ` +
        `part of it. The trade is moving and somebody other than this country is carrying it.`;
    }

    if (!kind) continue;

    found.push({
      product_code: row.product_code,
      product_name: row.product_name,
      trade_flow: row.trade_flow,
      opportunity_score: row.opportunity_score,
      kind,
      reason,
      evidence,
      // The caveat that matters most for this framing specifically, ahead of
      // whatever the analysis already recorded.
      limitations: [
        'Room in the data is not the same as room in the market. Nothing here measures whether a newcomer can produce this, at what cost, or against what local competition.',
        ...limitations,
      ],
      top_partner: partnerLine,
      top_partner_share_pct: partnerShare,
      supplier_hhi: hhi,
      value_usd: value,
      cagr_pct: cagr,
      data_confidence: row.data_confidence,
    });

    if (found.length >= limit) break;
  }

  return { blue_oceans: found, visibility, withheld_reason: null };
}
