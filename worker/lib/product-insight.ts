import type { Env } from '../lib/db';
import { loadSettings } from '../lib/settings';
import { loadPartnerBreakdown, type PartnerBreakdown } from './partner-flows';
import { hs2Label, hs2Sector, hs6Label } from '../agent/codes';
import { shortProductName } from '../../shared/product-name';
import { explainScore, opportunityScore } from '../../shared/opportunity';
import { classify, loadClassifications } from '../lib/classify';
import type {
  PricePremium,
  ProductCountryRow,
  ProductInsight,
  ProductSubscriber,
} from '../../shared/types';

/** The stored basis for a score: the pipeline's own inputs, plus whose it is. */
interface SignalRow {
  cagr_3y: number | null;
  momentum: number | null;
  confidence: number | null;
  value_usd: number | null;
  name: string;
}

interface AnalyticsRow {  hs_code: string;
  entity_id: string;
  flow: 'export' | 'import';
  year: number;
  value_usd: number;
  qty_kg: number | null;
  unit_value_usd_t: number | null;
  cagr_pct: number | null;
  share: number | null;
  price_ratio: number | null;
  slug: string;
  name: string;
  iso3: string | null;
  continent: string | null;
}

function premiumFrom(ratio: number | null, high: number, low: number): PricePremium {
  if (ratio == null || !Number.isFinite(ratio)) return 'unknown';
  if (ratio >= high) return 'high';
  if (ratio <= low) return 'low';
  return 'typical';
}

function toRow(r: AnalyticsRow, rank: number, high: number, low: number): ProductCountryRow {
  return {
    rank,
    slug: r.slug,
    name: r.name,
    iso3: r.iso3,
    continent: r.continent,
    year: r.year,
    value_usd: r.value_usd,
    qty_kg: r.qty_kg,
    unit_value_usd_t: r.unit_value_usd_t,
    cagr_pct: r.cagr_pct,
    share: r.share,
    price_ratio: r.price_ratio,
    price_premium: premiumFrom(r.price_ratio, high, low),
  };
}

/**
 * Everything the product modal needs, in one read.
 *
 * Reads product_analytics, which the pipeline fills, rather than aggregating
 * trade_facts per request. The world median price in particular can only be
 * computed with every country in view, so it is settled once at write time.
 *
 * `focusSlug` scopes the headline figures to one country without changing the
 * lists, which is what makes the same modal work when it is opened from a
 * country page and when it is opened from the global product list.
 */
/**
 * The country code a slug maps to, for looking up stored observations.
 *
 * trade_observations is keyed on the two-letter code from the country config,
 * because that is what a provider knows about itself. The rest of the app is
 * keyed on slugs. Only the countries actually ingested from their own
 * statistics office need an entry, and an unknown slug returns something that
 * matches nothing rather than guessing: a wrong match here would attach one
 * country's partners to another country's product.
 */
function countryCodeFor(slug: string | null | undefined): string {
  if (!slug) return '';
  const known: Record<string, string> = { ghana: 'GH' };
  return known[slug] ?? '';
}

export async function buildProductInsight(
  env: Env,
  hs: string,
  focusSlug: string | null,
  /**
   * The direction the reader came in on. Somebody who tapped China's copper
   * imports wants China's import figures, not the token exports that happen to
   * exist for the same country and product.
   */
  focusFlow: 'export' | 'import' | null = null,
): Promise<ProductInsight> {
  const settings = await loadSettings(env);
  const chapter = hs.slice(0, 2);

  const { results: rows } = await env.DB.prepare(
    `SELECT a.hs_code, a.entity_id, a.flow, a.year, a.value_usd, a.qty_kg,
            a.unit_value_usd_t, a.cagr_pct, a.share, a.price_ratio,
            e.slug, e.name, e.iso3, e.continent
       FROM product_analytics a
       JOIN entities e ON e.id = a.entity_id AND e.is_active = 1
      WHERE a.hs_code = ?
      ORDER BY a.value_usd DESC`,
  )
    .bind(hs)
    .all<AnalyticsRow>();

  const all = rows ?? [];
  const sellersRaw = all.filter((r) => r.flow === 'export').slice(0, settings.marketTopN);
  const buyersRaw = all.filter((r) => r.flow === 'import').slice(0, settings.marketTopN);

  const sellers = sellersRaw.map((r, i) =>
    toRow(r, i + 1, settings.pricePremiumHigh, settings.pricePremiumLow),
  );
  const buyers = buyersRaw.map((r, i) =>
    toRow(r, i + 1, settings.pricePremiumHigh, settings.pricePremiumLow),
  );

  // The world median is over every reporting country, not just the top N, or
  // it would drift as the display limit changed. Rows below the pricing floor
  // are left out for the same reason the settlement pass leaves them out: a
  // token shipment can imply any price at all.
  const prices = all
    .filter((r) => r.value_usd >= settings.pricingMinValueUsd)
    .map((r) => r.unit_value_usd_t)
    .filter((v): v is number => v != null && v > 0)
    .sort((a, b) => a - b);
  const worldMedian = prices.length
    ? prices.length % 2
      ? prices[(prices.length - 1) / 2]
      : (prices[prices.length / 2 - 1] + prices[prices.length / 2]) / 2
    : null;

  // Headline figures follow the country in focus when there is one, in the
  // direction the reader arrived on. Without a focus it is the largest seller,
  // which is the most representative single row.
  const focus = focusSlug
    ? all.find((r) => r.slug === focusSlug && r.flow === (focusFlow ?? 'export'))
      ?? all.find((r) => r.slug === focusSlug)
    : null;
  const headline = focus ?? sellersRaw[0] ?? all[0] ?? null;

  // A country can report a value with no weight, and the largest seller often
  // is that country. Quoting no price at all when a real one sits one row down
  // would hide the number rather than protect it, so fall back and say whose
  // price it is.
  const priced = headline?.unit_value_usd_t != null
    ? null
    : all.find(
        (r) => r.flow === 'export'
          && r.unit_value_usd_t != null
          && r.value_usd >= settings.pricingMinValueUsd,
      ) ?? null;
  const unitValue = headline?.unit_value_usd_t ?? priced?.unit_value_usd_t ?? null;
  const priceRatio = headline?.unit_value_usd_t != null
    ? headline.price_ratio
    : priced?.price_ratio ?? null;

  const nameRow = await env.DB.prepare(
    `SELECT product_name FROM trade_facts
      WHERE hs_code = ? AND product_name IS NOT NULL LIMIT 1`,
  )
    .bind(hs)
    .first<{ product_name: string }>();
  const full = nameRow?.product_name ?? (hs.length === 6 ? hs6Label(hs) : hs2Label(hs));

  // Growing demand, not the biggest demand: somebody choosing where to sell is
  // asking which market is opening, not which is already largest.
  const targetMarkets = all
    .filter((r) => r.flow === 'import' && r.cagr_pct != null)
    .sort((a, b) => (b.cagr_pct ?? 0) - (a.cagr_pct ?? 0))
    .slice(0, 8)
    .map((r) => ({
      slug: r.slug,
      name: r.name,
      iso3: r.iso3,
      value_usd: r.value_usd,
      cagr_pct: r.cagr_pct,
    }));

  const { results: relatedRows } = hs.length === 6
    ? await env.DB.prepare(
        `SELECT a.hs_code, SUM(a.value_usd) AS value_usd,
                MAX(f.product_name) AS product_name
           FROM product_analytics a
           LEFT JOIN trade_facts f ON f.hs_code = a.hs_code AND f.product_name IS NOT NULL
          WHERE a.hs_code LIKE ? AND a.hs_code <> ? AND a.flow = 'export'
          GROUP BY a.hs_code
          ORDER BY value_usd DESC
          LIMIT 6`,
      )
        .bind(`${chapter}%`, hs)
        .all<{ hs_code: string; product_name: string | null; value_usd: number }>()
    : { results: [] };

  const subscribers = await loadSubscribers(env, hs, full);

  const globalClassifications = await loadClassifications(env.DB, '*');

  // Partner-level flows are a separate fetch the keyless source tier does not
  // provide. Saying so is the difference between "these are country totals"
  // and letting a reader assume they are country-to-country flows.
  // Who this country actually trades the product with.
  //
  // Comtrade's keyless tier cannot fetch partner and product together, which is
  // why this used to be a bare existence check and the modal carried a caption
  // apologising for it. A country ingested from its own statistics office does
  // have the breakdown, so the question the caption was dodging can now be
  // answered for those countries and is still honestly refused for the others.
  const partnerDetail: PartnerBreakdown | null = focus
    ? await loadPartnerBreakdown(env, {
        countryCode: countryCodeFor(focus.slug),
        countryName: focus.name,
        hs,
        flow: (focusFlow ?? focus.flow) === 'export' ? 'export' : 'import',
      })
    : null;

  const covered = await env.DB.prepare(
    `SELECT COUNT(DISTINCT a.entity_id) AS n
       FROM product_analytics a
       JOIN entities e ON e.id = a.entity_id AND e.is_active = 1`,
  ).first<{ n: number }>();

  /*
   * Take the score the pipeline already computed rather than recomputing here.
   *
   * The stored signal carries momentum and confidence; product_analytics does
   * not. Scoring from analytics alone silently forfeits those weights, which
   * made the same product read 82 in the product list and 34 in this modal.
   * Two different numbers for one thing is worse than either number.
   *
   * With a country in focus the score is that country's. Without one, the best
   * score any country holds for this product is the useful answer, since the
   * question being asked is whether the product is worth looking at at all.
   * Whose it is gets named either way.
   *
   * Where nothing was ranked the score is null rather than computed from what
   * is to hand. A product that was never ranked should say so, not report a
   * low number that reads as a verdict.
   */
  const signal = focus
    ? await env.DB.prepare(
        `SELECT s.cagr_3y, s.momentum, s.confidence, s.value_usd, e.name
           FROM opportunity_signals s
           JOIN entities e ON e.id = s.entity_id
          WHERE s.hs_code = ? AND s.entity_id = ? AND s.flow = ?
          ORDER BY s.computed_at DESC LIMIT 1`,
      )
        .bind(hs, focus.entity_id, focus.flow)
        .first<SignalRow>()
    : await env.DB.prepare(
        `SELECT s.cagr_3y, s.momentum, s.confidence, s.value_usd, e.name
           FROM opportunity_signals s
           JOIN entities e ON e.id = s.entity_id AND e.is_active = 1
          WHERE s.hs_code = ?
          ORDER BY s.momentum DESC, s.value_usd DESC LIMIT 1`,
      )
        .bind(hs)
        .first<SignalRow>();

  const score = signal ? opportunityScore(signal) : null;
  // The same four terms that produced the score, so the reader can see what it
  // is made of rather than being asked to trust a number out of 100.
  const scoreExplanation = signal ? explainScore(signal) : null;

  return {
    hs_code: hs,
    name: shortProductName(full),
    name_full: full,
    sector: hs2Sector(hs),
    chapter,
    chapter_label: hs2Label(chapter),
    category: classify(hs, globalClassifications, new Set()),

    score,
    score_from_name: signal?.name ?? null,
    growth_pct: headline?.cagr_pct ?? null,
    value_usd: headline?.value_usd ?? 0,
    year: headline?.year ?? null,
    unit_value_usd_t: unitValue,
    price_premium: premiumFrom(
      priceRatio,
      settings.pricePremiumHigh,
      settings.pricePremiumLow,
    ),
    price_ratio: priceRatio,
    world_median_usd_t: worldMedian,
    price_from_name: priced?.name ?? null,

    focus_slug: focus?.slug ?? null,
    focus_name: focus?.name ?? null,
    focus_flow: headline?.flow ?? 'export',

    sellers,
    buyers,
    target_markets: targetMarkets,
    related: (relatedRows ?? []).map((r) => ({
      hs_code: r.hs_code,
      name: shortProductName(r.product_name ?? hs6Label(r.hs_code)),
      value_usd: r.value_usd,
    })),

    subscribers,
    subscriber_count: subscribers.length,

    partner_detail_available: Boolean(partnerDetail),
    // The rows themselves, so the modal can show who actually ships to whom
    // rather than each country's unrelated world totals.
    partner_flows: partnerDetail,
    score_breakdown: scoreExplanation,
    totals: {
      export_usd: all.filter((r) => r.flow === 'export').reduce((s, r) => s + r.value_usd, 0),
      import_usd: all.filter((r) => r.flow === 'import').reduce((s, r) => s + r.value_usd, 0),
      reporting_countries: new Set(all.map((r) => r.slug)).size,
      countries_with_data: covered?.n ?? 0,
    },
  };
}

/**
 * A LIKE pattern safe to build from a source-supplied product description.
 *
 * Three problems with using the name directly. A description carrying a
 * percent sign becomes a wildcard and matches every card in the table. D1
 * refuses any pattern over fifty characters with "LIKE or GLOB pattern too
 * complex", which is far shorter than SQLite's own default and took out
 * roughly half the product modal until it was measured. And a forty character
 * phrase would not match a real card anyway: nobody writes "plastics;
 * household articles and hygienic or toilet articles" in a headline.
 *
 * So this takes the leading words, which is both what a person would search
 * for and comfortably inside the limit. Null when nothing useful is left, and
 * the caller then matches on the HS code alone rather than on a fragment.
 */
const LIKE_MAX = 40;

function likeTerm(productName: string): string | null {
  const head = shortProductName(productName).split(/[,;]/)[0].trim().toLowerCase();
  // Strip the LIKE metacharacters rather than escaping them: these are search
  // words, and a product name has no business carrying a wildcard.
  const words = head.replace(/[%_\\]/g, ' ').split(/\s+/).filter(Boolean);

  let term = '';
  for (const w of words.slice(0, 3)) {
    const next = term ? `${term} ${w}` : w;
    if (next.length > LIKE_MAX) break;
    term = next;
  }

  return term.length >= 3 ? `%${term}%` : null;
}

/**
 * Published cards that follow this product, so somebody looking at it can see
 * who else is. Matched on the exact HS code a card lists, on a subscription to
 * the code, and on the product name appearing in the card's own text.
 *
 * Only published cards, and no contact details: this says who to approach, and
 * the card page says how.
 */
async function loadSubscribers(
  env: Env,
  hs: string,
  productName: string,
): Promise<ProductSubscriber[]> {
  const term = likeTerm(productName);

  const { results } = await env.DB.prepare(
    `SELECT DISTINCT b.id AS card_id, b.display_name, b.company, b.headline,
            b.country_iso3, b.intents, b.rating_avg, b.rating_count
       FROM business_cards b
       LEFT JOIN subscriptions s
              ON s.user_id = b.user_id AND s.kind = 'hs_code' AND s.value = ?
      WHERE b.is_published = 1
        AND (s.id IS NOT NULL
             OR b.hs_codes LIKE ?
             OR (?4 IS NOT NULL AND lower(b.headline) LIKE ?4)
             OR (?4 IS NOT NULL AND lower(b.bio) LIKE ?4))
      ORDER BY b.rating_count DESC, b.rating_avg DESC
      LIMIT 20`,
  )
    .bind(hs, `%${hs}%`, term, term)
    .all<{
      card_id: string;
      display_name: string;
      company: string | null;
      headline: string | null;
      country_iso3: string | null;
      intents: string | null;
      rating_avg: number | null;
      rating_count: number | null;
    }>();

  return (results ?? []).map((r) => ({
    card_id: r.card_id,
    display_name: r.display_name,
    company: r.company,
    headline: r.headline,
    country_iso3: r.country_iso3,
    intents: safeJson(r.intents),
    rating_avg: r.rating_avg,
    rating_count: r.rating_count ?? 0,
  }));
}

function safeJson(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}
