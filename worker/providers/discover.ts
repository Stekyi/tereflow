/**
 * Working out a country's PXWeb config from its endpoint, instead of by hand.
 *
 * Ghana's config was built manually: dimension names read off the metadata,
 * partner names matched to ISO codes one at a time (scripts/map-statbank-
 * partners.mjs), traditional exports picked by someone who knows the country.
 * That is a day's work per country and most of it is mechanical.
 *
 * This does the mechanical part and is explicit about which part it is not
 * doing. Three tiers, and the boundaries between them matter more than the
 * heuristics:
 *
 *   CERTAIN     read straight out of the metadata. No guess involved.
 *   GUESSED     inferred from shape. Shown next to the raw source values for
 *               an admin to confirm or correct. Never used in a live request
 *               before confirmation.
 *   JUDGEMENT   which products are "traditional" for this country. Not
 *               guessable from trade data at all; the most it can do is point
 *               at candidates and say why.
 *
 * Nothing here is auto-applied. `discoverCountryConfig` returns a draft plus
 * the evidence for every guess, and a caller that persists it without showing
 * a human is misusing it.
 *
 * WHAT THE REAL METADATA ACTUALLY LOOKS LIKE
 *
 * Written against Ghana's live endpoint, which breaks three assumptions that
 * sound reasonable in the abstract:
 *
 *   - PXWeb has a `time: true` flag on the time variable. Ghana sets it on
 *     nothing, including Year. So it is used when present and shape is the
 *     fallback, not the other way round.
 *   - The valuation dimension has two values, one money and one weight. Ghana
 *     has four: cedis nominal, cedis real, US dollars, net weight in KG.
 *   - The flow dimension has two values. Ghana has three, and the extra one is
 *     "Total Trade", which is the sum of the other two. Requesting it
 *     alongside them double-counts every figure in the dataset.
 */
import { ISO3_NAME } from '../../shared/country-names';
import type { ClassificationLevel, PartnerMapping } from './types';

/** One PXWeb variable, as the metadata endpoint returns it. */
export interface PxVariable {
  code: string;
  text: string;
  values: string[];
  valueTexts: string[];
  time?: boolean;
  elimination?: boolean;
}

export interface PxMetadata {
  title: string;
  variables: PxVariable[];
}

export type DimensionRole =
  | 'valuation'
  | 'flow'
  | 'year'
  | 'month'
  | 'product'
  | 'partner'
  | 'unknown';

/** How far a guess can be trusted, and why it is only that far. */
export type Certainty = 'certain' | 'likely' | 'uncertain';

export interface DimensionGuess {
  role: DimensionRole;
  /** The PXWeb variable code, which is what a request has to send. */
  code: string;
  text: string;
  certainty: Certainty;
  /** Why this role was assigned. Shown to the admin, not just logged. */
  reason: string;
  value_count: number;
  /** Enough of the raw values to check the guess against. */
  sample_values: string[];
  /**
   * Specific values this role needs picked out, with the reason for each.
   * Empty when the role needs no individual values.
   */
  picked: { key: string; value: string | null; reason: string }[];
}

export interface DiscoveryWarning {
  severity: 'blocking' | 'check';
  message: string;
}

export interface PartnerMatch extends PartnerMapping {
  certainty: Certainty;
  reason: string;
}

export interface DiscoveryResult {
  endpoint: string;
  title: string;
  dimensions: DimensionGuess[];
  /** Source partner names matched to this application's country list. */
  partners: PartnerMatch[];
  /** Source partner names nothing could be matched to. Never silently dropped. */
  unmatched_partners: string[];
  classification_level: ClassificationLevel | null;
  classification_reason: string;
  years: string[];
  /**
   * Anything that would make a saved config wrong. Blocking ones mean the
   * endpoint cannot be used as-is.
   */
  warnings: DiscoveryWarning[];
  /** True when nothing blocking was found and every required role was assigned. */
  ready_to_confirm: boolean;
}

// --- matching helpers --------------------------------------------------------

/** Lowercase, unaccented, punctuation-free. For comparing names, not displaying them. */
function normalise(text: string): string {
  return text
    .toLowerCase()
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

/** Any of these words appearing as a whole word. */
function hasWord(text: string, words: string[]): boolean {
  const n = ` ${normalise(text)} `;
  return words.some((w) => n.includes(` ${w} `));
}

/**
 * An aggregate row: "All Products", "Total Trade", "All Partner Countries".
 *
 * These have to be found and then deliberately not used. They are the sum of
 * the other values in the same dimension, so requesting one alongside its
 * components double-counts everything, and the resulting figures look
 * plausible because they are exactly twice the truth.
 */
function isAggregate(label: string): boolean {
  const n = normalise(label);
  return /^(all|total)\b/.test(n) || n === 'world' || n === 'all countries';
}

// --- role detection ----------------------------------------------------------

const MONTHS = [
  'january', 'february', 'march', 'april', 'may', 'june',
  'july', 'august', 'september', 'october', 'november', 'december',
];

/** A label naming a monetary amount, in any currency. */
function looksLikeMoney(label: string): boolean {
  return hasWord(label, ['value', 'usd', 'dollars', 'dollar', 'amount', 'fob', 'cif']);
}

function looksLikeWeight(label: string): boolean {
  return hasWord(label, ['weight', 'kg', 'kilo', 'kilogram', 'kilogrammes', 'tonnes', 'quantity', 'volume', 'mass']);
}

/**
 * The product code prefix a label carries, if any: "07 - Edible vegetables"
 * gives "07". PXWeb writes these consistently within one dimension, which is
 * what makes the classification depth readable.
 */
function productCodePrefix(label: string): string | null {
  const m = label.match(/^\s*(\d{2,10})\s*[-–—:]\s*\S/);
  return m ? m[1] : null;
}

function depthForDigits(digits: number): ClassificationLevel | null {
  if (digits === 2) return 'HS2';
  if (digits === 4) return 'HS4';
  if (digits === 6) return 'HS6';
  if (digits >= 8) return 'HS10';
  return null;
}

/** Canonical country names, normalised once. */
const COUNTRY_INDEX: { iso3: string; name: string; norm: string }[] = Object.entries(ISO3_NAME).map(
  ([iso3, name]) => ({ iso3, name, norm: normalise(name) }),
);

/**
 * Alternative spellings that a source is entitled to use and that no amount of
 * string distance will reach. "Viet Nam" to "Vietnam" is close; "Ivory Coast"
 * to "Cote d'Ivoire" is a different set of words for the same place.
 *
 * Listed rather than inferred, because a wrong entry here silently attributes
 * one country's trade to another.
 */
const NAME_ALIASES: Record<string, string> = {
  'viet nam': 'VNM',
  'ivory coast': 'CIV',
  'cote d ivoire': 'CIV',
  'republic of korea': 'KOR',
  'korea rep': 'KOR',
  'south korea': 'KOR',
  'korea dem peoples rep': 'PRK',
  'north korea': 'PRK',
  'russian federation': 'RUS',
  'russia': 'RUS',
  'united states of america': 'USA',
  'usa': 'USA',
  'united kingdom of great britain and northern ireland': 'GBR',
  'uk': 'GBR',
  'great britain': 'GBR',
  'tanzania united republic of': 'TZA',
  'united republic of tanzania': 'TZA',
  'iran islamic republic of': 'IRN',
  'iran': 'IRN',
  'syrian arab republic': 'SYR',
  'syria': 'SYR',
  'venezuela bolivarian republic of': 'VEN',
  'bolivia plurinational state of': 'BOL',
  'moldova republic of': 'MDA',
  'macedonia': 'MKD',
  'north macedonia': 'MKD',
  'czech republic': 'CZE',
  'czechia': 'CZE',
  'swaziland': 'SWZ',
  'eswatini': 'SWZ',
  'cape verde': 'CPV',
  'cabo verde': 'CPV',
  'burma': 'MMR',
  'myanmar': 'MMR',
  'laos': 'LAO',
  'lao peoples democratic republic': 'LAO',
  'congo democratic republic of the': 'COD',
  'democratic republic of the congo': 'COD',
  'drc': 'COD',
  'congo republic of the': 'COG',
  'hong kong sar china': 'HKG',
  'hong kong': 'HKG',
  'macao': 'MAC',
  'macau': 'MAC',
  'taiwan province of china': 'TWN',
  'taiwan': 'TWN',
  'egypt arab rep': 'EGY',
  'gambia the': 'GMB',
  'bahamas the': 'BHS',
  'turkiye': 'TUR',
  'turkey': 'TUR',
  'slovak republic': 'SVK',
  'slovakia': 'SVK',
  'kyrgyz republic': 'KGZ',
  'kyrgyzstan': 'KGZ',
  'brunei darussalam': 'BRN',
  'brunei': 'BRN',
  'united arab emirates': 'ARE',
  'uae': 'ARE',
};

/**
 * One source partner name, matched to a country this application knows.
 *
 * Exact and alias matches are reported as certain. Everything else is reported
 * as uncertain even when the string distance is small, because the failure mode
 * is attributing one country's trade to another and that is not visible in any
 * downstream number.
 */
export function matchPartner(sourceName: string): PartnerMatch | null {
  const norm = normalise(sourceName);
  if (!norm) return null;

  const exact = COUNTRY_INDEX.find((c) => c.norm === norm);
  if (exact) {
    return {
      app_name: exact.name,
      source_name: sourceName,
      iso3: exact.iso3,
      certainty: 'certain',
      reason: 'Name matches the country list exactly.',
    };
  }

  const aliased = NAME_ALIASES[norm];
  if (aliased && ISO3_NAME[aliased]) {
    return {
      app_name: ISO3_NAME[aliased],
      source_name: sourceName,
      iso3: aliased,
      certainty: 'certain',
      reason: `Known alternative spelling of ${ISO3_NAME[aliased]}.`,
    };
  }

  // One name fully containing the other, which covers "Tanzania" against
  // "Tanzania, United Republic of" without reaching for edit distance.
  const contained = COUNTRY_INDEX.filter(
    (c) => c.norm.includes(norm) || norm.includes(c.norm),
  ).sort((a, b) => Math.abs(a.norm.length - norm.length) - Math.abs(b.norm.length - norm.length));

  if (contained.length === 1) {
    return {
      app_name: contained[0].name,
      source_name: sourceName,
      iso3: contained[0].iso3,
      certainty: 'likely',
      reason: `One country name contains this one: "${contained[0].name}". Confirm it is the same place.`,
    };
  }

  if (contained.length > 1) {
    return {
      app_name: contained[0].name,
      source_name: sourceName,
      iso3: contained[0].iso3,
      certainty: 'uncertain',
      reason:
        `Matches ${contained.length} countries by containment ` +
        `(${contained.slice(0, 3).map((c) => c.name).join(', ')}). Pick the right one.`,
    };
  }

  return null;
}

// --- dimension discovery -----------------------------------------------------

function pick(key: string, value: string | null, reason: string) {
  return { key, value, reason };
}

/**
 * Assigns a role to each PXWeb variable.
 *
 * Exported separately from `discoverCountryConfig` so the reasoning can be
 * tested against metadata without going near the network.
 */
export function discoverDimensions(meta: PxMetadata): DimensionGuess[] {
  const guesses: DimensionGuess[] = [];
  const usedRoles = new Set<DimensionRole>();

  for (const v of meta.variables) {
    const labels = v.valueTexts ?? v.values;
    const real = labels.filter((l) => !isAggregate(l));
    const base = {
      code: v.code,
      text: v.text || v.code,
      value_count: labels.length,
      sample_values: labels.slice(0, 5),
    };

    // --- year ---------------------------------------------------------------
    // PXWeb can flag its time variable. Ghana flags nothing, including Year, so
    // the flag is used when present and shape decides when it is not. Doing it
    // the other way round would find no year dimension on the endpoint this was
    // written against.
    if (v.time === true && !usedRoles.has('year')) {
      usedRoles.add('year');
      guesses.push({
        ...base,
        role: 'year',
        certainty: 'certain',
        reason: 'PXWeb marks this variable as the time dimension.',
        picked: [],
      });
      continue;
    }

    const allYears = real.length > 0 && real.every((l) => /^(19|20)\d{2}$/.test(l.trim()));
    if (allYears && !usedRoles.has('year')) {
      usedRoles.add('year');
      guesses.push({
        ...base,
        role: 'year',
        certainty: 'likely',
        reason:
          'Every value is a four-digit year. The metadata does not set the PXWeb time flag on any ' +
          'variable, so this was read from the values rather than declared.',
        picked: [],
      });
      continue;
    }

    // --- month --------------------------------------------------------------
    const monthHits = real.filter((l) => MONTHS.includes(normalise(l))).length;
    if (monthHits >= 6 && !usedRoles.has('month')) {
      usedRoles.add('month');
      const allMonths = labels.find((l) => isAggregate(l)) ?? null;
      guesses.push({
        ...base,
        role: 'month',
        certainty: 'certain',
        reason: `${monthHits} values are month names.`,
        picked: [
          pick(
            'all_months',
            allMonths,
            allMonths
              ? 'The whole-year aggregate. Requested instead of the twelve months, not alongside them.'
              : 'No whole-year value offered, so annual figures have to be summed from months.',
          ),
        ],
      });
      continue;
    }

    // --- valuation ----------------------------------------------------------
    // Not "has two values": Ghana has four, two of which are currency variants
    // this application does not use. What identifies the dimension is carrying
    // both a money measure and a weight measure.
    const money = real.filter(looksLikeMoney);
    const weight = real.filter(looksLikeWeight);
    if (money.length > 0 && weight.length > 0 && !usedRoles.has('valuation')) {
      usedRoles.add('valuation');
      // Prefer US dollars where offered. A local-currency series cannot be
      // compared across countries and nothing downstream converts it.
      const usd = money.find((l) => hasWord(l, ['usd', 'dollars', 'dollar'])) ?? null;
      guesses.push({
        ...base,
        role: 'valuation',
        certainty: usd ? 'likely' : 'uncertain',
        reason:
          `Carries both a monetary measure (${money.length}) and a weight measure (${weight.length}).` +
          (usd ? '' : ' No US dollar series found, so figures will not be comparable across countries.'),
        picked: [
          pick(
            'value_usd',
            usd ?? money[0] ?? null,
            usd
              ? 'US dollars, so figures are comparable with other countries.'
              : `No dollar series offered. "${money[0]}" is a local-currency measure and nothing downstream converts it.`,
          ),
          pick(
            'weight_kg',
            weight[0] ?? null,
            'Weight, which is what makes a unit value possible. Without it no price can be derived.',
          ),
        ],
      });
      continue;
    }

    // --- flow ---------------------------------------------------------------
    const imp = real.find((l) => hasWord(l, ['import', 'imports']));
    const exp = real.find((l) => hasWord(l, ['export', 'exports']));
    if (imp && exp && !usedRoles.has('flow')) {
      usedRoles.add('flow');
      const total = labels.find((l) => isAggregate(l)) ?? null;
      guesses.push({
        ...base,
        role: 'flow',
        certainty: 'certain',
        reason: 'Contains an import value and an export value.',
        picked: [
          pick('flow_import', imp, 'Imports.'),
          pick('flow_export', exp, 'Exports.'),
          ...(total
            ? [
                pick(
                  'aggregate_to_avoid',
                  total,
                  `"${total}" is the sum of the other two. Requesting it alongside them doubles every ` +
                    'figure, and the result looks plausible because it is exactly twice the truth. It is ' +
                    'recorded here so it is never requested, not so it can be used.',
                ),
              ]
            : []),
        ],
      });
      continue;
    }

    // --- product ------------------------------------------------------------
    const prefixed = real.map(productCodePrefix).filter((p): p is string => p != null);
    if (prefixed.length >= real.length * 0.8 && prefixed.length > 0 && !usedRoles.has('product')) {
      usedRoles.add('product');
      // The finest level on offer. A dimension mixing depths is reported rather
      // than averaged, because mixing HS2 and HS6 in one request returns a
      // chapter and its own children and counts the trade twice.
      const depths = [...new Set(prefixed.map((p) => p.length))].sort((a, b) => b - a);
      const allProducts = labels.find((l) => isAggregate(l)) ?? null;
      guesses.push({
        ...base,
        role: 'product',
        certainty: depths.length === 1 ? 'certain' : 'uncertain',
        reason:
          depths.length === 1
            ? `Every value is prefixed with a ${depths[0]}-digit code.`
            : `Values mix code lengths (${depths.join(', ')} digits). Requesting a chapter and its own ` +
              'children together counts the same trade twice, so the depth has to be chosen deliberately.',
        picked: [
          pick(
            'all_products',
            allProducts,
            allProducts
              ? 'The product aggregate. Never requested alongside the individual products.'
              : 'No product aggregate offered.',
          ),
        ],
      });
      continue;
    }

    // --- partner ------------------------------------------------------------
    // A long list, most of which are recognisable countries. The threshold is
    // deliberately below the fraction of names that match, because sources
    // include territories and groupings that are not in the country list and
    // should not stop the dimension being identified.
    if (real.length >= 20 && !usedRoles.has('partner')) {
      const matched = real.filter((l) => matchPartner(l) != null).length;
      const ratio = matched / real.length;
      if (ratio >= 0.5) {
        usedRoles.add('partner');
        const allPartners = labels.find((l) => isAggregate(l)) ?? null;
        guesses.push({
          ...base,
          role: 'partner',
          certainty: ratio >= 0.8 ? 'certain' : 'likely',
          reason: `${matched} of ${real.length} values match known country names (${Math.round(ratio * 100)}%).`,
          picked: [
            pick(
              'all_partners',
              allPartners,
              allPartners
                ? 'The partner aggregate. Never requested alongside the individual partners.'
                : 'No partner aggregate offered.',
            ),
          ],
        });
        continue;
      }
    }

    guesses.push({
      ...base,
      role: 'unknown',
      certainty: 'uncertain',
      reason:
        'Did not match any known dimension shape. It may be a filter this application does not use, ' +
        'or a role it does not yet recognise.',
      picked: [],
    });
  }

  return guesses;
}

// --- the whole endpoint ------------------------------------------------------

/** Roles a request cannot be built without. */
const REQUIRED: DimensionRole[] = ['valuation', 'flow', 'year', 'product', 'partner'];

/**
 * Reads an endpoint's metadata and proposes a config.
 *
 * The fetch is the only network call, and it is a GET of a metadata document.
 * Nothing is written anywhere; the result is a proposal for a human to accept.
 */
export async function discoverCountryConfig(
  endpoint: string,
  fetchImpl: typeof fetch = fetch,
): Promise<DiscoveryResult> {
  const res = await fetchImpl(endpoint);
  if (!res.ok) {
    throw new Error(`Metadata request failed: ${res.status} ${res.statusText}`);
  }
  const meta = (await res.json()) as PxMetadata;
  if (!meta || !Array.isArray(meta.variables)) {
    throw new Error('Response is not PXWeb metadata: no variables array.');
  }
  return analyseMetadata(endpoint, meta);
}

/**
 * The judgement, separated from the fetch so it can be tested against captured
 * metadata rather than against a live government API.
 */
export function analyseMetadata(endpoint: string, meta: PxMetadata): DiscoveryResult {
  const dimensions = discoverDimensions(meta);
  const warnings: DiscoveryWarning[] = [];

  for (const role of REQUIRED) {
    if (!dimensions.some((d) => d.role === role)) {
      warnings.push({
        severity: 'blocking',
        message: `No ${role} dimension could be identified. Assign one by hand or this endpoint cannot be requested.`,
      });
    }
  }

  for (const d of dimensions) {
    if (d.role !== 'unknown' && d.certainty === 'uncertain') {
      warnings.push({ severity: 'check', message: `${d.text}: ${d.reason}` });
    }
    for (const p of d.picked) {
      if (p.value === null && p.key !== 'aggregate_to_avoid') {
        warnings.push({
          severity: 'check',
          message: `${d.text}: no value found for ${p.key}. ${p.reason}`,
        });
      }
    }
  }

  // --- partners -------------------------------------------------------------
  const partnerDim = dimensions.find((d) => d.role === 'partner');
  const partners: PartnerMatch[] = [];
  const unmatched: string[] = [];

  if (partnerDim) {
    const v = meta.variables.find((x) => x.code === partnerDim.code);
    const labels = (v?.valueTexts ?? v?.values ?? []).filter((l) => !isAggregate(l));
    const claimed = new Map<string, string>();

    for (const label of labels) {
      const m = matchPartner(label);
      if (!m) {
        unmatched.push(label);
        continue;
      }
      // Two source names landing on one country means one of them is wrong, and
      // silently keeping both would double that country's trade.
      const existing = claimed.get(m.iso3);
      if (existing) {
        warnings.push({
          severity: 'check',
          message:
            `Both "${existing}" and "${label}" matched ${m.app_name}. Keeping both would count that ` +
            "country's trade twice. Decide which one the source means.",
        });
        unmatched.push(label);
        continue;
      }
      claimed.set(m.iso3, label);
      partners.push(m);
    }

    if (unmatched.length) {
      warnings.push({
        severity: 'check',
        message:
          `${unmatched.length} partner name${unmatched.length === 1 ? '' : 's'} could not be matched to a ` +
          'country. Their trade is excluded until they are mapped or dismissed.',
      });
    }
  }

  // --- classification -------------------------------------------------------
  const productDim = dimensions.find((d) => d.role === 'product');
  let level: ClassificationLevel | null = null;
  let levelReason = 'No product dimension was identified.';

  if (productDim) {
    const v = meta.variables.find((x) => x.code === productDim.code);
    const labels = (v?.valueTexts ?? v?.values ?? []).filter((l) => !isAggregate(l));
    const digits = labels
      .map(productCodePrefix)
      .filter((p): p is string => p != null)
      .map((p) => p.length);
    const deepest = digits.length ? Math.max(...digits) : 0;
    level = depthForDigits(deepest);
    levelReason = level
      ? `Product codes are ${deepest} digits, which is ${level}.` +
        (level === 'HS2'
          ? ' That is a chapter, so every opportunity built from it is a sector signal rather than a specific product.'
          : '')
      : `Product codes are ${deepest} digits, which does not correspond to an HS level.`;
    if (!level) {
      warnings.push({ severity: 'blocking', message: levelReason });
    }
  }

  // --- years ----------------------------------------------------------------
  const yearDim = dimensions.find((d) => d.role === 'year');
  const yearVar = yearDim ? meta.variables.find((x) => x.code === yearDim.code) : undefined;
  const years = (yearVar?.valueTexts ?? yearVar?.values ?? [])
    .filter((y) => /^(19|20)\d{2}$/.test(y.trim()))
    .sort();

  if (yearDim && years.length === 0) {
    warnings.push({
      severity: 'blocking',
      message: 'The year dimension holds no four-digit years, so no period can be requested.',
    });
  }

  const ready =
    !warnings.some((w) => w.severity === 'blocking') &&
    REQUIRED.every((r) => dimensions.some((d) => d.role === r));

  return {
    endpoint,
    title: meta.title ?? '',
    dimensions,
    partners,
    unmatched_partners: unmatched,
    classification_level: level,
    classification_reason: levelReason,
    years,
    warnings,
    ready_to_confirm: ready,
  };
}

// --- dominance, for the exclusion checklist ----------------------------------

export interface DominanceCandidate {
  product_code: string;
  product_description: string | null;
  value_usd: number;
  share_pct: number;
  reason: string;
}

/**
 * Products large enough to be worth asking about.
 *
 * This is the judgement tier and it does not pretend otherwise. Nothing in
 * trade data says "traditional export"; what it can say is that one chapter is
 * a fifth of everything the country trades, which is the shape Ghana's cocoa,
 * gold and oil all have. An admin decides, types a reason, and the reason is
 * what ships.
 *
 * Deliberately not auto-applied. Excluding a country's largest trade because a
 * threshold was crossed would quietly remove the thing a reader most expects to
 * see, and the removal would be invisible.
 */
export function dominanceCandidates(
  totals: { product_code: string; product_description: string | null; value_usd: number }[],
  thresholdPct = 12,
): DominanceCandidate[] {
  const total = totals.reduce((s, t) => s + t.value_usd, 0);
  if (total <= 0) return [];

  return totals
    .map((t) => ({
      product_code: t.product_code,
      product_description: t.product_description,
      value_usd: t.value_usd,
      share_pct: (t.value_usd / total) * 100,
    }))
    .filter((t) => t.share_pct >= thresholdPct)
    .sort((a, b) => b.share_pct - a.share_pct)
    .map((t) => ({
      ...t,
      reason:
        `${t.share_pct.toFixed(1)}% of this country's total trade value sits in this one chapter. ` +
        'Concentration at that scale is usually a traditional or state-controlled commodity, which ' +
        'swamps any ranking it enters. Confirm and give the reason, or leave it in.',
    }));
}
