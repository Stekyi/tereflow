/**
 * Who a country actually trades a product with.
 *
 * The product modal has always shown each country's own world totals under
 * "sold by" and "bought by", with a caption admitting that country-to-country
 * flows were not available. On the Comtrade tier they genuinely were not: the
 * keyless API cannot fetch partner and product together.
 *
 * Ghana StatBank does give both. Every observation carries a partner, so for a
 * country ingested from its own statistics office we can answer the question
 * the modal was previously apologising for. This reads those rows.
 *
 * It is deliberately separate from the world-totals view rather than replacing
 * it. They answer different questions, and a reader who sees "United States
 * 27%" needs to know whether that means the US buys 27% of Ghana's imports of
 * this thing or that the US is 27% of world trade in it. Conflating those is
 * how a number becomes a lie without anybody editing it.
 */
import type { Env } from './db';

export interface PartnerFlow {
  partner: string;
  iso3: string | null;
  value_usd: number;
  share_pct: number;
  net_weight_kg: number | null;
  unit_value_usd_per_kg: number | null;
}

export interface PartnerBreakdown {
  /** The country whose trade this describes. */
  country_code: string;
  country_name: string;
  product_code: string;
  classification_level: string;
  trade_flow: 'import' | 'export';
  year: number;
  partners: PartnerFlow[];
  total_usd: number;
  partner_count: number;
  /** Where this came from, so the reader can weigh it. */
  source: string;
  /**
   * True when the product code asked for was narrower than the data. A reader
   * looking at HS 870323 gets chapter 87 partners, and being told that is the
   * difference between a useful approximation and a wrong number.
   */
  is_chapter_level: boolean;
  requested_code: string;
}

/**
 * Partner flows for one product, or null when the country has none stored.
 *
 * Null rather than an empty list on purpose: "no partner data for this country"
 * and "this country trades with nobody" are different statements, and the
 * caller needs to be able to tell them apart.
 */
export async function loadPartnerBreakdown(
  env: Env,
  input: {
    countryCode: string;
    countryName: string;
    hs: string;
    flow: 'import' | 'export';
  },
): Promise<PartnerBreakdown | null> {
  const { countryCode, countryName, hs, flow } = input;

  // Fall back to the chapter when the exact code is not stored. StatBank is
  // HS2, so a reader arriving from an HS6 line still gets the right chapter,
  // and the response says that is what happened.
  const chapter = hs.slice(0, 2);

  const exact = await queryPartners(env, countryCode, hs, flow);
  if (exact && exact.partners.length) {
    return { ...exact, country_name: countryName, is_chapter_level: false, requested_code: hs };
  }

  if (chapter !== hs) {
    const byChapter = await queryPartners(env, countryCode, chapter, flow);
    if (byChapter && byChapter.partners.length) {
      return { ...byChapter, country_name: countryName, is_chapter_level: true, requested_code: hs };
    }
  }

  return null;
}

async function queryPartners(
  env: Env,
  countryCode: string,
  productCode: string,
  flow: 'import' | 'export',
): Promise<Omit<PartnerBreakdown, 'country_name' | 'is_chapter_level' | 'requested_code'> | null> {
  // The latest year this country has for this product. Asking for "the latest
  // year" globally would mix a country whose data stops in 2024 with one that
  // reaches 2025 and call the difference a collapse in trade.
  const latest = await env.DB.prepare(
    `SELECT MAX(year) AS y, classification_level AS lvl, source
       FROM trade_observations
      WHERE country_code = ? AND product_code = ? AND trade_flow = ? AND month = 0`,
  )
    .bind(countryCode, productCode, flow)
    .first<{ y: number | null; lvl: string | null; source: string | null }>();

  if (!latest?.y) return null;

  const { results } = await env.DB.prepare(
    `SELECT partner_country, partner_iso3,
            SUM(import_value_usd) AS value_usd,
            SUM(net_weight_kg)    AS weight_kg
       FROM trade_observations
      WHERE country_code = ? AND product_code = ? AND trade_flow = ?
        AND month = 0 AND year = ?
      GROUP BY partner_country, partner_iso3
      HAVING value_usd > 0
      ORDER BY value_usd DESC`,
  )
    .bind(countryCode, productCode, flow, latest.y)
    .all<{ partner_country: string; partner_iso3: string | null; value_usd: number; weight_kg: number | null }>();

  const rows = results ?? [];
  if (!rows.length) return null;

  const total = rows.reduce((s, r) => s + r.value_usd, 0);

  return {
    country_code: countryCode,
    product_code: productCode,
    classification_level: latest.lvl ?? 'HS2',
    trade_flow: flow,
    year: latest.y,
    total_usd: total,
    partner_count: rows.length,
    source: latest.source ?? 'unknown',
    partners: rows.map((r) => ({
      partner: r.partner_country,
      iso3: r.partner_iso3,
      value_usd: r.value_usd,
      share_pct: total > 0 ? (r.value_usd / total) * 100 : 0,
      net_weight_kg: r.weight_kg && r.weight_kg > 0 ? r.weight_kg : null,
      // Null, never zero. A unit value of zero is a claim the goods were free,
      // and 55 percent of StatBank rows carry no weight at all.
      unit_value_usd_per_kg:
        r.weight_kg && r.weight_kg > 0 ? r.value_usd / r.weight_kg : null,
    })),
  };
}
