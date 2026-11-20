/** Shapes returned by /api/credit. Every number is a stored observation or a calculation from stored observations. */

export type CreditSourceKey = 'BOG' | 'IMF' | 'FILE';
export type MeasureKind = 'stock' | 'flow' | 'unverified';

export interface CreditCountryRow {
  country_iso3: string;
  country_name: string;
  preferred_source: string;
  national_available: number;
  imf_available: number;
  in_use: CreditSourceKey | null;
  status: 'both' | 'national' | 'imf' | 'partial' | 'none' | null;
  status_note: string | null;
  checked_at: string | null;
}

export interface CreditSectorRow {
  series_id: string;
  sector_key: string;
  sector_name: string;
  role: 'sector' | 'borrower_sector';
  frequency: 'M' | 'Q' | 'A';
  kind: MeasureKind;
  kind_basis: string | null;
  period: string;
  period_end: string;
  latest_own_period: string;
  at_common_period: boolean;
  stock: number;
  prev_stock: number | null;
  net_change: number | null;
  pct_change: number | null;
  share_pct: number | null;
  rank_stock: number | null;
  rank_change: number | null;
  rank_pct: number | null;
  first_period: string;
  obs_count: number;
  flag: string | null;
  flags_note: string | null;
}

export interface CreditTotal {
  valid: boolean;
  reason: string | null;
  period?: string;
  stock?: number;
  prev_stock?: number | null;
  net_change?: number | null;
  pct_change?: number | null;
  sectors_sum?: number;
  gap_pct?: number | null;
  history?: [string, number][];
}

export interface CreditSummary {
  country: string;
  source_key: CreditSourceKey;
  source_name: string;
  unit: string;
  frequency: 'M' | 'Q' | 'A' | null;
  common_period: string | null;
  common_period_end: string | null;
  sector_count: number;
  sectors: CreditSectorRow[];
  total: CreditTotal;
  top_gainers: string[];
  top_losers: string[];
  generated_at: string;
}

export interface CreditSeriesMeta {
  id: string;
  country_iso3: string;
  source_key: CreditSourceKey;
  source_name: string | null;
  databank: string | null;
  dataflow: string | null;
  mnemonic: string;
  series_name: string | null;
  data_family: string | null;
  sector_key: string;
  sector_name: string;
  series_role: string;
  currency: string | null;
  unit_label: string | null;
  unit_multiplier: number;
  unit_verified: number;
  frequency: 'M' | 'Q' | 'A' | null;
  first_obs: string | null;
  latest_obs: string | null;
  obs_count: number;
  is_active: number;
  measure_kind: MeasureKind;
  kind_basis: string | null;
  definition_notes: string | null;
  endpoint_url: string | null;
  sort_order: number;
  last_fetch_at: string | null;
  fetch_status: string | null;
  fetch_error: string | null;
}

export interface CreditSectorMap {
  sector_key: string;
  trade_scope: 'hs' | 'exports' | 'imports' | 'none';
  hs_prefixes: string | null;
  trade_flow: 'X' | 'M' | 'both';
  confidence: 'direct' | 'indicative' | 'none';
  note: string | null;
  is_active?: number;
}

export interface CreditCountry {
  country: { iso3: string; name: string; slug: string | null };
  source: CreditCountryRow & { currency: string | null };
  primary: CreditSourceKey | null;
  summaries: Partial<Record<CreditSourceKey, CreditSummary | null>>;
  series: CreditSeriesMeta[];
  flags: { series_id: string; flag_code: string; since_period: string | null; message: string }[];
  sector_map: Record<string, CreditSectorMap>;
  last_run: { id: string; trigger: string; status: string; started_at: string; finished_at: string; series_ok: number; series_failed: number; obs_new: number; obs_revised: number } | null;
}

export interface CreditPoint {
  period: string;
  period_end: string;
  stock: number | null;
  prev_stock: number | null;
  net_change: number | null;
  pct_change: number | null;
  share_pct: number | null;
  rank_stock: number | null;
  rank_change: number | null;
  rank_pct: number | null;
  flag: string | null;
}

export interface CreditHistory {
  series: CreditSeriesMeta;
  history: CreditPoint[];
  revisions: number;
}

export interface CreditRun {
  id: string;
  run_kind: string;
  trigger: string;
  requested_by: string | null;
  status: string;
  backfill: number;
  countries: string | null;
  requested_at: string | null;
  started_at: string | null;
  finished_at: string | null;
  series_ok: number;
  series_failed: number;
  obs_new: number;
  obs_revised: number;
  detail: string | null;
}

export interface CreditAdminOverview {
  series: CreditSeriesMeta[];
  countries: (CreditCountryRow & { currency: string | null; is_active: number })[];
  runs: CreditRun[];
  sector_map: (CreditSectorMap & { is_active: number })[];
}

export interface CreditQueueFile { name: string; bytes: number; uploaded: string }
