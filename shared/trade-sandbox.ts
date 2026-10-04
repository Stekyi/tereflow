export interface TradeSandboxProduct {
  hs_code: string;
  product_name: string;
  flow: 'export' | 'import';
  year: number;
  value_usd: number;
  qty_kg: number | null;
  classification_level: 'HS6' | 'HS8' | 'HS10';
  reporter: string;
  /** ISO3 of the selected partner this product row belongs to. */
  partner_iso3: string;
}

/** A year with no stored rows is null. Null is not an observed zero. */
export interface TradeSandboxYearTotal {
  year: number;
  export_usd: number | null;
  import_usd: number | null;
}

/**
 * Primary-country total for one product, year, and flow.
 * Sum of every partner row. Not the headline world row, and not limited
 * to the partners selected in the sandbox.
 */
export interface TradeSandboxProductTotal {
  year: number;
  flow: 'export' | 'import';
  hs_code: string;
  value_usd: number;
}

export interface TradeSandboxPartner {
  slug: string;
  name: string;
  iso3: string;
  classification_level: 'HS6' | 'HS8' | 'HS10' | null;
  reporter_basis: 'primary' | 'mirror' | 'none';
  years: number[];
  totals: TradeSandboxYearTotal[];
  products: TradeSandboxProduct[];
  /** Rows Comtrade stored without a value (Oracle path). Not zero, and not shown in products. */
  unreported_rows?: number;
}

export interface TradeSandboxResponse {
  primary: { slug: string; name: string; iso3: string };
  partners: TradeSandboxPartner[];
  years: number[];
  /** Product totals for the primary reporter across all stored partners. */
  primary_product_totals: TradeSandboxProductTotal[];
  /** How many traditional codes were hidden from this result. Absent or 0 when nothing was hidden. */
  excluded_codes?: number;
  note: string;
}
