export interface IntelState { state: string; kind: 'derived' | 'heuristic'; basis: string; value: number | null }

export interface IntelCms {
  x0: number; x1: number; total_change: number; growth: number; distribution: number; competitiveness: number; new_markets: number; check_gap: number;
  market_growth_pct: number | null; excluded_markets: string[];
  markets: { iso3: string; change: number; growth: number; distribution: number; competitiveness: number; new_market: number }[];
}

export interface IntelProduct {
  hs6: string;
  description: string | null;
  method_version: string;
  period: { base: number; latest: number };
  coverage: { importers: string[]; importer_count: number; reporters_not_in_universe: string[]; note: string };
  demand: {
    value_usd: number | null; base_usd: number | null; growth_pct: number | null; weight_kg: number | null; base_weight_kg: number | null; weight_growth_pct: number | null;
    unit_value: number | null; base_unit_value: number | null; unit_value_change_pct: number | null;
    series: { year: number; value_usd: number | null; weight_kg: number | null; unit_value: number | null }[];
    importers: { iso3: string; value_usd: number; share_pct: number | null; base_usd: number | null; growth_pct: number | null; rank: number | null; rank_change: number | null }[];
  };
  supply: {
    suppliers: { iso3: string; value_usd: number; share_pct: number | null; base_usd: number | null; share_change_pp: number | null; growth_pct: number | null; unit_value: number | null; rank: number | null; rank_change: number | null }[];
    supplier_count: number; hhi: number | null; base_hhi: number | null; hhi_change: number | null; top_share_pct: number | null; base_top_share_pct: number | null;
    reported_exports: { value_usd: number | null; base_usd: number | null; value_growth_pct: number | null; weight_kg: number | null; weight_growth_pct: number | null; unit_value: number | null; unit_value_change_pct: number | null; note: string };
  };
  competitiveness: {
    iso3: string; rca: number | null;
    rca_terms: { supplier_product_usd: number | null; supplier_all_usd: number | null; world_product_usd: number | null; world_all_usd: number | null };
    cms?: IntelCms;
  }[];
  mirror: { pairs: number; exports_reported_usd: number | null; imports_reported_usd: number | null; imports_over_exports: number | null };
  opportunities?: IntelOpportunities;
  armington?: IntelArmington;
  pressure: {
    indicators: Record<string, number | null>;
    states: IntelState[];
    note: string | null;
    cuts?: Record<string, { low: number | null; high: number | null; products: number }>;
  };
}

export interface IntelMethods {
  version: string; universe: string; imports: string; shares: string; hhi: string; unit_value: string; rca: string; cms: string; mirror: string; pressure: string;
  opportunities?: string; armington?: string; gravity?: string; mapping?: string; network?: string;
  not_implemented: string[];
}

export interface IntelRun {
  products: number; base: number; latest: number; importers: string[]; excluded_reporters: string[]; computed_at: string; full: boolean;
}

export interface ProductIntel { product: IntelProduct; computed_at: string; methods: IntelMethods | null; run: IntelRun | null }
export interface IntelListRow { hs6: string; demand_usd: number; latest_year: number }

export interface IntelCandidate {
  iso3: string; share_in_market_pct: number; global_sales_usd: number; global_growth_pct: number | null; rca: number | null; unit_value: number | null;
  distance_km: number | null; flags: string[];
}
export interface IntelOpportunityMarket {
  iso3: string; value_usd: number; growth_pct: number | null; weight_growth_pct: number | null; unit_value: number | null; supplier_count: number;
  hhi: number | null; effective_suppliers: number | null; top3_share_pct: number | null; candidates: IntelCandidate[];
}
export interface IntelOpportunities { markets: IntelOpportunityMarket[]; limits: string[]; kind: string; global_unit_value: number | null }
export interface IntelArmington {
  effective_suppliers: number | null; unit_value_dispersion_cv: number | null; rank_corr_unit_value_change_vs_share_change: number | null;
  suppliers: { iso3: string; unit_value: number | null; unit_value_vs_market_pct: number | null; relative_unit_value_change_pp: number | null; share_change_pp: number | null }[];
  structural_estimate: string; note: string;
}

export interface IntelMapPath { hs17: string; cpc21: string; isic4: string; route: string; figaro: string; hs_partial: number; hs_cpc_partial: number; cpc_partial: number; isic_partial: number }
export interface IntelMapIndustry { figaro: string; isic4: string[]; cpc21: string[]; hs17: string[]; any_partial: boolean; paths: IntelMapPath[] }
export interface IntelMapping {
  category: 'direct' | 'derived_multiple' | 'unresolved' | string;
  map: { hs6: string; version: string; category: string; unresolved_reason: string | null; hs_basis: string; hs17: string[]; hs2022_hs2017_relationship: string[]; industries: IntelMapIndustry[]; weights: null; unplaced_paths: unknown[]; caveats: string[] };
  version: string; computed_at: string; industries: Record<string, string>;
  sources: { k: string; name: string; url: string; version: string; direction: string | null; retrieved_at: string; licence_note: string | null }[];
}

export interface IntelRegion { code: string; iso3: string | null; name: string | null; note: string | null }
export interface IntelIoRow { country: string; iso3: string | null; industry: string; industry_name: string; value_meur?: number; share_of_output_pct?: number; coef?: number; total?: number; direct?: number; indirect?: number; self?: boolean }
export interface IntelIo {
  io: {
    country: string; country_iso3: string | null; industry: string; industry_name: string; year: number; unit: string; price_basis: string; output_meur: number;
    intermediate_input_share: number; total_requirement: number; self_total: number; domestic_share_direct: number | null; domestic_share_total: number | null;
    direct_top: IntelIoRow[]; total_top: IntelIoRow[];
    by_supplier_country: { country: string; iso3: string | null; direct: number; total: number }[];
    by_supplier_industry: { industry: string; industry_name: string; direct: number; total: number }[];
  };
  source: { dataset: string; year: number; last_update: string[]; licence: string; modification_note: string; coverage_note: string; limitations: string[]; unit: string; price_basis: string; blockers: string[] } | null;
}

export interface IntelGravity {
  chapter: string; year?: number; computed_at?: string;
  meta: { source: { name: string; url: string; licence: string; terms: string }; failed: Record<string, string>; holdout_share: number; importers: string[] } | null;
  model: null | {
    converged: boolean; pairs: number; positive_flows: number; zero_flows: number; importers: number; exporters: number; pseudo_r2: number | null;
    coefficients: Record<string, { coef: number; se: number }>;
    validation: { heldout_pairs?: number; model_beats_baseline?: boolean; better_than_baseline_on?: string[]; corr_log_model?: number; corr_log_baseline?: number; deviance_model?: number; deviance_baseline?: number; rmse_level_musd_model?: number; rmse_level_musd_baseline?: number };
    model_vs_observed: Record<string, { exporter: string; observed_usd: number; model_usd: number; observed_over_model: number; distance_km: number }[]>;
    kind: string; note: string;
  };
}