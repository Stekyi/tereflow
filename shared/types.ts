export type EntityKind = 'country' | 'intl_org' | 'regional_body';
export type SourceCategory = 'export' | 'import' | 'commerce';
export type SourceFmt = 'html' | 'csv' | 'json' | 'api' | 'sdmx' | 'xlsx' | 'pdf';
export type Flow = 'export' | 'import';
export type Stream = 'goods' | 'services';

export const ENTITY_KINDS: EntityKind[] = ['country', 'intl_org', 'regional_body'];
export const SOURCE_CATEGORIES: SourceCategory[] = ['export', 'import', 'commerce'];
export const SOURCE_FMTS: SourceFmt[] = ['html', 'csv', 'json', 'api', 'sdmx', 'xlsx', 'pdf'];
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

export interface Recommendation {
  headline: string;
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
  country_iso3: string | null;
}

export interface BusinessCard {
  id: string;
  user_id: string;
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

export function fmtUsd(v: number | null | undefined): string {
  if (v == null || !isFinite(v)) return '—';
  const abs = Math.abs(v);
  if (abs >= 1e12) return `$${(v / 1e12).toFixed(2)}T`;
  if (abs >= 1e9) return `$${(v / 1e9).toFixed(2)}B`;
  if (abs >= 1e6) return `$${(v / 1e6).toFixed(1)}M`;
  if (abs >= 1e3) return `$${(v / 1e3).toFixed(1)}K`;
  return `$${v.toFixed(0)}`;
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
