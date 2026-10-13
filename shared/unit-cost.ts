export interface UnitCostInput {
  year: number;
  value_usd: number;
  qty_kg: number | null;
  qty?: number | null;
  qty_unit?: string | null;
}

export interface UnitCostRow {
  year: number;
  basis: 'kg' | 'unit';
  /** Dollars per kilogram or per reported unit, depending on basis. */
  price: number;
  unit_label: string;
  change_pct: number | null;
}

export interface UnitCostTrend {
  rows: UnitCostRow[];
  years_total: number;
  years_priced: number;
  limitations: string[];
}

const JUMP_PCT = 100;

/**
 * Price per kilogram for each year, from trade value over net weight. Where a year has no weight but
 * the source reports a quantity in its own unit, price per that unit is used instead. The two bases are
 * never mixed in one change figure, and years with neither are counted, not filled in.
 */
export function unitCostTrend(series: UnitCostInput[]): UnitCostTrend {
  const rows: UnitCostRow[] = [];
  let prev: UnitCostRow | null = null;
  for (const r of series) {
    let row: UnitCostRow | null = null;
    if (r.qty_kg && r.qty_kg > 0 && r.value_usd > 0) {
      row = { year: r.year, basis: 'kg', price: r.value_usd / r.qty_kg, unit_label: 'kg', change_pct: null };
    } else if (r.qty && r.qty > 0 && r.qty_unit && r.value_usd > 0) {
      row = { year: r.year, basis: 'unit', price: r.value_usd / r.qty, unit_label: r.qty_unit, change_pct: null };
    }
    if (!row) { prev = null; continue; }
    if (prev && prev.basis === row.basis && prev.unit_label === row.unit_label && prev.price > 0) {
      row.change_pct = ((row.price - prev.price) / prev.price) * 100;
    }
    rows.push(row);
    prev = row;
  }
  const limitations: string[] = [];
  if (rows.length < series.length) {
    limitations.push(`${series.length - rows.length} of ${series.length} years have no weight or quantity, so no price is shown for them.`);
  }
  if (rows.some((r) => r.basis === 'unit')) {
    limitations.push('Years priced per unit use the unit the source reports and are not comparable with per-kilogram years.');
  }
  const jumps = rows.filter((r) => r.change_pct != null && Math.abs(r.change_pct) >= JUMP_PCT).map((r) => r.year);
  if (jumps.length) {
    limitations.push(`The price moved by ${JUMP_PCT}% or more in ${jumps.join(', ')}. That can be a real price move, but it can also come from a change in what was reported (value, weight or product mix), so check the source before relying on it.`);
  }
  limitations.push('This is customs value over reported quantity, an average price. It is not a quote or a contract price.');
  return { rows, years_total: series.length, years_priced: rows.length, limitations };
}
