export type ByproductKind = 'processing' | 'residue' | 'service';

export interface ByproductCandidate {
  hs4: string;
  name: string;
  kind: ByproductKind;
  note: string;
}

/**
 * Curated by Tereflow, not derived from data: which goods are made from, or out of the waste of, a main
 * commodity. Keyed by the 4-digit HS heading of the main commodity. A missing key means no suggestion is
 * made; nothing is guessed.
 */
export const BYPRODUCTS_BY_HS4: Record<string, ByproductCandidate[]> = {
  '1801': [
    { hs4: '1802', name: 'Cocoa shells and husks', kind: 'residue', note: 'Waste of bean processing; used as mulch, fuel and fibre.' },
    { hs4: '1803', name: 'Cocoa paste', kind: 'processing', note: 'First processing step after the bean.' },
    { hs4: '1804', name: 'Cocoa butter, fat and oil', kind: 'processing', note: 'Pressed from paste; high value per tonne.' },
    { hs4: '1805', name: 'Cocoa powder', kind: 'processing', note: 'What remains after the butter is pressed out.' },
  ],
  '0901': [
    { hs4: '2101', name: 'Coffee extracts and instant coffee', kind: 'processing', note: 'Soluble coffee made from roasted beans.' },
  ],
  '0804': [
    { hs4: '2009', name: 'Fruit juices', kind: 'processing', note: 'Juice and concentrate from fruit that misses fresh-market grade.' },
    { hs4: '2008', name: 'Prepared and preserved fruit', kind: 'processing', note: 'Pulp, canned and dried products.' },
    { hs4: '2007', name: 'Jams, purees and fruit pastes', kind: 'processing', note: 'Cooked fruit products.' },
  ],
  '0803': [
    { hs4: '2008', name: 'Prepared and preserved fruit', kind: 'processing', note: 'Includes dried banana and banana products.' },
    { hs4: '1106', name: 'Flour of fruit and roots', kind: 'processing', note: 'Includes banana and plantain flour.' },
  ],
  '0805': [
    { hs4: '2009', name: 'Fruit juices', kind: 'processing', note: 'Citrus juice and concentrate.' },
    { hs4: '3301', name: 'Essential oils', kind: 'residue', note: 'Citrus peel oil is a by-product of juicing.' },
  ],
  '1207': [
    { hs4: '1515', name: 'Other vegetable fats and oils', kind: 'processing', note: 'Includes shea butter.' },
    { hs4: '2306', name: 'Oilcake and other oil-extraction residue', kind: 'residue', note: 'Animal feed from what is left after pressing.' },
  ],
  '1202': [
    { hs4: '1508', name: 'Groundnut oil', kind: 'processing', note: 'Pressed from the nut.' },
    { hs4: '2305', name: 'Groundnut oilcake', kind: 'residue', note: 'Animal feed from the pressed residue.' },
  ],
  '1201': [
    { hs4: '1507', name: 'Soya-bean oil', kind: 'processing', note: 'Pressed from the bean.' },
    { hs4: '2304', name: 'Soya-bean oilcake', kind: 'residue', note: 'High-protein animal feed from the residue.' },
  ],
  '1511': [
    { hs4: '1513', name: 'Coconut and palm kernel oil', kind: 'processing', note: 'Pressed from the kernel, a separate oil from palm oil.' },
    { hs4: '2306', name: 'Oilcake and other oil-extraction residue', kind: 'residue', note: 'Palm kernel cake is used as feed.' },
  ],
  '0801': [
    { hs4: '1513', name: 'Coconut oil', kind: 'processing', note: 'Pressed from copra.' },
    { hs4: '5305', name: 'Coconut fibre (coir)', kind: 'residue', note: 'Husk fibre used in ropes, mats and growing media.' },
  ],
  '5201': [
    { hs4: '1512', name: 'Cottonseed oil', kind: 'processing', note: 'Pressed from the seed left after ginning.' },
    { hs4: '5202', name: 'Cotton waste', kind: 'residue', note: 'Waste from spinning and ginning.' },
    { hs4: '2306', name: 'Oilcake and other oil-extraction residue', kind: 'residue', note: 'Cottonseed cake as animal feed.' },
  ],
  '1006': [
    { hs4: '2302', name: 'Bran and milling residues', kind: 'residue', note: 'Rice bran from milling; used as feed.' },
    { hs4: '1102', name: 'Cereal flours other than wheat', kind: 'processing', note: 'Includes rice flour.' },
  ],
  '1005': [
    { hs4: '1108', name: 'Starches', kind: 'processing', note: 'Maize starch.' },
    { hs4: '2303', name: 'Starch-making residues', kind: 'residue', note: 'Maize gluten and germ cake, used as feed.' },
  ],
  '0714': [
    { hs4: '1108', name: 'Starches', kind: 'processing', note: 'Cassava starch.' },
    { hs4: '1106', name: 'Flour of roots and tubers', kind: 'processing', note: 'Cassava and yam flour.' },
  ],
  '1701': [
    { hs4: '1703', name: 'Molasses', kind: 'residue', note: 'Left after sugar is crystallised.' },
    { hs4: '2303', name: 'Sugar-making residues', kind: 'residue', note: 'Bagasse and beet pulp.' },
    { hs4: '2207', name: 'Ethyl alcohol', kind: 'processing', note: 'Ethanol is fermented from molasses.' },
  ],
  '0303': [
    { hs4: '2301', name: 'Fish meal and flours', kind: 'residue', note: 'Made from fish waste and low-grade catch.' },
    { hs4: '1504', name: 'Fish oils and fats', kind: 'residue', note: 'Pressed from fish and offcuts.' },
  ],
  '4403': [
    { hs4: '4407', name: 'Wood sawn or chipped lengthwise', kind: 'processing', note: 'Sawn timber from round logs.' },
    { hs4: '4410', name: 'Particle board', kind: 'residue', note: 'Made from chips and sawmill waste.' },
    { hs4: '4402', name: 'Wood charcoal', kind: 'residue', note: 'Made from offcuts and waste wood.' },
  ],
  '4101': [
    { hs4: '4104', name: 'Tanned or crust hides and skins', kind: 'processing', note: 'First step after raw hides.' },
  ],
  '0702': [
    { hs4: '2002', name: 'Prepared or preserved tomatoes', kind: 'processing', note: 'Paste and canned tomatoes.' },
  ],
};

/** Service ideas by HS chapter of the main commodity. These come from the type of goods, not from trade data. */
const SERVICE_IDEAS: { chapters: string[]; title: string; note: string }[] = [
  { chapters: ['02', '03', '04', '06', '07', '08'], title: 'Cold chain, packhouse and reefer transport', note: 'Perishable goods lose value with delay and heat.' },
  { chapters: ['09', '10', '11', '12', '17', '18'], title: 'Graded storage, drying and bulk handling', note: 'Dry commodities need warehousing, fumigation and quality grading.' },
  { chapters: ['44', '52'], title: 'Inland haulage, yard and consolidation', note: 'Bulky goods are priced heavily by the cost of moving them to port.' },
];

export interface ByproductThresholds {
  /** Main export value below this, in US dollars, and no suggestion is made. */
  min_main_usd: number;
  /** By-product exports below this share of main exports count as under-processed. */
  under_ratio: number;
  /** Country imports of the by-product above this, in US dollars, count as a domestic demand gap. */
  import_gap_usd: number;
}

export const DEFAULT_THRESHOLDS: ByproductThresholds = {
  min_main_usd: 5_000_000,
  under_ratio: 0.1,
  import_gap_usd: 500_000,
};

export type ByproductVerdict = 'import-gap' | 'under-processed' | 'covered' | 'no-data';

export interface ByproductInput {
  hs4: string;
  exports_usd: number | null;
  imports_usd: number | null;
}

export interface ByproductRow extends ByproductCandidate {
  exports_usd: number | null;
  imports_usd: number | null;
  /** By-product exports over main exports. */
  ratio: number | null;
  verdict: ByproductVerdict;
  reason: string;
}

export interface ByproductAnalysis {
  main_hs4: string;
  main_exports_usd: number | null;
  thresholds: ByproductThresholds;
  eligible: boolean;
  rows: ByproductRow[];
  services: { title: string; note: string }[];
  limitations: string[];
}

const usd = (n: number) => '$' + (n >= 1e9 ? (n / 1e9).toFixed(1) + 'B' : n >= 1e6 ? (n / 1e6).toFixed(1) + 'M' : Math.round(n / 1e3) + 'K');

export function clampThresholds(t: Partial<ByproductThresholds>): ByproductThresholds {
  const d = DEFAULT_THRESHOLDS;
  const pick = (v: unknown, lo: number, hi: number, dflt: number) => {
    const n = Number(v);
    return Number.isFinite(n) && n >= lo && n <= hi ? n : dflt;
  };
  return {
    min_main_usd: pick(t.min_main_usd, 0, 1e12, d.min_main_usd),
    under_ratio: pick(t.under_ratio, 0, 1, d.under_ratio),
    import_gap_usd: pick(t.import_gap_usd, 0, 1e12, d.import_gap_usd),
  };
}

/**
 * Looks at a country's main commodity and checks each curated by-product against the country's own trade:
 * does it import the by-product while exporting the raw good (a domestic demand gap), or export very little
 * of it compared with the raw good (under-processed). Where the data holds neither flow the row says so.
 */
export function byproductAnalysis(
  mainHs: string,
  mainExportsUsd: number | null,
  data: ByproductInput[],
  thresholds: Partial<ByproductThresholds> = {},
): ByproductAnalysis {
  const t = clampThresholds(thresholds);
  const hs4 = mainHs.slice(0, 4);
  const candidates = BYPRODUCTS_BY_HS4[hs4] ?? [];
  const byHs = new Map(data.map((d) => [d.hs4, d]));
  const eligible = mainExportsUsd != null && mainExportsUsd >= t.min_main_usd;

  const rows: ByproductRow[] = candidates.map((c) => {
    const d = byHs.get(c.hs4);
    const ex = d?.exports_usd ?? null;
    const im = d?.imports_usd ?? null;
    const ratio = eligible && ex != null && mainExportsUsd ? ex / mainExportsUsd : null;
    let verdict: ByproductVerdict;
    let reason: string;
    if (ex == null && im == null) {
      verdict = 'no-data';
      reason = 'The country has no trade recorded in this heading, so nothing can be said from the data.';
    } else if (!eligible) {
      verdict = 'covered';
      reason = `Main exports are below the ${usd(t.min_main_usd)} threshold, so no gap is claimed.`;
    } else if (ratio != null && ratio >= t.under_ratio) {
      verdict = 'covered';
      reason = `Exports of this are ${(ratio * 100).toFixed(1)}% of the raw good's exports, above the ${(t.under_ratio * 100).toFixed(0)}% line, so the country already makes it at scale.`;
    } else if (im != null && im >= t.import_gap_usd) {
      verdict = 'import-gap';
      reason = `The country makes little of this (exports ${ratio != null ? (ratio * 100).toFixed(1) + '% of the raw good' : 'negligible'}) yet imported ${usd(im)}, against ${usd(mainExportsUsd as number)} of raw exports.`;
    } else if (ratio != null) {
      verdict = 'under-processed';
      reason = `Exports of this are ${(ratio * 100).toFixed(1)}% of the raw good's exports, below the ${(t.under_ratio * 100).toFixed(0)}% line.`;
    } else {
      verdict = 'covered';
      reason = 'Within the thresholds.';
    }
    return { ...c, exports_usd: ex, imports_usd: im, ratio, verdict, reason };
  });

  const chapter = hs4.slice(0, 2);
  const services = eligible ? SERVICE_IDEAS.filter((s) => s.chapters.includes(chapter)).map(({ title, note }) => ({ title, note })) : [];

  const limitations = [
    'The list of by-products for each commodity is curated by Tereflow from how the goods are made. It is not drawn from the trade data, and it is not complete.',
    'A gap in the numbers is a lead to check, not proof of a business. Imports can be re-exported, quality can differ, and a small export may reflect cost or policy.',
    'Service ideas come from the type of goods and are not measured. No logistics cost or capacity data is held.',
  ];
  if (!candidates.length) limitations.unshift('No by-products are listed yet for this heading, so no suggestion is made.');

  return { main_hs4: hs4, main_exports_usd: mainExportsUsd, thresholds: t, eligible, rows, services, limitations };
}
