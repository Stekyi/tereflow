/**
 * What a country provider has to satisfy.
 *
 * The point of this file is that the analytics below it never learns the word
 * "Ghana". Adding Nigeria should mean a new config and a new parser, not a new
 * branch in the maths.
 */

export type TradeFlow = 'import' | 'export';
export type ClassificationLevel = 'HS2' | 'HS4' | 'HS6' | 'HS10';

/** One observed cell, as every provider must return it. */
export interface TradeObservation {
  country_code: string;
  year: number;
  /** 0 for a full year, 1 to 12 for a month. */
  month: number;
  trade_flow: TradeFlow;
  classification_system: 'HS';
  classification_level: ClassificationLevel;
  product_code: string;
  product_description: string | null;
  /** The partner as this application names it, not as the source spells it. */
  partner_country: string;
  partner_iso3: string | null;
  import_value_usd: number | null;
  net_weight_kg: number | null;
  /**
   * True when an annual figure was summed from months because the source's own
   * annual cell was empty. Ghana StatBank does this for its most recent year,
   * and a derived total is not the same claim as a reported one.
   */
  value_is_derived: boolean;
  months_counted: number | null;
  source: string;
  source_endpoint: string;
  retrieved_at: string;
}

/** What a fetch produced, including the bytes, so a run stays auditable. */
export interface ProviderResult {
  ok: boolean;
  observations: TradeObservation[];
  /**
   * Kept verbatim for raw_trade_data. The only way to tell a parser bug from a
   * source change is to still have what arrived.
   */
  raw: Array<{
    endpoint: string;
    request: unknown;
    http_status: number;
    content_type: string | null;
    body: string;
  }>;
  /** Cells the source returned that could not be trusted, and why. */
  rejected: Array<{ reason: string; detail: string }>;
  /** Things a reader of the resulting numbers should know. */
  notes: string[];
  error: string | null;
}

export interface PartnerMapping {
  /** The name this application uses. */
  app_name: string;
  /** The exact string the source expects. Different more often than not. */
  source_name: string;
  iso3: string;
}

export interface ExclusionRule {
  /** HS codes at the configured level, or prefixes of them. */
  codes?: string[];
  /** Matched against the product description, case insensitive. */
  pattern?: string;
  reason: string;
}

export interface ScoringWeights {
  market_size: number;
  growth: number;
  import_dependency: number;
  stability: number;
  supplier_concentration: number;
}

export interface CountryConfig {
  code: string;
  name: string;
  iso3: string;
  provider: {
    type: string;
    endpoint: string;
    /** PXWeb dimension names. Discovered from the endpoint, not assumed. */
    dimensions: {
      valuation: string;
      flow: string;
      year: string;
      month: string;
      product: string;
      partner: string;
    };
    values: {
      value_usd: string;
      weight_kg: string;
      flow_import: string;
      flow_export: string;
      all_months: string;
      all_products: string;
      all_partners: string;
      months: string[];
    };
  };
  classification: {
    system: 'HS';
    level: ClassificationLevel;
  };
  /** Years to request. Explicit so a run is reproducible. */
  years: string[];
  partners: PartnerMapping[];
  filters: {
    excluded: ExclusionRule[];
  };
  scoring: ScoringWeights;
}

export interface TradeDataProvider {
  readonly name: string;
  fetchObservations(input: {
    config: CountryConfig;
    flow: TradeFlow;
    years: string[];
    partners: PartnerMapping[];
    products: string[] | 'all';
  }): Promise<ProviderResult>;
}
