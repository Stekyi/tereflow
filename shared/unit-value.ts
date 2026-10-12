export interface UnitValuePartner {
  partner: string;
  value_usd: number;
  net_weight_kg: number | null;
  unit_value_usd_per_kg: number | null;
}

export interface UnitValueRow {
  partner: string;
  unit_value_usd_per_kg: number;
  vs_median_pct: number;
  position: 'above' | 'below' | 'in-line';
}

export interface UnitValueAnalysis {
  rows: UnitValueRow[];
  median_usd_per_kg: number | null;
  /** Partners with a reported weight, out of all partners given. */
  covered: number;
  total: number;
  /** Share of the product's value that sits in partners with a weight. */
  covered_value_pct: number;
  limitations: string[];
}

const BAND_PCT = 15;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/**
 * Compares each partner's dollars-per-kilogram with the median for the same
 * product. Only partners that reported a weight are compared; the rest are
 * counted, never filled in. Fewer than three comparable partners gives no
 * median, since two points cannot show an outlier.
 */
export function analyseUnitValues(partners: UnitValuePartner[]): UnitValueAnalysis {
  const comparable = partners.filter(
    (p) => p.unit_value_usd_per_kg != null && p.unit_value_usd_per_kg > 0 && (p.net_weight_kg ?? 0) > 0,
  );
  const totalValue = partners.reduce((s, p) => s + (p.value_usd > 0 ? p.value_usd : 0), 0);
  const coveredValue = comparable.reduce((s, p) => s + p.value_usd, 0);
  const limitations = [
    'Unit value is declared value divided by declared net weight; it is a price signal, not a quoted price.',
    'Mixed grades, packaging and freight terms inside one product code move the figure without any real price difference.',
  ];
  if (comparable.length < partners.length) {
    limitations.push(`${partners.length - comparable.length} of ${partners.length} partners reported no weight and are not compared.`);
  }
  const base = {
    covered: comparable.length,
    total: partners.length,
    covered_value_pct: totalValue > 0 ? Math.round((coveredValue / totalValue) * 1000) / 10 : 0,
    limitations,
  };
  if (comparable.length < 3) {
    limitations.push('Fewer than three partners have a weight, so no comparison is made.');
    return { rows: [], median_usd_per_kg: null, ...base };
  }
  const med = median(comparable.map((p) => p.unit_value_usd_per_kg as number));
  const rows = comparable.map((p) => {
    const pct = ((p.unit_value_usd_per_kg as number) / med - 1) * 100;
    return {
      partner: p.partner,
      unit_value_usd_per_kg: p.unit_value_usd_per_kg as number,
      vs_median_pct: Math.round(pct * 10) / 10,
      position: (Math.abs(pct) <= BAND_PCT ? 'in-line' : pct > 0 ? 'above' : 'below') as UnitValueRow['position'],
    };
  });
  return { rows, median_usd_per_kg: Math.round(med * 100) / 100, ...base };
}
