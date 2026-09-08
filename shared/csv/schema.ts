/**
 * What each CSV is allowed to contain.
 *
 * One definition per dataset, and it drives three things at once: the template
 * an administrator downloads, the validation their file is checked against,
 * and the documentation of what every column means. They cannot drift, because
 * there is only one of them.
 *
 * The alternative, a template written by hand next to a validator written by
 * hand, goes wrong the first time somebody adds a column to one and not the
 * other. The administrator then fills in a column that is silently ignored,
 * and nothing anywhere says so.
 */

export type DatasetCode =
  | 'imports'
  | 'exports'
  | 'demographics'
  | 'income'
  | 'sectors'
  | 'investment';

export type ColumnKind =
  | 'iso3'
  | 'year'
  | 'period'
  | 'flow'
  | 'stream'
  | 'text'
  | 'code'
  | 'number'
  | 'currency'
  | 'unit'
  | 'url'
  | 'enum'
  | 'ratio';

export interface ColumnSpec {
  name: string;
  kind: ColumnKind;
  required: boolean;
  /** What it is for, in the words an administrator would use. */
  help: string;
  /** Shown in the template README, and checked when the list is closed. */
  accepts?: string[];
  /** True when a value outside `accepts` is a warning rather than a rejection. */
  acceptsOpen?: boolean;
  example?: string;
  /** Rejects negatives. Trade values and populations cannot be below zero. */
  nonNegative?: boolean;
  min?: number;
  max?: number;
}

export interface DatasetSpec {
  code: DatasetCode;
  name: string;
  /** trade rows go to trade_facts, the others to their own observation table. */
  target: 'trade' | 'indicator' | 'sector';
  description: string;
  refresh: string;
  columns: ColumnSpec[];
  /**
   * The columns that together identify one observation. Two rows sharing all
   * of them are the same fact stated twice, which is a duplicate whatever else
   * differs, and summing both would double it.
   */
  logicalKey: string[];
  /** Fixed for a dataset, so the file does not have to repeat it every row. */
  fixedFlow?: 'export' | 'import';
  notes: string[];
}

const SOURCE_COLUMNS: ColumnSpec[] = [
  {
    name: 'source_name',
    kind: 'text',
    required: true,
    help: 'Who published this. A figure with no source cannot be checked by anybody later.',
    example: 'Ghana Statistical Service',
  },
  {
    name: 'source_url',
    kind: 'url',
    required: false,
    help: 'Page or file the figures came from. Strongly recommended: it is what makes a number verifiable a year from now.',
    example: 'https://statsghana.gov.gh/trade-2024',
  },
];

const TRADE_COLUMNS = (flow: 'import' | 'export'): ColumnSpec[] => [
  {
    name: 'country_iso3',
    kind: 'iso3',
    required: true,
    help: 'The reporting country, as a three-letter ISO 3166 code. Must match the country you are uploading against.',
    example: 'GHA',
  },
  {
    name: 'year',
    kind: 'year',
    required: true,
    help: 'Calendar year the figure covers. Use the period column for anything shorter.',
    example: '2024',
  },
  {
    name: 'period',
    kind: 'period',
    required: false,
    help: 'Only when the row is not a full year. Use 2024-Q1 or 2024-03. Quarters and months are never summed into a year automatically, because that is only correct when all of them are present.',
    example: '',
  },
  {
    name: 'flow',
    kind: 'flow',
    required: true,
    help: `Must be ${flow} in this template. The other direction has its own file so a mistake cannot put exports into imports.`,
    accepts: [flow],
    example: flow,
  },
  {
    name: 'stream',
    kind: 'stream',
    required: true,
    help: 'goods or services. Services carry a sector instead of an HS code.',
    accepts: ['goods', 'services'],
    example: 'goods',
  },
  {
    name: 'partner_iso3',
    kind: 'iso3',
    required: false,
    help: 'The country on the other side. Leave blank for a total across all partners, which is a real and useful row.',
    example: 'NLD',
  },
  {
    name: 'partner_name',
    kind: 'text',
    required: false,
    help: 'Partner as printed in your source. Used to check the code, and kept when a partner is a grouping like the EU that has no country code.',
    example: 'Netherlands',
  },
  {
    name: 'hs_code',
    kind: 'code',
    required: false,
    help: 'Harmonised System code, 2, 4 or 6 digits. Leave blank for a country total. Do not mix levels in one file: a chapter and its subheadings describe the same trade twice.',
    example: '180100',
  },
  {
    name: 'product_name',
    kind: 'text',
    required: false,
    help: 'Product as printed in your source.',
    example: 'Cocoa beans, whole or broken',
  },
  {
    name: 'sector_code',
    kind: 'code',
    required: false,
    help: 'For services, where there is no HS code. See the sector list in the admin page.',
    example: '',
  },
  {
    name: 'sector_name',
    kind: 'text',
    required: false,
    help: 'Sector as printed in your source.',
    example: '',
  },
  {
    name: 'value',
    kind: 'number',
    required: false,
    help: 'The figure as your source states it, in the currency named below. Fill this or value_usd, or both.',
    nonNegative: true,
    example: '',
  },
  {
    name: 'currency',
    kind: 'currency',
    required: false,
    help: 'ISO 4217 code for the value column, such as USD, EUR, GHS. Required whenever value is filled and value_usd is not. Never assumed: a bare figure could be any currency.',
    example: '',
  },
  {
    name: 'value_usd',
    kind: 'number',
    required: false,
    help: 'The figure in US dollars. Fill this where your source publishes dollars, or where you have converted it yourself. Rows without it are stored but are not counted in trade totals, which are dollar based.',
    nonNegative: true,
    example: '412300000',
  },
  {
    name: 'exchange_rate',
    kind: 'number',
    required: false,
    help: 'Local currency units per US dollar, if you converted the value yourself. Recording the rate you used is what makes the conversion checkable rather than a number that appeared from nowhere.',
    nonNegative: true,
    example: '',
  },
  {
    name: 'quantity',
    kind: 'number',
    required: false,
    help: 'How much was traded, in the unit below. Optional, but it is what makes a price per tonne possible.',
    nonNegative: true,
    example: '365048000',
  },
  {
    name: 'quantity_unit',
    kind: 'unit',
    required: false,
    help: 'Unit for the quantity.',
    accepts: ['kg', 'tonnes', 'litres', 'units', 'items', 'm3', 'barrels', 'carats', 'pairs', 'dozens'],
    acceptsOpen: true,
    example: 'kg',
  },
  ...SOURCE_COLUMNS,
];

const INDICATOR_BASE: ColumnSpec[] = [
  {
    name: 'country_iso3',
    kind: 'iso3',
    required: true,
    help: 'Three-letter ISO 3166 code. Must match the country you are uploading against.',
    example: 'GHA',
  },
  {
    name: 'year',
    kind: 'year',
    required: true,
    help: 'Year the observation refers to.',
    example: '2024',
  },
  {
    name: 'indicator_code',
    kind: 'code',
    required: true,
    help: 'Code from the indicator list in the admin page, such as POP_TOTAL. A code not on the list is accepted with a warning rather than refused, because a country may track something the list does not.',
    example: 'POP_TOTAL',
  },
  {
    name: 'indicator_name',
    kind: 'text',
    required: false,
    help: 'Readable name. Filled from the catalogue when you leave it blank.',
    example: 'Total population',
  },
  {
    name: 'value',
    kind: 'number',
    required: true,
    help: 'The figure. Use a plain number: no thousands separators, no percent sign, no currency symbol.',
    example: '34121985',
  },
  {
    name: 'unit',
    kind: 'unit',
    required: true,
    help: 'What the figure counts. Getting this wrong is the most common way an indicator ends up a hundred or a thousand times out.',
    accepts: [
      'persons', 'percent', 'index', 'years', 'currency', 'ratio', 'count',
      'per_1000', 'per_100', 'persons_per_km2', 'days', 'percent_of_gdp',
      'currency_per_kwh', 'currency_per_worker', 'km_per_100km2', 'teu',
    ],
    acceptsOpen: true,
    example: 'persons',
  },
];

export const DATASETS: Record<DatasetCode, DatasetSpec> = {
  imports: {
    code: 'imports',
    name: 'Imports',
    target: 'trade',
    description:
      'Goods and services bought from abroad, by partner and product. These rows join the same table the trade analysis already reads, so they appear in the existing charts without any further step.',
    refresh: 'Annual. Most agencies publish three to nine months after the year ends.',
    fixedFlow: 'import',
    columns: TRADE_COLUMNS('import'),
    logicalKey: ['year', 'period', 'flow', 'stream', 'partner_iso3', 'hs_code', 'sector_code'],
    notes: [
      'One row per partner and product. A row with both left blank is the country total.',
      'Do not put a chapter total and its products in the same file. They describe the same trade at two levels and anything summing the file would count it twice.',
      'A row without value_usd is kept, but trade totals are computed in dollars and will not include it.',
    ],
  },
  exports: {
    code: 'exports',
    name: 'Exports',
    target: 'trade',
    description:
      'Goods and services sold abroad. Identical to the imports sheet with the direction reversed, kept as a separate file so one cannot be pasted into the other by accident.',
    refresh: 'Annual. Most agencies publish three to nine months after the year ends.',
    fixedFlow: 'export',
    columns: TRADE_COLUMNS('export'),
    logicalKey: ['year', 'period', 'flow', 'stream', 'partner_iso3', 'hs_code', 'sector_code'],
    notes: [
      'One row per partner and product. A row with both left blank is the country total.',
      'Do not mix HS levels in one file.',
      'A row without value_usd is kept, but trade totals are computed in dollars and will not include it.',
    ],
  },
  demographics: {
    code: 'demographics',
    name: 'Population and demographics',
    target: 'indicator',
    description:
      'Population, age structure, labour, education, health and connectivity. One row per indicator, year and breakdown.',
    refresh: 'Annual, with the most detail in census years.',
    columns: [
      ...INDICATOR_BASE,
      {
        name: 'sex',
        kind: 'enum',
        required: false,
        help: 'Leave blank for a total across both. Only fill it when the figure really is for one sex.',
        accepts: ['male', 'female', 'total'],
        example: '',
      },
      {
        name: 'age_group',
        kind: 'text',
        required: false,
        help: 'Such as 15-24 or 65+. Blank means all ages.',
        example: '',
      },
      {
        name: 'region',
        kind: 'text',
        required: false,
        help: 'Sub-national area. Blank means the whole country.',
        example: '',
      },
      {
        name: 'urban_rural',
        kind: 'enum',
        required: false,
        help: 'Blank means both together.',
        accepts: ['urban', 'rural', 'total'],
        example: '',
      },
      ...SOURCE_COLUMNS,
      {
        name: 'notes',
        kind: 'text',
        required: false,
        help: 'Anything a reader needs to interpret the figure: a definition, a break in the series, a revision.',
        example: '',
      },
    ],
    logicalKey: ['year', 'indicator_code', 'sex', 'age_group', 'region', 'urban_rural'],
    notes: [
      'A national total and its breakdowns can both be in the file. They are different rows because the breakdown columns differ, and nothing sums them together.',
      'Percentages are checked against the range the indicator allows. A share entered as 0.62 where the unit says percent is flagged, because it is almost always meant to be 62.',
    ],
  },
  income: {
    code: 'income',
    name: 'Household income and consumption',
    target: 'indicator',
    description:
      'Income, spending, poverty, inequality and prices. Carries a currency and a price basis, because a nominal figure and a real one are not comparable and the difference is invisible once stored.',
    refresh: 'Annual for prices. Household surveys often run every three to five years.',
    columns: [
      ...INDICATOR_BASE,
      {
        name: 'currency',
        kind: 'currency',
        required: false,
        help: 'ISO 4217 code. Required whenever the unit is currency, or the figure means nothing.',
        example: 'GHS',
      },
      {
        name: 'price_basis',
        kind: 'enum',
        required: false,
        help: 'nominal is money of the day. real is inflation adjusted, and needs a base year in notes. ppp is purchasing power adjusted. Comparing across these silently is a common and serious error.',
        accepts: ['nominal', 'real', 'ppp'],
        example: 'nominal',
      },
      {
        name: 'income_group',
        kind: 'text',
        required: false,
        help: 'Such as bottom-20 or top-10, for income share rows.',
        example: '',
      },
      {
        name: 'region',
        kind: 'text',
        required: false,
        help: 'Blank means the whole country.',
        example: '',
      },
      ...SOURCE_COLUMNS,
      {
        name: 'notes',
        kind: 'text',
        required: false,
        help: 'The poverty line used, the survey, the base year for a real series.',
        example: '',
      },
    ],
    logicalKey: ['year', 'indicator_code', 'income_group', 'region', 'price_basis'],
    notes: [
      'Say which currency and which price basis. A median income of 4,500 means nothing without both.',
      'The Gini coefficient is accepted on either the 0 to 1 or the 0 to 100 scale. State which in the unit column.',
    ],
  },
  sectors: {
    code: 'sectors',
    name: 'Economic sectors',
    target: 'sector',
    description:
      'Sector and subsector output, share of GDP, growth, employment and trade. Several measures for the same sector year sit on one row, because they describe one thing.',
    refresh: 'Annual, with the national accounts.',
    columns: [
      {
        name: 'country_iso3',
        kind: 'iso3',
        required: true,
        help: 'Three-letter ISO 3166 code.',
        example: 'GHA',
      },
      { name: 'year', kind: 'year', required: true, help: 'Year the figures cover.', example: '2024' },
      {
        name: 'sector_code',
        kind: 'code',
        required: true,
        help: 'From the sector list in the admin page, such as agriculture or manufacturing.',
        example: 'agriculture',
      },
      { name: 'sector_name', kind: 'text', required: false, help: 'Readable name.', example: 'Agriculture' },
      { name: 'subsector_code', kind: 'code', required: false, help: 'Optional finer breakdown.', example: '' },
      { name: 'subsector_name', kind: 'text', required: false, help: 'Readable name.', example: '' },
      {
        name: 'value',
        kind: 'number',
        required: false,
        help: 'Sector output or value added, in the currency below.',
        nonNegative: true,
        example: '89400000000',
      },
      {
        name: 'unit',
        kind: 'unit',
        required: false,
        help: 'What value counts.',
        accepts: ['currency', 'index', 'persons', 'percent'],
        acceptsOpen: true,
        example: 'currency',
      },
      { name: 'currency', kind: 'currency', required: false, help: 'ISO 4217 code, required when unit is currency.', example: 'GHS' },
      {
        name: 'share_of_gdp',
        kind: 'ratio',
        required: false,
        help: 'Percent of GDP, 0 to 100. Shares across all sectors in a year are checked to see whether they add up, and flagged when they do not.',
        min: 0,
        max: 100,
        example: '21.4',
      },
      { name: 'growth_rate', kind: 'number', required: false, help: 'Percent change on the previous year. Negative is allowed.', min: -100, max: 1000, example: '3.2' },
      { name: 'employment', kind: 'number', required: false, help: 'People employed in the sector.', nonNegative: true, example: '3900000' },
      { name: 'employment_share', kind: 'ratio', required: false, help: 'Percent of total employment, 0 to 100.', min: 0, max: 100, example: '32.1' },
      { name: 'exports_value', kind: 'number', required: false, help: 'Sector exports, same currency as value.', nonNegative: true, example: '' },
      { name: 'imports_value', kind: 'number', required: false, help: 'Sector imports, same currency as value.', nonNegative: true, example: '' },
      ...SOURCE_COLUMNS,
      { name: 'notes', kind: 'text', required: false, help: 'Definitions, revisions, anything a reader needs.', example: '' },
    ],
    logicalKey: ['year', 'sector_code', 'subsector_code'],
    notes: [
      'One row per sector year. Put several measures on the same row rather than repeating the sector.',
      'Leave a measure blank where you do not have it. A blank is read as not reported, which is different from zero.',
    ],
  },
  investment: {
    code: 'investment',
    name: 'Other investment indicators',
    target: 'indicator',
    description:
      'Infrastructure, business environment, stability, risk and investment flows. The general sheet for anything the other five do not cover.',
    refresh: 'Varies by indicator. Most are annual.',
    columns: [
      ...INDICATOR_BASE,
      {
        name: 'category',
        kind: 'enum',
        required: false,
        help: 'Groups the indicator in the report. Filled from the catalogue when you leave it blank.',
        accepts: [
          'macro', 'demographics', 'labour', 'infrastructure', 'digital', 'trade',
          'finance', 'regulation', 'governance', 'risk', 'resources', 'climate',
          'health', 'education', 'consumer', 'investment',
        ],
        example: 'infrastructure',
      },
      { name: 'currency', kind: 'currency', required: false, help: 'ISO 4217 code, required when the unit is currency.', example: '' },
      ...SOURCE_COLUMNS,
      {
        name: 'confidence',
        kind: 'ratio',
        required: false,
        help: 'How much you trust this figure, 0 to 1. Blank means you did not say, which is not the same as certain. It is carried into the report so a recommendation can show what it rests on.',
        min: 0,
        max: 1,
        example: '0.8',
      },
      { name: 'notes', kind: 'text', required: false, help: 'Method, caveats, why the figure is what it is.', example: '' },
    ],
    logicalKey: ['year', 'indicator_code', 'category'],
    notes: [
      'Use the indicator codes from the admin page where one fits. A code nobody recognises still loads, with a warning, so it will not appear in the standard charts.',
      'Fill confidence where you know it. It is the difference between a report that says how sure it is and one that implies certainty it does not have.',
    ],
  },
};

export const DATASET_CODES = Object.keys(DATASETS) as DatasetCode[];

export function datasetSpec(code: string): DatasetSpec | null {
  return (DATASETS as Record<string, DatasetSpec>)[code] ?? null;
}

/** Column names an administrator must supply, for the missing-column check. */
export function requiredColumns(spec: DatasetSpec): string[] {
  return spec.columns.filter((c) => c.required).map((c) => c.name);
}
