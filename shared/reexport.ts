export interface FlowYear {
  year: number;
  value_usd: number;
  qty_kg: number | null;
}

export interface ReexportSignal {
  /** 'possible' only when every test below passes; otherwise the specific reason it does not. */
  verdict: 'possible' | 'one-directional' | 'volumes-differ' | 'insufficient';
  years: number[];
  export_to_import_ratio: number | null;
  /** Export unit value divided by import unit value, when both report weight in the same years. */
  unit_value_ratio: number | null;
  reason: string;
  limitations: string[];
}

const MIN_YEARS = 2;
const RATIO_LOW = 0.5;
const RATIO_HIGH = 2;
const UNIT_VALUE_BAND = 0.25;

const LIMITATIONS = [
  'Customs statistics do not flag goods that were imported and sent on, so this is a signal built from the two flows, not a count of re-exports.',
  'A country that both makes and imports a product can show the same pattern without any re-export.',
];

function unitValue(rows: FlowYear[]): number | null {
  const kg = rows.reduce((s, r) => s + (r.qty_kg && r.qty_kg > 0 ? r.qty_kg : 0), 0);
  const val = rows.reduce((s, r) => s + (r.qty_kg && r.qty_kg > 0 ? r.value_usd : 0), 0);
  return kg > 0 ? val / kg : null;
}

/**
 * Looks at one country's exports and imports of one product over the years
 * both are reported. A re-export hub shows large flows in both directions of
 * similar size at similar prices per kilogram. Every test must pass for
 * 'possible'; anything else says which one failed.
 */
export function reexportSignal(exports: FlowYear[], imports: FlowYear[]): ReexportSignal {
  const impByYear = new Map(imports.filter((r) => r.value_usd > 0).map((r) => [r.year, r]));
  const both = exports
    .filter((r) => r.value_usd > 0 && impByYear.has(r.year))
    .map((r) => ({ year: r.year, x: r, m: impByYear.get(r.year) as FlowYear }));
  const base = { years: both.map((b) => b.year), limitations: LIMITATIONS };

  if (!exports.some((r) => r.value_usd > 0) || !imports.some((r) => r.value_usd > 0)) {
    return { ...base, verdict: 'one-directional', export_to_import_ratio: null, unit_value_ratio: null,
      reason: 'The country reports trade in this product in one direction only.' };
  }
  if (both.length < MIN_YEARS) {
    return { ...base, verdict: 'insufficient', export_to_import_ratio: null, unit_value_ratio: null,
      reason: `Both flows are reported in fewer than ${MIN_YEARS} common years.` };
  }

  const xs = both.reduce((s, b) => s + b.x.value_usd, 0);
  const ms = both.reduce((s, b) => s + b.m.value_usd, 0);
  const ratio = xs / ms;
  const everyYearInRange = both.every((b) => {
    const r = b.x.value_usd / b.m.value_usd;
    return r >= RATIO_LOW && r <= RATIO_HIGH;
  });
  const round = (n: number | null) => (n == null ? null : Math.round(n * 100) / 100);

  if (!everyYearInRange) {
    return { ...base, verdict: 'volumes-differ', export_to_import_ratio: round(ratio), unit_value_ratio: null,
      reason: `Exports and imports are not within a factor of two of each other in every common year (overall ${ratio.toFixed(2)} to 1).` };
  }

  const ux = unitValue(both.map((b) => b.x));
  const um = unitValue(both.map((b) => b.m));
  const uvRatio = ux != null && um != null ? ux / um : null;
  if (uvRatio != null && Math.abs(uvRatio - 1) > UNIT_VALUE_BAND) {
    return { ...base, verdict: 'volumes-differ', export_to_import_ratio: round(ratio), unit_value_ratio: round(uvRatio),
      reason: `Volumes are similar, but export and import unit values differ by more than ${UNIT_VALUE_BAND * 100}%, which points to different goods rather than the same goods passing through.` };
  }

  return { ...base, verdict: 'possible', export_to_import_ratio: round(ratio), unit_value_ratio: round(uvRatio),
    reason: uvRatio == null
      ? 'Exports and imports are of similar size in every common year. No weight was reported to compare prices.'
      : 'Exports and imports are of similar size in every common year, at similar prices per kilogram.' };
}
