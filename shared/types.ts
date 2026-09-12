import type { ScoreBand } from './opportunity';
export type EntityKind = 'country' | 'intl_org' | 'regional_body';
export type SourceCategory = 'export' | 'import' | 'commerce';
export type SourceFmt = 'html' | 'csv' | 'json' | 'api' | 'sdmx' | 'xlsx' | 'pdf';
export type SourceEndpointType =
  | 'file'
  | 'rest'
  | 'json_stat'
  | 'sdmx'
  | 'pxweb'
  | 'odata'
  | 'html_download';
export type SourceParserKey =
  | 'auto'
  | 'csv'
  | 'json'
  | 'json-stat'
  | 'sdmx'
  | 'xlsx'
  | 'pdf'
  | 'html';
export type Flow = 'export' | 'import';
export type Stream = 'goods' | 'services';

export const ENTITY_KINDS: EntityKind[] = ['country', 'intl_org', 'regional_body'];
export const SOURCE_CATEGORIES: SourceCategory[] = ['export', 'import', 'commerce'];
export const SOURCE_FMTS: SourceFmt[] = ['html', 'csv', 'json', 'api', 'sdmx', 'xlsx', 'pdf'];
export const SOURCE_ENDPOINT_TYPES: SourceEndpointType[] = [
  'file',
  'rest',
  'json_stat',
  'sdmx',
  'pxweb',
  'odata',
  'html_download',
];
export const SOURCE_PARSERS: SourceParserKey[] = [
  'auto',
  'csv',
  'json',
  'json-stat',
  'sdmx',
  'xlsx',
  'pdf',
  'html',
];
export const CONTINENTS = [
  'Africa',
  'Asia',
  'Europe',
  'North America',
  'South America',
  'Oceania',
  'Global',
] as const;

export const KIND_LABEL: Record<EntityKind, string> = {
  country: 'Country',
  intl_org: 'International organisation',
  regional_body: 'Regional body',
};

export const CATEGORY_LABEL: Record<SourceCategory, string> = {
  export: 'Export data',
  import: 'Import data',
  commerce: 'Commerce flow (goods & services in country)',
};

export interface EntitySource {
  id: string;
  entity_id: string;
  category: SourceCategory;
  slot: 1 | 2 | 3;
  url: string;
  label: string | null;
  fmt: SourceFmt;
  endpoint_type: SourceEndpointType;
  parser_key: SourceParserKey;
  config_json: string;
  last_status: number | null;
  last_checked_at: string | null;
  tls_warning: 0 | 1;
}

export interface Entity {
  id: string;
  slug: string;
  name: string;
  kind: EntityKind;
  continent: string | null;
  iso3: string | null;
  iso2: string | null;
  agency_name: string | null;
  homepage: string | null;
  api_notes: string | null;
  is_active: 0 | 1;
  coverage_score: number;
  last_ingest_at: string | null;
  last_error: string | null;
  created_at: string;
  updated_at: string;
}

export interface EntityWithSources extends Entity {
  sources: Record<SourceCategory, EntitySource[]>;
}

/** Shape the admin form posts. */
export interface EntityInput {
  slug?: string;
  name: string;
  kind: EntityKind;
  continent?: string | null;
  iso3?: string | null;
  iso2?: string | null;
  agency_name?: string | null;
  homepage?: string | null;
  api_notes?: string | null;
  is_active?: boolean;
  sources: {
    category: SourceCategory;
    slot: 1 | 2 | 3;
    url: string;
    label?: string | null;
    fmt?: SourceFmt;
    endpoint_type?: SourceEndpointType;
    parser_key?: SourceParserKey;
    config_json?: string;
  }[];
}

// --- dashboard payloads -----------------------------------------------------

export interface Overview {
  year: number;
  export_usd: number;
  import_usd: number;
  balance_usd: number;
  total_trade_usd: number;
  export_yoy_pct: number | null;
  import_yoy_pct: number | null;
  /** 0..1 Herfindahl over export products. High = dangerously concentrated. */
  export_concentration: number | null;
  /** HS chapter (2-digit) -> share of exports (0..1), full distribution. */
  export_chapter_shares: Record<string, number>;
  partner_count: number;
  product_count: number;
  services_export_usd: number | null;
  services_import_usd: number | null;
  data_sources: string[];
  coverage_note: string | null;
}

export interface RankedItem {
  rank: number;
  code: string | null;
  name: string;
  value_usd: number;
  share_pct: number;
  cagr_3y: number | null;
  yoy_pct: number | null;
  /** Only set for product rows (partner rows have no export category). */
  category?: ExportCategory;
}

// --- traditional vs non-traditional export classification -------------------

/**
 * Traditional = capital-intensive, licensed, state- or oligopoly-controlled
 * (oil, mining, precious metals, and -- per country -- a dominant legacy
 * commodity like Ghanaian cocoa). Non-traditional = the rest: processed and
 * horticultural goods an SME can actually produce and ship. Same distinction
 * real export-promotion agencies (Ghana's GEPA and its regional equivalents)
 * already use.
 */
export type ExportCategory = 'traditional' | 'non_traditional';

export const EXPORT_CATEGORY_LABEL: Record<ExportCategory, string> = {
  traditional: 'Traditional export',
  non_traditional: 'Non-traditional export',
};

export const EXPORT_CATEGORY_HINT: Record<ExportCategory, string> = {
  traditional: 'Typically large-scale, licensed, or state-controlled production.',
  non_traditional: 'Typically accessible to a small or growing exporter.',
};

export interface ExportClassification {
  id: string;
  entity_id: string;
  hs_code: string;
  category: ExportCategory;
  note: string | null;
  source_url: string | null;
  source_label: string | null;
  created_at: string;
  updated_at: string;
}

/** One resolved row for the admin curation screen: what applies today, and why. */
export interface ResolvedClassification {
  hs_code: string;
  label: string;
  category: ExportCategory;
  source: 'default' | 'heuristic' | 'override';
  override: ExportClassification | null;
}

export interface ProductBreakdownRow {
  partner_iso3: string | null;
  partner_name: string;
  value_usd: number;
  qty: number | null;
  qty_unit: string | null;
}

export interface ProductBreakdown {
  product_name: string;
  hs_code: string;
  flow: Flow;
  year: number;
  product_value_usd: number;
  product_qty: number | null;
  product_qty_unit: string | null;
  detail_available: boolean;
  note: string;
  rows: ProductBreakdownRow[];
}

export interface TrendPoint {
  year: number;
  export_usd: number;
  import_usd: number;
  balance_usd: number;
}

export interface OpportunitySignal {
  id: string;
  hs_code: string | null;
  product_name: string;
  flow: Flow;
  cagr_3y: number | null;
  momentum: number;
  current_rank: number | null;
  projected_rank: number | null;
  horizon_years: number;
  confidence: number | null;
  rationale: string | null;
}

export interface ExploreOpportunity {
  id: string;
  kind: 'product' | 'service';
  slug: string;
  country: string;
  iso3: string;
  continent: string;
  name: string;
  flow: Flow;
  year: number;
  value_usd: number;
  growth_pct: number | null;
  rank: number | null;
  momentum: number | null;
  rationale: string;
  partners: ExplorePartner[];
  /** Absent for services (no HS code to classify). */
  category?: ExportCategory;
}

export interface ExplorePartner {
  iso3: string | null;
  name: string;
  value_usd: number;
  detail_available: boolean;
}

// --- marketplace (cross-country product ranking) ---------------------------

export interface MarketCountryRank {
  rank: number;
  slug: string;
  name: string;
  iso3: string;
  continent: string;
  year: number;
  value_usd: number;
}

export interface MarketProducts {
  hs_code: string;
  label: string;
  sector: string;
  category: ExportCategory;
  exporters: MarketCountryRank[];
  importers: MarketCountryRank[];
  /** Each country's general trading partners — not specific to this product. */
  partners_by_slug: Record<string, { export: RankedItem[]; import: RankedItem[] }>;
}

export interface MarketHsCode {
  code: string;
  label: string;
  sector: string;
  category: ExportCategory;
}

// --- product-first browsing -------------------------------------------------

/**
 * One specific tradeable product line in one country, as shown on the home
 * page and in the marketplace. This is the unit an SME actually decides about:
 * "guavas, mangoes and mangosteens out of Ghana", not "Fruit & nuts".
 */
/** The figures shown above a filtered product list, on the same filters. */
export interface ProductSummary {
  total: number;
  exports: number;
  imports: number;
  /** Openings scoring at or above the strong band. */
  strong: number;
  /** Distinct countries represented in the list. */
  markets: number;
  largest_usd: number;
  /**
   * Openings a stated budget clears. Null when no budget was given, which is
   * not the same as none of them clearing it.
   */
  within_budget: number | null;
  /** How many carry a price at all, so a low within_budget is readable. */
  priced: number;
}

export interface ProductCard {
  /** Stable across country and flow, so the modal can key on it. */
  hs_code: string;
  /** Shortened for display. */
  name: string;
  /** The source's full description. Shown in detail so the short form is never
   *  the only thing the reader is given. */
  name_full: string;
  sector: string;
  category: ExportCategory;
  flow: Flow;
  country: string;
  slug: string;
  iso3: string;
  continent: string;
  year: number;
  value_usd: number;
  /** Compound annual growth, percent. Null when the source's product detail
   *  was capped and the years are not comparable. */
  growth_pct: number | null;
  /** 0-100, computed at read time. See shared/opportunity.ts. */
  score: number;
  /** Largest counterpart country for this flow. */
  best_market: string | null;
  best_market_iso3: string | null;
  /**
   * False when `best_market` is the country's largest counterpart for the
   * whole flow rather than for this product. The sources currently ingested
   * report partners per flow, not per product, so this is usually false and
   * the UI must not present it as a per-product finding.
   */
  best_market_product_specific: boolean;
  /**
   * Dollars per tonne for this country and flow, where a weight was reported.
   * Null is common and means no weight, never a price of zero.
   */
  unit_value_usd_t: number | null;
  /**
   * Which band the score falls in, decided on the server against the stored
   * cut-offs. Sent rather than recomputed so a badge can never disagree with
   * a count derived from the same thresholds.
   */
  band: ScoreBand;  /** True when the figures come from a completed opportunity signal rather
   *  than raw facts, so growth and momentum are available. */
  has_signal: boolean;
  /** Set when this country's product detail was capped by the source. */
  partial_coverage: boolean;
}

/** One country's position in a single product, for the product modal. */
export interface ProductCountry {
  rank: number;
  slug: string;
  name: string;
  iso3: string;
  continent: string;
  year: number;
  value_usd: number;
  growth_pct: number | null;
  /** Where this country's trade in this flow mostly goes or comes from. */
  best_market: string | null;
}

/**
 * Everything shown when a product is opened from anywhere in the app.
 * Deliberately global: the whole point of the modal is that clicking a product
 * shows the product, not the country it happened to be listed under.
 */
export interface ProductDetail {
  hs_code: string;
  name: string;
  name_full: string;
  sector: string;
  chapter: string;
  chapter_label: string;
  category: ExportCategory;
  total_export_usd: number;
  total_import_usd: number;
  exporters: ProductCountry[];
  importers: ProductCountry[];
  /** Trading partners aggregated across the countries above. Partner detail is
   *  reported per flow, not per product, on the sources currently ingested;
   *  `product_specific` says which it is. */
  partners: { name: string; iso3: string | null; value_usd: number; product_specific: boolean }[];
  /** Other specific lines in the same chapter, so a dead end still offers a
   *  next step. */
  related: { hs_code: string; name: string; value_usd: number }[];
  /** Countries reporting this product whose detail was capped by the source. */
  partial_coverage: boolean;
}

/** A country as listed on the countries index: summary only, no products. */
export interface CountrySummary {
  slug: string;
  name: string;
  iso3: string | null;
  continent: string | null;
  is_active: boolean;
  year: number | null;
  export_usd: number | null;
  import_usd: number | null;
  balance_usd: number | null;
  top_export: string | null;
  top_partner: string | null;
  /**
   * How many non-traditional openings are on record.
   *
   * Null when the question could not be asked: signal detection needs three
   * years of product detail, and a country with fewer cannot produce one
   * however good its trade is. Showing that as 0 puts it in a list beside
   * countries where the search really did run and really did find nothing.
   */
  opportunities: number | null;
  /** Why opportunities is null. Null when it is a real count. */
  opportunities_note: string | null;
  last_ingest_at: string | null;
}

// --- feedback ---------------------------------------------------------------

export type FeedbackKind = 'problem' | 'request' | 'other';

export interface FeedbackInput {
  kind: FeedbackKind;
  message: string;
  /** The route the sender was on, so nobody has to ask "which page?". */
  path?: string;
  /** Only used when the sender is not signed in. */
  contact?: string;
}

export const FEEDBACK_KIND_LABEL: Record<FeedbackKind, string> = {
  problem: 'Something is wrong',
  request: 'I want something added',
  other: 'Something else',
};

// --- product analytics ------------------------------------------------------

/** Where a country's price sits against the world median for that product. */
export type PricePremium = 'high' | 'typical' | 'low' | 'unknown';

export const PRICE_PREMIUM_LABEL: Record<PricePremium, string> = {
  high: 'Above the world median',
  typical: 'Around the world median',
  low: 'Below the world median',
  unknown: 'No price reported',
};

/** One country's position in one product, on one side of the trade. */
export interface ProductCountryRow {
  rank: number;
  slug: string;
  name: string;
  iso3: string | null;
  continent: string | null;
  year: number;
  value_usd: number;
  /** Kilograms as reported. Null where the source gave a value but no weight. */
  qty_kg: number | null;
  /** Dollars per tonne. Null rather than zero when no weight was reported. */
  unit_value_usd_t: number | null;
  /** Percent per year. Null when the years were not comparable. */
  cagr_pct: number | null;
  /** Fraction of that country's trade in this direction, 0..1. */
  share: number | null;
  /** This country's unit value over the world median. Null without a price. */
  price_ratio: number | null;
  price_premium: PricePremium;
}

/**
 * Everything the product modal shows.
 *
 * Deliberately does not carry a gross margin. Margin needs a cost basis, and
 * the sources here report traded values and weights, not costs. Unit value and
 * the premium against the world median are the honest neighbours of that idea:
 * they say what the trade actually fetches, not what it earns.
 */
export interface ProductInsight {
  hs_code: string;
  name: string;
  name_full: string;
  sector: string;
  chapter: string;
  chapter_label: string;
  category: ExportCategory;

  /**
   * 0-100, the same score used on the cards, read from the stored signal so
   * the two agree. Null when this product was never ranked for the headline
   * country, which is not the same as scoring badly.
   */
  score: number | null;
  /**
   * The country the score belongs to. Without a country in focus this is the
   * best-placed market for the product, which is rarely the largest seller,
   * so showing the number without the name would misattribute it.
   */
  score_from_name: string | null;
  /** Percent per year for the country in focus, or the largest seller. */
  growth_pct: number | null;
  value_usd: number;
  year: number | null;
  unit_value_usd_t: number | null;
  price_premium: PricePremium;
  price_ratio: number | null;
  /** Median dollars per tonne across every country reporting a weight. */
  world_median_usd_t: number | null;
  /**
   * Set when the headline country reports no weight, so its price had to come
   * from the next largest seller that does. Naming that country is the
   * difference between a quoted price and an unattributed one.
   */
  price_from_name: string | null;

  /** Set when the modal was opened scoped to one country. */
  focus_slug: string | null;
  focus_name: string | null;
  /**
   * The direction the headline figures describe. An import row's value is that
   * country's buying, and labelling it "export value" would be a plain lie.
   */
  focus_flow: 'export' | 'import';

  sellers: ProductCountryRow[];
  buyers: ProductCountryRow[];

  /**
   * Where the demand is growing. Importing countries ranked by growth rather
   * than size, which is the question somebody choosing a market is asking.
   */
  target_markets: { slug: string; name: string; iso3: string | null; value_usd: number; cagr_pct: number | null }[];

  /** Other lines in the same chapter, so a dead end still offers a next step. */
  related: { hs_code: string; name: string; value_usd: number }[];

  /** People on Tereflow who follow this product, for reaching out. */
  subscribers: ProductSubscriber[];
  subscriber_count: number;

  /**
   * True when no country reports a partner breakdown for this product, which
   * is the normal state on the keyless source tier. Says plainly that the
   * buyer and seller lists are country totals, not country-to-country flows.
   */
  partner_detail_available: boolean;
  /**
   * The four weighted terms that produced the score.
   *
   * A bare number out of 100 asks to be trusted and gives nobody a way to
   * disagree with it. Null when no score was given, which is not the same as a
   * score of zero.
   */
  score_breakdown: {
    score: number;
    components: Array<{
      label: string;
      meaning: string;
      input: string;
      normalised: number;
      weight: number;
      points: number;
      note: string | null;
    }>;
  } | null;
  /**
   * Who this country actually trades the product with, when the source gives
   * partner and product together. Null on sources that cannot, which is most
   * of them, and the difference matters: these are flows to and from one
   * country, not the world totals shown elsewhere in the same modal.
   */
  partner_flows: {
    country_code: string;
    country_name: string;
    product_code: string;
    classification_level: string;
    trade_flow: 'import' | 'export';
    year: number;
    total_usd: number;
    partner_count: number;
    source: string;
    /** True when the answer is for the chapter rather than the exact code. */
    is_chapter_level: boolean;
    requested_code: string;
    partners: Array<{
      partner: string;
      iso3: string | null;
      value_usd: number;
      share_pct: number;
      net_weight_kg: number | null;
      unit_value_usd_per_kg: number | null;
    }>;
  } | null;
  totals: {
    export_usd: number;
    import_usd: number;
    reporting_countries: number;
    /**
     * Countries carrying analysed product data at all, so the reader can see
     * that four reporters out of eleven is thin coverage of this line rather
     * than four countries being the whole world market.
     */
    countries_with_data: number;
  };
}

/** A person following a product, shown so somebody can actually reach them. */
export interface ProductSubscriber {
  card_id: string | null;
  display_name: string;
  company: string | null;
  headline: string | null;
  country_iso3: string | null;
  intents: string[];
  rating_avg: number | null;
  rating_count: number;
}

export interface Recommendation {  headline: string;
  detail: string;
  /** why an investor should care */
  angle: 'entry' | 'risk' | 'partner' | 'timing' | 'gap';
  strength: 'strong' | 'moderate' | 'watch';
  evidence: string[];
}

export interface CountryDashboard {
  entity: Entity;
  overview: Overview | null;
  top_exports: RankedItem[];
  top_imports: RankedItem[];
  services: RankedItem[];
  partners_export: RankedItem[];
  partners_import: RankedItem[];
  trend: TrendPoint[];
  recommendations: Recommendation[];
  /** premium: withheld for free users, count still shown as a teaser */
  opportunities: OpportunitySignal[] | null;
  opportunities_locked: number;
  computed_at: string | null;
}

export const INTENTS = [
  'buyer',
  'seller',
  'supplier',
  'distributor',
  'partner',
  'agent',
  'logistics',
  'financier',
] as const;
export type Intent = (typeof INTENTS)[number];

export const INTENT_LABEL: Record<Intent, string> = {
  buyer: 'Buying',
  seller: 'Selling',
  supplier: 'Supplying',
  distributor: 'Distributing',
  partner: 'Partnering',
  agent: 'Agent / broker',
  logistics: 'Logistics',
  financier: 'Finance',
};

// --- network layer ----------------------------------------------------------

export interface SessionUser {
  id: string;
  email: string;
  full_name: string;
  role: 'member' | 'admin';
  tier: 'free' | 'premium';
  tier_expires_at: string | null;
  country_iso3: string | null;
}

export interface BusinessCard {
  id: string;
  /**
   * Who to message or rate. Null for a signed-out reader, who can do neither,
   * and who has no reason to be handed an internal account identifier.
   */
  user_id: string | null;
  display_name: string;
  company: string | null;
  headline: string | null;
  bio: string | null;
  country_iso3: string;
  city: string | null;
  website: string | null;
  whatsapp: string | null;
  intents: Intent[];
  sectors: string[];
  hs_codes: string[];
  target_markets: string[];
  is_published: 0 | 1;
  is_verified: 0 | 1;
  rating_avg: number;
  rating_count: number;
  created_at: string;
  updated_at: string;
}

export interface BusinessCardInput {
  display_name: string;
  company?: string | null;
  headline?: string | null;
  bio?: string | null;
  country_iso3: string;
  city?: string | null;
  website?: string | null;
  whatsapp?: string | null;
  intents: Intent[];
  sectors?: string[];
  hs_codes?: string[];
  target_markets?: string[];
  is_published?: boolean;
}

export interface ConversationSummary {
  id: string;
  other_user_id: string;
  other_name: string;
  other_company: string | null;
  other_country: string | null;
  last_message: string | null;
  last_message_at: string | null;
  unread: number;
}

export interface Message {
  id: string;
  conversation_id: string;
  sender_id: string;
  body: string;
  read_at: string | null;
  created_at: string;
  mine: boolean;
}

export interface Rating {
  id: string;
  rater_id: string;
  rater_name: string;
  score: number;
  dealt_in: string | null;
  comment: string | null;
  created_at: string;
}

/** Rough sector list to keep card creation to a couple of taps. */
export const SECTOR_OPTIONS = [
  'Agriculture & food',
  'Minerals & energy',
  'Chemicals',
  'Plastics & rubber',
  'Textiles & apparel',
  'Wood & paper',
  'Metals',
  'Machinery & electronics',
  'Transport equipment',
  'Construction materials',
  'Pharmaceuticals & health',
  'Consumer goods',
  'Logistics & freight',
  'Financial services',
  'Professional services',
  'Technology & software',
] as const;

// --- premium ----------------------------------------------------------------

export type SubscriptionKind = 'product' | 'sector' | 'country' | 'hs_code';

export interface Subscription {
  id: string;
  kind: SubscriptionKind;
  value: string;
  label: string | null;
  created_at: string;
}

export interface FeedItem {
  id: string;
  kind: 'signal' | 'market_balance' | 'trend' | 'playbook' | string;
  title: string;
  body: string | null;
  payload: unknown;
  entity_slug: string | null;
  entity_name: string | null;
  premium_only: boolean;
  locked: boolean;
  read_at: string | null;
  created_at: string;
}

export interface PlaybookSummary {
  id: string;
  slug: string;
  title: string;
  sector: string | null;
  hs_code: string | null;
  country_iso3: string | null;
  summary: string | null;
  author_name: string | null;
  premium_only: 0 | 1;
  reading_minutes: number;
  published_at: string | null;
  locked: boolean;
}

export interface PlaybookSource {
  title: string;
  url: string;
  publisher: string;
}

export interface Playbook {
  slug: string;
  title: string;
  summary: string | null;
  sector: string | null;
  country_iso3: string | null;
  author_name: string | null;
  author_credential: string | null;
  reading_minutes: number;
  body_md: string;
  sources: PlaybookSource[];
  premium_only: boolean;
  locked: boolean;
}

export interface Plan {
  id: string;
  label: string;
  amount_minor: number;
  currency: string;
  days: number;
}

export function fmtMoney(minor: number, currency: string): string {
  return new Intl.NumberFormat('en', { style: 'currency', currency }).format(minor / 100);
}

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  // The sign goes outside the currency symbol. "$-3.33B" reads as a dollar
  // amount that happens to start with a minus; "-$3.33B" reads as a deficit,
  // which is what a negative trade balance is.
  const sign = v < 0 ? '-' : '';
  if (abs >= 1e12) return `${sign}$${(abs / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `${sign}$${(abs / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `${sign}$${(abs / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `${sign}$${(abs / 1e3).toFixed(1)}K`;
  return `${sign}$${abs.toFixed(0)}`;
}

export function fmtPct(v: number | null | undefined, digits = 1): string {
  if (v == null || !isFinite(v)) return '—';
  const sign = v > 0 ? '+' : '';
  return `${sign}${v.toFixed(digits)}%`;
}

export type LinkHealth = 'ok' | 'gated' | 'dead' | 'unknown';

/**
 * Classify a probed link.
 *
 * A bare HEAD against an API or SDMX endpoint legitimately returns 400/403/404
 * because the query parameters are missing, and several statistical portals
 * (UNCTAD among them) refuse any non-browser user agent. Treating those as dead
 * fills the admin table with red dots on links that work perfectly well, so
 * "reachable but refused the probe" gets its own state.
 */
export function linkHealth(status: number | null | undefined, fmt: SourceFmt): LinkHealth {
  if (status == null) return 'unknown';
  if (status >= 200 && status < 400) return 'ok';
  if (status === 0) return 'dead';
  const isMachine = fmt === 'api' || fmt === 'sdmx' || fmt === 'json';
  if (isMachine) return status >= 500 ? 'dead' : 'gated';
  if (status === 401 || status === 403 || status === 405 || status === 429) return 'gated';
  return status >= 500 ? 'dead' : 'dead';
}

export const LINK_HEALTH_LABEL: Record<LinkHealth, string> = {
  ok: 'Reachable',
  gated: 'Reachable, refused automated probe',
  dead: 'Not reachable',
  unknown: 'Not checked yet',
};
