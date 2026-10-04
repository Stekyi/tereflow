import type { Env } from './db';
import { oracleJson, type OracleConfig } from './oracle';
import {
  CONFIDENCE_WEIGHT,
  feedEntities,
  oracleDashboard,
  oracleProducts,
  partnerLabel,
  type DashboardPayload,
  type FeedEntity,
  type FeedItem,
  type ProductsFeed,
} from './oracle-feeds';
import { hs2Label, hs2Sector, hs6Label } from '../agent/codes';
import { shortProductName } from '../../shared/product-name';
import { explainScore, opportunityScore } from '../../shared/opportunity';
import { classify, loadClassifications } from './classify';
import { loadSettings, type Settings } from './settings';
import { loadSubscribers } from './product-insight';
import type { PartnerBreakdown } from './partner-flows';
import type {
  ExportCategory,
  MarketCountryRank,
  MarketProducts,
  PricePremium,
  ProductCountry,
  ProductCountryRow,
  ProductDetail,
  ProductInsight,
  ProductSubscriber,
} from '../../shared/types';

/**
 * Product views (the modal, the product page, the market view) built from the Oracle feeds.
 *
 * The functions that decide anything are pure: they take the feeds and settings already fetched, so a
 * test can run them on synthetic data. The `*Oracle` wrappers fetch and call them.
 */

export interface CountryData {
  e: FeedEntity;
  feed: ProductsFeed;
  dash: DashboardPayload | null;
}

/** What Oracle's per-product endpoint returns: a yearly series and the latest year's partners. */
export interface ProductDetailPayload {
  reporter: string;
  flow: 'X' | 'M';
  code: string;
  name: string | null;
  level: string | null;
  latest_year: number;
  series: Array<{ year: number; value_usd: number; qty_kg: number | null }>;
  partners: Array<{ iso3: string; value_usd: number; qty_kg: number | null }>;
}

/** One country's trade in one product and direction: the shared shape every builder works from. */
export interface CodeRow {
  e: FeedEntity;
  flow: 'export' | 'import';
  year: number;
  value_usd: number;
  cagr_pct: number | null;
  unit_value_usd_t: number | null;
  /** Fraction (0 to 1) of the country's trade in this direction. */
  share: number | null;
  score: number;
  confidence: FeedItem['confidence'];
  best_market: string | null;
  name: string | null;
  price_ratio: number | null;
}

const flowOf = (f: 'X' | 'M'): 'export' | 'import' => (f === 'X' ? 'export' : 'import');

export function premiumFrom(ratio: number | null, high: number, low: number): PricePremium {
  if (ratio == null || !Number.isFinite(ratio)) return 'unknown';
  if (ratio >= high) return 'high';
  if (ratio <= low) return 'low';
  return 'typical';
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 ? s[(s.length - 1) / 2] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
}

/**
 * Every country's latest-year trade in a product, one row per country and direction.
 *
 * A code matches itself and every longer code beneath it, so a chapter or a 6-digit heading also
 * covers the HS8/HS10 lines of a country that reports at that depth. When more than one line
 * contributes, growth and unit value are left empty: they are not defined for a sum of different lines.
 */
export function rowsForCode(data: CountryData[], hs: string, settings: Pick<Settings, 'pricingMinValueUsd'>): CodeRow[] {
  const rows: CodeRow[] = [];
  for (const { e, feed, dash } of data) {
    for (const flow of ['X', 'M'] as const) {
      const items = feed.products.filter((i) => i.flow === flow && i.year === feed.latest_year && i.code.startsWith(hs));
      if (!items.length) continue;
      const value = items.reduce((s, i) => s + i.value_usd, 0);
      const best = items.reduce((a, b) => (b.score > a.score ? b : a));
      const biggest = items.reduce((a, b) => (b.value_usd > a.value_usd ? b : a));
      const single = items.length === 1 ? items[0] : null;
      const total = dash ? (flow === 'X' ? dash.overview.export_usd : dash.overview.import_usd) : 0;
      rows.push({
        e,
        flow: flowOf(flow),
        year: feed.latest_year,
        value_usd: value,
        cagr_pct: single?.cagr_3y ?? null,
        unit_value_usd_t: single?.unit_value_usd_t ?? null,
        share: total > 0 ? value / total : null,
        score: best.score,
        confidence: best.confidence,
        best_market: partnerLabel(biggest.top_partner),
        name: biggest.name,
        price_ratio: null,
      });
    }
  }
  // Price against the world median, over countries that traded enough for a price to mean something.
  const med = median(
    rows.filter((r) => r.value_usd >= settings.pricingMinValueUsd).map((r) => r.unit_value_usd_t).filter((v): v is number => v != null && v > 0),
  );
  if (med) for (const r of rows) r.price_ratio = r.unit_value_usd_t != null && r.unit_value_usd_t > 0 ? r.unit_value_usd_t / med : null;
  return rows;
}

function toRow(r: CodeRow, rank: number, s: Pick<Settings, 'pricePremiumHigh' | 'pricePremiumLow'>): ProductCountryRow {
  return {
    rank,
    slug: r.e.slug,
    name: r.e.name,
    iso3: r.e.iso3,
    continent: r.e.continent,
    year: r.year,
    value_usd: r.value_usd,
    qty_kg: null,
    unit_value_usd_t: r.unit_value_usd_t,
    cagr_pct: r.cagr_pct,
    share: r.share,
    price_ratio: r.price_ratio,
    price_premium: premiumFrom(r.price_ratio, s.pricePremiumHigh, s.pricePremiumLow),
  };
}

/** Other products in the same chapter, by 6-digit heading, largest exports first. */
export function relatedFor(data: CountryData[], hs: string, limit = 6): Array<{ hs_code: string; name: string; value_usd: number }> {
  if (hs.length < 6) return [];
  const chapter = hs.slice(0, 2);
  const byCode = new Map<string, { value: number; name: string | null; top: number }>();
  for (const { feed } of data) {
    for (const i of feed.products) {
      if (i.flow !== 'X' || i.year !== feed.latest_year || !i.code.startsWith(chapter)) continue;
      const code6 = i.code.slice(0, 6);
      if (code6 === hs.slice(0, 6)) continue;
      const cur = byCode.get(code6) ?? { value: 0, name: null, top: 0 };
      cur.value += i.value_usd;
      if (i.value_usd >= cur.top) {
        cur.top = i.value_usd;
        cur.name = i.name;
      }
      byCode.set(code6, cur);
    }
  }
  return [...byCode.entries()]
    .sort((a, b) => b[1].value - a[1].value)
    .slice(0, limit)
    .map(([code, v]) => ({ hs_code: code, name: shortProductName(hs6Label(code, v.name)), value_usd: v.value }));
}

/** The best-supported item for a country, direction and code: the basis of the opportunity score. */
function signalFor(data: CountryData[], hs: string, slug: string | null, flow: 'export' | 'import' | null) {
  let pick: { item: FeedItem; country: string } | null = null;
  for (const { e, feed } of data) {
    if (slug && e.slug !== slug) continue;
    for (const i of feed.products) {
      if (i.year !== feed.latest_year || !i.code.startsWith(hs)) continue;
      if (flow && flowOf(i.flow) !== flow) continue;
      if (!pick || i.score > pick.item.score) pick = { item: i, country: e.name };
    }
  }
  if (!pick) return null;
  return {
    cagr_3y: pick.item.cagr_3y,
    momentum: pick.item.score / 100,
    confidence: CONFIDENCE_WEIGHT[pick.item.confidence],
    value_usd: pick.item.value_usd,
    name: pick.country,
  };
}

export function timeSeriesFrom(p: ProductDetailPayload | null): ProductInsight['time_series'] {
  if (!p) return [];
  return p.series.map((r, i) => {
    const qty = r.qty_kg && r.qty_kg > 0 ? r.qty_kg : null;
    const prev = i > 0 ? p.series[i - 1].value_usd : null;
    return {
      year: r.year,
      value_usd: r.value_usd,
      qty_kg: qty,
      unit_value_usd_t: qty ? r.value_usd / (qty / 1000) : null,
      yoy_pct: prev && prev > 0 ? ((r.value_usd - prev) / prev) * 100 : null,
    };
  });
}

export function partnerBreakdownFrom(p: ProductDetailPayload | null, countryName: string, hs: string): PartnerBreakdown | null {
  if (!p || !p.partners.length) return null;
  const total = p.partners.reduce((s, r) => s + r.value_usd, 0);
  return {
    country_code: p.reporter,
    country_name: countryName,
    product_code: hs,
    classification_level: p.level ?? (hs.length === 2 ? 'HS2' : 'HS6'),
    trade_flow: flowOf(p.flow),
    year: p.latest_year,
    total_usd: total,
    partner_count: p.partners.length,
    source: 'UN Comtrade',
    is_chapter_level: hs.length === 2,
    requested_code: hs,
    partners: p.partners.map((r) => ({
      partner: partnerLabel(r.iso3) ?? r.iso3,
      iso3: r.iso3,
      value_usd: r.value_usd,
      share_pct: total > 0 ? (r.value_usd / total) * 100 : 0,
      net_weight_kg: r.qty_kg && r.qty_kg > 0 ? r.qty_kg : null,
      unit_value_usd_per_kg: r.qty_kg && r.qty_kg > 0 ? r.value_usd / r.qty_kg : null,
    })),
  };
}

export interface InsightInput {
  hs: string;
  focusSlug: string | null;
  focusFlow: 'export' | 'import' | null;
  data: CountryData[];
  settings: Settings;
  series: ProductDetailPayload | null;
  subscribers: ProductSubscriber[];
  category: ExportCategory;
  /** Name from Comtrade if any country reported one; the curated label is used first. */
  fullName: string;
}

export function buildInsight(i: InsightInput): ProductInsight {
  const { hs, settings, data } = i;
  const chapter = hs.slice(0, 2);
  const all = rowsForCode(data, hs, settings);
  const sellersRaw = all.filter((r) => r.flow === 'export').sort((a, b) => b.value_usd - a.value_usd).slice(0, settings.marketTopN);
  const buyersRaw = all.filter((r) => r.flow === 'import').sort((a, b) => b.value_usd - a.value_usd).slice(0, settings.marketTopN);
  const sellers = sellersRaw.map((r, n) => toRow(r, n + 1, settings));
  const buyers = buyersRaw.map((r, n) => toRow(r, n + 1, settings));

  const prices = all.filter((r) => r.value_usd >= settings.pricingMinValueUsd).map((r) => r.unit_value_usd_t).filter((v): v is number => v != null && v > 0);
  const worldMedian = median(prices);

  const focus = i.focusSlug
    ? all.find((r) => r.e.slug === i.focusSlug && r.flow === (i.focusFlow ?? 'export')) ?? all.find((r) => r.e.slug === i.focusSlug) ?? null
    : null;
  const headline = focus ?? sellersRaw[0] ?? all[0] ?? null;

  // Quote a price from the next seller when the headline country reported no weight, and say whose it is.
  const priced = headline?.unit_value_usd_t != null
    ? null
    : all.find((r) => r.flow === 'export' && r.unit_value_usd_t != null && r.value_usd >= settings.pricingMinValueUsd) ?? null;
  const unitValue = headline?.unit_value_usd_t ?? priced?.unit_value_usd_t ?? null;
  const priceRatio = headline?.unit_value_usd_t != null ? headline.price_ratio : priced?.price_ratio ?? null;

  const targetMarkets = all
    .filter((r) => r.flow === 'import' && r.cagr_pct != null)
    .sort((a, b) => (b.cagr_pct ?? 0) - (a.cagr_pct ?? 0))
    .slice(0, 8)
    .map((r) => ({ slug: r.e.slug, name: r.e.name, iso3: r.e.iso3, value_usd: r.value_usd, cagr_pct: r.cagr_pct }));

  const signal = signalFor(data, hs, focus ? focus.e.slug : null, focus ? focus.flow : null);
  const partnerFlows = partnerBreakdownFrom(i.series, focus?.e.name ?? '', hs);

  return {
    hs_code: hs,
    name: shortProductName(i.fullName),
    name_full: i.fullName,
    sector: hs2Sector(hs),
    chapter,
    chapter_label: hs2Label(chapter),
    category: i.category,

    score: signal ? opportunityScore(signal) : null,
    score_from_name: signal?.name ?? null,
    growth_pct: headline && headline.value_usd >= settings.noiseFloorHs6Usd ? headline.cagr_pct ?? null : null,
    value_usd: headline?.value_usd ?? 0,
    year: headline?.year ?? null,
    unit_value_usd_t: unitValue,
    price_premium: premiumFrom(priceRatio, settings.pricePremiumHigh, settings.pricePremiumLow),
    price_ratio: priceRatio,
    world_median_usd_t: worldMedian,
    price_from_name: priced?.e.name ?? null,

    focus_slug: focus?.e.slug ?? null,
    focus_name: focus?.e.name ?? null,
    focus_flow: headline?.flow ?? 'export',

    sellers,
    buyers,
    time_series: focus ? timeSeriesFrom(i.series) : [],
    target_markets: targetMarkets,
    related: relatedFor(data, hs),

    subscribers: i.subscribers,
    subscriber_count: i.subscribers.length,

    partner_detail_available: Boolean(partnerFlows),
    partner_flows: focus ? partnerFlows : null,
    score_breakdown: signal ? explainScore(signal) : null,
    totals: {
      export_usd: all.filter((r) => r.flow === 'export').reduce((s, r) => s + r.value_usd, 0),
      import_usd: all.filter((r) => r.flow === 'import').reduce((s, r) => s + r.value_usd, 0),
      reporting_countries: new Set(all.map((r) => r.e.slug)).size,
      countries_with_data: data.length,
    },
  };
}

export function buildProductDetail(args: {
  hs: string;
  data: CountryData[];
  settings: Pick<Settings, 'pricingMinValueUsd'>;
  topN: number;
  category: ExportCategory;
  fullName: string;
  partners: ProductDetail['partners'];
}): ProductDetail {
  const all = rowsForCode(args.data, args.hs, args.settings);
  const side = (flow: 'export' | 'import'): ProductCountry[] =>
    all
      .filter((r) => r.flow === flow)
      .sort((a, b) => b.value_usd - a.value_usd)
      .slice(0, args.topN)
      .map((r, n) => ({
        rank: n + 1,
        slug: r.e.slug,
        name: r.e.name,
        iso3: r.e.iso3,
        continent: r.e.continent ?? '',
        year: r.year,
        value_usd: r.value_usd,
        growth_pct: r.cagr_pct,
        best_market: r.best_market,
      }));
  const exporters = side('export');
  const importers = side('import');
  const chapter = args.hs.slice(0, 2);
  return {
    hs_code: args.hs,
    name: shortProductName(args.fullName),
    name_full: args.fullName,
    sector: hs2Sector(args.hs),
    chapter,
    chapter_label: hs2Label(chapter),
    category: args.category,
    total_export_usd: exporters.reduce((s, r) => s + r.value_usd, 0),
    total_import_usd: importers.reduce((s, r) => s + r.value_usd, 0),
    exporters,
    importers,
    partners: args.partners,
    related: relatedFor(args.data, args.hs),
    partial_coverage: [...exporters, ...importers].some((r) => r.growth_pct == null),
  };
}

export function buildMarketProducts(args: {
  hs: string;
  data: CountryData[];
  settings: Pick<Settings, 'pricingMinValueUsd'>;
  topN: number;
  category: ExportCategory;
  label: string;
}): MarketProducts {
  const all = rowsForCode(args.data, args.hs, args.settings);
  const rank = (flow: 'export' | 'import'): MarketCountryRank[] =>
    all
      .filter((r) => r.flow === flow)
      .sort((a, b) => b.value_usd - a.value_usd)
      .slice(0, args.topN)
      .map((r, n) => ({
        rank: n + 1,
        slug: r.e.slug,
        name: r.e.name,
        iso3: r.e.iso3,
        continent: r.e.continent ?? '',
        year: r.year,
        value_usd: r.value_usd,
      }));
  const exporters = rank('export');
  const importers = rank('import');
  const partners: MarketProducts['partners_by_slug'] = {};
  for (const slug of new Set([...exporters, ...importers].map((r) => r.slug))) {
    const dash = args.data.find((d) => d.e.slug === slug)?.dash;
    partners[slug] = { export: dash?.partners_export ?? [], import: dash?.partners_import ?? [] };
  }
  return {
    hs_code: args.hs,
    label: args.label,
    sector: hs2Sector(args.hs),
    category: args.category,
    exporters,
    importers,
    partners_by_slug: partners,
  };
}

/** Distinct 6-digit products across every country with data, for the search typeahead. */
export function catalogueFrom(data: CountryData[]): Array<{ hs_code: string; product_name: string | null; total_value: number }> {
  const byCode = new Map<string, { total: number; name: string | null; top: number }>();
  for (const { feed } of data) {
    for (const i of feed.products) {
      if (i.year !== feed.latest_year) continue;
      const code6 = i.code.slice(0, 6);
      const cur = byCode.get(code6) ?? { total: 0, name: null, top: 0 };
      cur.total += i.value_usd;
      if (i.value_usd >= cur.top && i.code.length === 6) {
        cur.top = i.value_usd;
        cur.name = i.name;
      }
      byCode.set(code6, cur);
    }
  }
  return [...byCode.entries()].map(([hs_code, v]) => ({ hs_code, product_name: v.name, total_value: v.total }));
}

// --- fetching -----------------------------------------------------------------------------------

/** Every active country that Oracle holds data for, with its product feed and dashboard. */
export async function loadCountryData(env: Pick<Env, 'DB'>, cfg: OracleConfig): Promise<CountryData[]> {
  const entities = await feedEntities(env.DB);
  const loaded = await Promise.all(
    entities.map(async (e) => {
      const [feed, dash] = await Promise.all([oracleProducts(cfg, e.iso3), oracleDashboard(cfg, e.iso3)]);
      return feed ? { e, feed, dash } : null;
    }),
  );
  return loaded.filter((x): x is CountryData => x != null);
}

export const oracleProductDetail = (cfg: OracleConfig, iso3: string, flow: 'X' | 'M', code: string) =>
  oracleJson<ProductDetailPayload>(cfg, { route: 'product', iso3, flow, code });

export async function buildProductInsightOracle(
  env: Env,
  cfg: OracleConfig,
  hs: string,
  focusSlug: string | null,
  focusFlow: 'export' | 'import' | null,
): Promise<ProductInsight> {
  const [settings, data, global] = await Promise.all([loadSettings(env), loadCountryData(env, cfg), loadClassifications(env.DB, '*')]);
  const rows = rowsForCode(data, hs, settings);
  const focus = focusSlug
    ? rows.find((r) => r.e.slug === focusSlug && r.flow === (focusFlow ?? 'export')) ?? rows.find((r) => r.e.slug === focusSlug) ?? null
    : null;
  const series = focus ? await oracleProductDetail(cfg, focus.e.iso3, focus.flow === 'export' ? 'X' : 'M', hs).catch(() => null) : null;
  const named = rows.find((r) => r.name)?.name ?? null;
  const fullName = hs.length === 6 ? hs6Label(hs, named) : hs2Label(hs);
  const subscribers = await loadSubscribers(env, hs, fullName);
  return buildInsight({
    hs,
    focusSlug,
    focusFlow,
    data,
    settings,
    series,
    subscribers,
    category: classify(hs, global, new Set()),
    fullName,
  });
}
