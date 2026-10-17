export type ByproductKind = 'processed' | 'residue' | 'byproduct' | 'downstream';
export type KbConfidence = 'verified' | 'plausible' | 'unverified' | 'rejected';
export type KbStatus = 'established' | 'possible' | 'rejected';

/** One relationship row from the knowledge base (D1 table kb_relationship). Nothing about it is hardcoded here. */
export interface KbRow {
  id: string;
  parent_name: string;
  parent_code: string | null;
  byproduct_name: string;
  byproduct_code: string | null;
  kind: ByproductKind;
  process_method: string | null;
  applications: string | null;
  /** 0 until the process and applications text is tied to a cited source. */
  detail_sourced: number;
  status: KbStatus;
  confidence: KbConfidence;
  byproduct_hs_official: string | null;
  hs_codes_checked: number;
  derivation_checked: number;
  trade_evidence_usd: number | null;
  trade_evidence_year: number | null;
  trade_evidence_note: string | null;
  evidence_note: string | null;
  source_name: string | null;
  source_url: string | null;
  verified_at: string;
}

export interface Relationships {
  /** The parent code that matched, 6 digits when a line-level relationship exists, else the heading. */
  parent_code: string | null;
  active: KbRow[];
  /** Relationships that were checked and found wrong. They are listed so they are not quietly re-added. */
  rejected: KbRow[];
}

/**
 * The relationships that apply to a product. A parent code matches when the product's code starts with it, and the
 * most specific match wins, so a line-level relationship (cashew in shell) is not mixed with a heading-level one.
 */
export function relationshipsFor(rows: KbRow[], hs: string): Relationships {
  const matched = rows.filter((r) => r.parent_code && hs.startsWith(r.parent_code));
  if (!matched.length) return { parent_code: null, active: [], rejected: [] };
  const longest = Math.max(...matched.map((r) => (r.parent_code as string).length));
  const level = matched.filter((r) => (r.parent_code as string).length === longest);
  const seen = new Set<string>();
  const uniq = level.filter((r) => {
    const k = `${r.status === 'rejected' ? 'x' : 'a'}|${r.byproduct_code ?? r.byproduct_name}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  return {
    parent_code: level[0].parent_code,
    active: uniq.filter((r) => r.status !== 'rejected'),
    rejected: uniq.filter((r) => r.status === 'rejected'),
  };
}

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
  code: string;
  exports_usd: number | null;
  imports_usd: number | null;
}

export interface ByproductRow extends KbRow {
  exports_usd: number | null;
  imports_usd: number | null;
  /** By-product exports over main exports. */
  ratio: number | null;
  verdict: ByproductVerdict;
  reason: string;
}

export interface ByproductAnalysis {
  main_code: string;
  main_exports_usd: number | null;
  thresholds: ByproductThresholds;
  eligible: boolean;
  rows: ByproductRow[];
  /** Relationships from an earlier list that the checks showed to be wrong. */
  unsupported: KbRow[];
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
 * Checks each knowledge-base by-product of a country's main commodity against the country's own trade: does it
 * import the by-product while exporting the raw good (a domestic demand gap), or export very little of it compared
 * with the raw good (under-processed). Where the data holds neither flow, or the by-product has no code, the row says so.
 */
export function byproductAnalysis(
  mainCode: string,
  mainExportsUsd: number | null,
  data: ByproductInput[],
  rel: Relationships,
  thresholds: Partial<ByproductThresholds> = {},
): ByproductAnalysis {
  const t = clampThresholds(thresholds);
  const byCode = new Map(data.map((d) => [d.code, d]));
  const eligible = mainExportsUsd != null && mainExportsUsd >= t.min_main_usd;

  const rows: ByproductRow[] = rel.active.map((c) => {
    if (!c.byproduct_code) {
      return { ...c, exports_usd: null, imports_usd: null, ratio: null, verdict: 'no-data' as const, reason: 'This by-product has no confirmed HS code, so its trade cannot be checked.' };
    }
    const d = byCode.get(c.byproduct_code);
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

  const chapter = mainCode.slice(0, 2);
  const services = eligible ? SERVICE_IDEAS.filter((s) => s.chapters.includes(chapter)).map(({ title, note }) => ({ title, note })) : [];

  const limitations = [
    "The relationships come from Tereflow's product knowledge base. Each is checked against the official HS wording and recorded trade. 'Verified' means the by-product's official wording states the derivation; 'plausible' means both codes exist but the wording does not.",
    'The process and applications text is general knowledge and is not yet tied to a cited source. Not every residue can be processed or sold at a profit.',
    'A gap in the numbers is a lead to check, not proof of a business. Imports can be re-exported, quality can differ, and a small export may reflect cost or policy.',
    'Service ideas come from the type of goods and are not measured. No logistics cost or capacity data is held.',
  ];
  if (!rel.active.length) limitations.unshift('No by-products are in the knowledge base yet for this product, so no suggestion is made.');

  return { main_code: mainCode, main_exports_usd: mainExportsUsd, thresholds: t, eligible, rows, unsupported: rel.rejected, services, limitations };
}