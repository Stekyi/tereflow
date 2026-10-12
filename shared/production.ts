/**
 * HS headings that correspond to exactly one FAOSTAT crop item. Deliberately short: a product is listed only
 * when the HS heading and the FAO item describe the same thing, so a heading that covers several crops, a
 * processed form, or a product FAO measures differently is left out rather than approximated.
 *
 * `item` is the FAOSTAT item name exactly as it appears in the production data file (the separate item list uses semicolons where the data uses commas); the loader refuses to store
 * a row whose name does not match, so a renumbered FAO code can never attach the wrong crop to a heading.
 */
export interface ProductionItem {
  hs: string;
  faoCode: number;
  item: string;
  label: string;
}

export const PRODUCTION_ITEMS: ProductionItem[] = [
  { hs: '1801', faoCode: 661, item: 'Cocoa beans', label: 'cocoa beans' },
  { hs: '0901', faoCode: 656, item: 'Coffee, green', label: 'green coffee' },
  { hs: '0902', faoCode: 667, item: 'Tea leaves', label: 'tea' },
  { hs: '0801', faoCode: 217, item: 'Cashew nuts, in shell', label: 'cashew nuts in shell' },
  { hs: '0803', faoCode: 486, item: 'Bananas', label: 'bananas' },
  { hs: '0804', faoCode: 574, item: 'Pineapples', label: 'pineapples' },
  { hs: '0805', faoCode: 490, item: 'Oranges', label: 'oranges' },
  { hs: '0701', faoCode: 116, item: 'Potatoes', label: 'potatoes' },
  { hs: '0702', faoCode: 388, item: 'Tomatoes', label: 'tomatoes' },
  { hs: '0714', faoCode: 125, item: 'Cassava, fresh', label: 'fresh cassava' },
  { hs: '1001', faoCode: 15, item: 'Wheat', label: 'wheat' },
  { hs: '1005', faoCode: 56, item: 'Maize (corn)', label: 'maize' },
  { hs: '1006', faoCode: 27, item: 'Rice', label: 'rice' },
  { hs: '1201', faoCode: 236, item: 'Soya beans', label: 'soya beans' },
  { hs: '1207', faoCode: 289, item: 'Sesame seed', label: 'sesame seed' },
  { hs: '1511', faoCode: 257, item: 'Palm oil', label: 'palm oil' },
  { hs: '1701', faoCode: 156, item: 'Sugar cane', label: 'sugar cane' },
  { hs: '0905', faoCode: 692, item: 'Vanilla, raw', label: 'vanilla' },
  { hs: '0910', faoCode: 720, item: 'Ginger, raw', label: 'ginger' },
];

export const PRODUCTION_BY_HS: Record<string, ProductionItem> = Object.fromEntries(PRODUCTION_ITEMS.map((p) => [p.hs, p]));

export interface ProductionPoint {
  year: number;
  tonnes: number | null;
  area_ha: number | null;
  /** FAOSTAT flag: A official, E estimated, I imputed, X external. */
  flag: string | null;
}

export interface ProductionSignal {
  available: boolean;
  item: string | null;
  source: string;
  scope: string;
  reason: string | null;
  latest_year: number | null;
  latest_tonnes: number | null;
  /** Change in tonnes across the last five years shown, as a percentage. */
  change_5y_pct: number | null;
  /** Domestic production as a multiple of exports, in tonnes, for the latest common year; null without export weight. */
  production_to_export_ratio: number | null;
  series: ProductionPoint[];
  limitations: string[];
}

export const PRODUCTION_SOURCE = 'FAOSTAT crops and livestock production (fao.org/faostat)';
export const PRODUCTION_SCOPE = 'Crop production only, for the crops listed here. Manufactured goods, minerals and most processed foods are not covered.';
const LIMITS = [
  'FAOSTAT counts the raw crop; the traded product may be a processed form, so tonnes of production and tonnes traded are not the same thing.',
  'Some figures are FAO estimates or imputed values, not official national statistics; the flag is shown per year.',
];

/**
 * Turns stored production rows into the answer. exportKgByYear is the country's own exported weight for the
 * product, used only to put production in proportion; it is left null when that weight is not reported.
 */
export function productionSignal(
  hs: string,
  points: ProductionPoint[],
  exportKgByYear: Record<number, number> = {},
): ProductionSignal {
  const item = PRODUCTION_BY_HS[hs.slice(0, 4)] ?? null;
  const base = { source: PRODUCTION_SOURCE, scope: PRODUCTION_SCOPE, limitations: LIMITS };
  const none = { latest_year: null, latest_tonnes: null, change_5y_pct: null, production_to_export_ratio: null, series: [] };
  if (!item) {
    return { ...base, ...none, available: false, item: null, reason: 'This product is not one of the crops matched to FAOSTAT.' };
  }
  const series = points.filter((p) => p.tonnes != null && p.tonnes >= 0).sort((a, b) => a.year - b.year);
  if (!series.length) {
    return { ...base, ...none, available: false, item: item.label, reason: 'FAOSTAT has no production figure for this country and crop.' };
  }
  const last = series[series.length - 1];
  const recent = series.slice(-5);
  const first = recent[0];
  const change = recent.length >= 2 && (first.tonnes as number) > 0
    ? ((last.tonnes as number) / (first.tonnes as number) - 1) * 100
    : null;
  const exportKg = exportKgByYear[last.year];
  const ratio = exportKg && exportKg > 0 && (last.tonnes as number) > 0 ? (last.tonnes as number) / (exportKg / 1000) : null;
  return {
    ...base, available: true, item: item.label, reason: null, latest_year: last.year, latest_tonnes: last.tonnes,
    change_5y_pct: change == null ? null : Math.round(change * 10) / 10,
    production_to_export_ratio: ratio == null ? null : Math.round(ratio * 100) / 100,
    series: series.slice(-10),
  };
}
