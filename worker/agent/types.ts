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
}
