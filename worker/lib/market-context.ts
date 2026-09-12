import type { D1Database } from '@cloudflare/workers-types';

/**
 * Market context: who lives here, what they earn, what they spend, and what
 * the economy is made of.
 *
 * This answers the question an investor asks before the trade figures mean
 * anything. Ghana importing $837m of vehicles is a fact; whether that is a
 * market you can sell into depends on 35 million people, 59% of them urban,
 * on $1,728 of household consumption a head.
 *
 * EVERY FIGURE CARRIES ITS YEAR, AND THE SPREAD IS REPORTED
 *
 * The World Bank publishes these series on different cycles. Ghana's population
 * is 2025 and its Gini is 2016, because the last household survey was nine
 * years ago. Printing both without their years would present a nine-year-old
 * inequality figure as current, which is the kind of mistake that does not look
 * like one. So each figure states its year, and anything materially older than
 * the rest is flagged rather than quietly mixed in.
 */

/** Years behind the newest figure before a reading is called out as old. */
const STALE_GAP_YEARS = 3;

export interface ContextFigure {
  code: string;
  label: string;
  /** What it measures, in the terms a reader would ask the question. */
  meaning: string;
  value: number;
  unit: string;
  year: number;
  /** Set when this figure is materially older than the newest in the set. */
  stale_note: string | null;
  /** Same series over time, oldest first. Empty when only one year exists. */
  history: { year: number; value: number }[];
  source_url: string | null;
}

export interface ContextGroup {
  key: string;
  title: string;
  /** Why an investor would care about this group. */
  purpose: string;
  figures: ContextFigure[];
}

export interface MarketContext {
  groups: ContextGroup[];
  /** The newest year anything in the set was filed. */
  latest_year: number;
  /** Named series that are older than the rest, so the gap is stated once up front. */
  stale_figures: string[];
  /** Series this country does not publish. Absent, not zero. */
  not_published: string[];
  source_name: string;
}

interface Row {
  indicator_code: string;
  category: string | null;
  year: number;
  value: number;
  unit: string | null;
  source_url: string | null;
}

/**
 * What each code means in plain terms.
 *
 * The label is what it is called; the meaning is why somebody deciding where to
 * put money would look at it. "GNI per capita" and "income of the whole economy
 * divided by heads, which is not what a household earns" are different amounts
 * of honesty about the same number.
 */
const FIGURES: Record<string, { label: string; meaning: string; group: string }> = {
  POP_TOTAL: { label: 'Population', meaning: 'How many people there are to sell to.', group: 'people' },
  POP_GROWTH: { label: 'Population growth', meaning: 'Whether that number is rising, and how fast.', group: 'people' },
  POP_URBAN_SHARE: {
    label: 'Urban share',
    meaning: 'How concentrated the market is. Distribution costs turn on this.',
    group: 'people',
  },
  POP_DENSITY: { label: 'Density', meaning: 'People per square kilometre.', group: 'people' },
  AGE_DEPENDENCY: {
    label: 'Dependency ratio',
    meaning: 'Dependants per hundred working-age people. High means fewer earners carrying more.',
    group: 'people',
  },
  POP_WORKING_AGE: { label: 'Working age', meaning: 'People aged 15 to 64.', group: 'people' },

  HH_CONSUMPTION_PC: {
    label: 'Household spending a head',
    meaning: 'What one person actually spends in a year. The closest thing here to purchasing power.',
    group: 'money',
  },
  HH_CONSUMPTION: {
    label: 'Household spending, total',
    meaning: 'Everything households spend, across the whole country.',
    group: 'money',
  },
  GNI_PER_CAPITA: {
    label: 'GNI per head',
    meaning:
      'Income of the whole economy divided by population. Includes company and government income, so it is not what a household earns.',
    group: 'money',
  },
  POVERTY_RATE: {
    label: 'Poverty rate',
    meaning: 'Share below the national poverty line. Measured by household survey, so it updates rarely.',
    group: 'money',
  },
  POVERTY_EXTREME: { label: 'Extreme poverty', meaning: 'Share below the international extreme-poverty line.', group: 'money' },
  GINI: {
    label: 'Income inequality',
    meaning: 'Gini index, 0 to 100. Higher means income is concentrated in fewer hands.',
    group: 'money',
  },

  GDP: { label: 'GDP', meaning: 'Size of the whole economy.', group: 'economy' },
  GDP_PER_CAPITA: { label: 'GDP per head', meaning: 'Economic output per person.', group: 'economy' },
  GDP_GROWTH: { label: 'GDP growth', meaning: 'How fast the economy is expanding.', group: 'economy' },
  INFLATION: { label: 'Inflation', meaning: 'How fast prices are rising. Erodes margin and pricing.', group: 'economy' },
  GDP_AGRI_SHARE: { label: 'Agriculture', meaning: 'Share of the economy from farming, forestry and fishing.', group: 'economy' },
  GDP_INDUSTRY_SHARE: {
    label: 'Industry',
    meaning: 'Share from mining, manufacturing, construction and utilities together.',
    group: 'economy',
  },
  GDP_SERVICES_SHARE: { label: 'Services', meaning: 'Share from everything else, retail through to finance.', group: 'economy' },

  LFP_RATE: { label: 'Labour participation', meaning: 'Share of working-age people in or seeking work.', group: 'work' },
  UNEMPLOYMENT: { label: 'Unemployment', meaning: 'Share of the labour force without work.', group: 'work' },
  UNEMPLOYMENT_YOUTH: { label: 'Youth unemployment', meaning: 'Same measure, for 15 to 24 year olds.', group: 'work' },

  ELECTRICITY_ACCESS: {
    label: 'Electricity access',
    meaning: 'Share of people with power. Anything needing refrigeration or machinery turns on this.',
    group: 'operating',
  },
  INTERNET_USERS: { label: 'Internet use', meaning: 'Share of people online. Sets the ceiling on anything sold digitally.', group: 'operating' },
  MOBILE_SUBS: { label: 'Mobile subscriptions', meaning: 'Per hundred people. Often above 100 where people hold two lines.', group: 'operating' },
  FDI_INFLOW: { label: 'Foreign investment', meaning: 'Direct investment arriving each year.', group: 'operating' },
  CREDIT_PRIVATE: {
    label: 'Private credit',
    meaning: 'Bank lending to business as a share of GDP. Low means working capital is hard to raise locally.',
    group: 'operating',
  },
};

const GROUPS: { key: string; title: string; purpose: string }[] = [
  { key: 'people', title: 'The people', purpose: 'How many, where they live, and how many of them earn.' },
  { key: 'money', title: 'What they have to spend', purpose: 'Income and spending power, and how evenly it is spread.' },
  { key: 'economy', title: 'What the economy does', purpose: 'Size, growth, and the split between farming, industry and services.' },
  { key: 'work', title: 'Work', purpose: 'Whether there is labour to hire and at what level of demand.' },
  { key: 'operating', title: 'Operating conditions', purpose: 'Power, connectivity and credit: whether a business can physically run.' },
];

export async function loadMarketContext(
  db: D1Database,
  entityId: string,
): Promise<MarketContext | null> {
  const { results } = await db
    .prepare(
      `SELECT indicator_code, category, year, value, unit, source_url
         FROM indicator_observations
        WHERE entity_id = ?1
        ORDER BY indicator_code, year`,
    )
    .bind(entityId)
    .all<Row>();

  const rows = results ?? [];
  if (rows.length === 0) return null;

  const bySeries = new Map<string, Row[]>();
  for (const r of rows) {
    const list = bySeries.get(r.indicator_code);
    if (list) list.push(r);
    else bySeries.set(r.indicator_code, [r]);
  }

  // The newest figure anywhere sets the reference point. Everything is compared
  // against that rather than against the current calendar year, because a
  // dataset that ends in 2024 is not stale, it is just what exists.
  let latestYear = 0;
  for (const series of bySeries.values()) {
    const newest = series[series.length - 1];
    if (newest.year > latestYear) latestYear = newest.year;
  }

  const figures: ContextFigure[] = [];
  const stale: string[] = [];

  for (const [code, series] of bySeries) {
    const meta = FIGURES[code];
    if (!meta) continue;
    const newest = series[series.length - 1];
    const gap = latestYear - newest.year;
    const isStale = gap >= STALE_GAP_YEARS;
    if (isStale) stale.push(`${meta.label} (${newest.year})`);

    figures.push({
      code,
      label: meta.label,
      meaning: meta.meaning,
      value: newest.value,
      unit: newest.unit ?? '',
      year: newest.year,
      stale_note: isStale
        ? `Last measured in ${newest.year}, ${gap} years before the newest figure here. Nothing more recent has been published.`
        : null,
      history: series.map((r) => ({ year: r.year, value: r.value })),
      source_url: newest.source_url,
    });
  }

  const notPublished = Object.entries(FIGURES)
    .filter(([code]) => !bySeries.has(code))
    .map(([, meta]) => meta.label);

  const groups = GROUPS.map((g) => ({
    ...g,
    figures: figures.filter((f) => FIGURES[f.code].group === g.key),
  })).filter((g) => g.figures.length > 0);

  if (groups.length === 0) return null;

  return {
    groups,
    latest_year: latestYear,
    stale_figures: stale,
    not_published: notPublished,
    source_name: 'World Bank Open Data',
  };
}
