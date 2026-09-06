export interface FactRow {
  year: number;
  flow: 'export' | 'import';
  stream: 'goods' | 'services';
  partner_iso3: string | null;
  partner_name: string | null;
  hs_code: string | null;
  product_name: string | null;
  sector: string | null;
  value_usd: number;
  qty?: number | null;
  qty_unit?: string | null;
  source_ref: string;
}

export interface AdapterResult {
  rows: FactRow[];
  source_ref: string;
  ok: boolean;
  note: string;
  /**
   * Years whose specific-product (HS6) detail came back capped by the source
   * and is therefore an arbitrary subset of what the country actually trades.
   * Growth must never be computed between two such years: the difference
   * measures which rows the API happened to return, not real trade.
   */
  truncated_years?: number[];
  /** Adapter-specific cheap change-detection signal (e.g. World Bank's `lastupdated`). */
  meta?: Record<string, unknown>;
}
