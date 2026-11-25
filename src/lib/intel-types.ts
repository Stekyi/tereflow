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
  pressure: {
    indicators: Record<string, number | null>;
    states: IntelState[];
    note: string | null;
    cuts?: Record<string, { low: number | null; high: number | null; products: number }>;
  };
}

export interface IntelMethods {
  version: string; universe: string; imports: string; shares: string; hhi: string; unit_value: string; rca: string; cms: string; mirror: string; pressure: string;
  not_implemented: string[];
}

export interface IntelRun {
  products: number; base: number; latest: number; importers: string[]; excluded_reporters: string[]; computed_at: string; full: boolean;
}

export interface ProductIntel { product: IntelProduct; computed_at: string; methods: IntelMethods | null; run: IntelRun | null }
export interface IntelListRow { hs6: string; demand_usd: number; latest_year: number }
