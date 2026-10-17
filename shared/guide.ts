/**
 * Problem-to-supply guide. A fixed, rule-based walk from one product in one country to a short list of
 * researchable problems and supply or procurement plays. No model is involved: the same facts always give the
 * same output, every finding carries the numbers it rests on, and anything not held is listed as unavailable.
 *
 * The five steps follow a socio-technical systems method:
 *   1 trace the product chain and name the actors, 2 find where the trade shows strain,
 *   3 group the findings under PESTEL, 4 merge findings that point at one problem,
 *   5 turn each problem into research questions and a play.
 * The framework layer (which dimension, which problem, which play) is rules written for Tereflow. It organises
 * evidence for research. It is not proof and not advice.
 */

export type Role = 'supply' | 'procurement';
export type Dimension = 'Political' | 'Economic' | 'Social' | 'Technological' | 'Environmental' | 'Legal';

export interface SeriesPoint { year: number; value_usd: number; qty_kg: number | null }
export interface PartnerFact { name: string; value_usd: number; qty_kg: number | null }

export interface GuideFacts {
  country: string;
  product: string;
  hs: string;
  role: Role;
  budget_usd: number | null;
  exports: SeriesPoint[];
  imports: SeriesPoint[];
  /** Where the country sells this product (real countries only). */
  buyers: PartnerFact[];
  /** Where the country buys this product (real countries only). */
  suppliers: PartnerFact[];
  /** Crowding of the biggest buyer markets' own supply, where held. */
  buyer_markets: Array<{ name: string; saturation: 'dominated' | 'few-main' | 'competitive' | 'insufficient'; top_supplier: string | null; top_share_pct: number | null; import_unit_usd_t: number | null; year: number | null }>;
  /** Related goods from the by-product knowledge base, with this country's own trade in them. */
  related: Array<{ name: string; code: string | null; kind: string; confidence: string; home_export_usd: number | null; home_import_usd: number | null }>;
  fx: { level: 'low' | 'moderate' | 'high' | 'insufficient'; reason: string } | null;
}

export interface Finding {
  id: string;
  dimension: Dimension;
  problem: ProblemKey;
  text: string;
  evidence: string[];
}

export type ProblemKey = 'market_dependence' | 'value_leakage' | 'price_exposure' | 'volume_trend' | 'supply_gap';

export interface Problem {
  key: ProblemKey;
  title: string;
  findings: Finding[];
  dimensions: Dimension[];
  research_questions: string[];
  play: { title: string; how: string; when: string; risks: string[]; reward: string };
}

export interface Estimate {
  available: boolean;
  low_usd: number | null;
  high_usd: number | null;
  basis: string[];
  caveats: string[];
}

export interface GuideResult {
  chain: { stage: string; actors: string[]; from_data: boolean }[];
  findings: Finding[];
  by_dimension: Array<{ dimension: Dimension; findings: Finding[] }>;
  problems: Problem[];
  estimate: Estimate;
  risk: { level: 'low' | 'moderate' | 'high'; reasons: string[] };
  unavailable: string[];
  method: string[];
}

const fmtUsd = (n: number) => (n >= 1e9 ? `$${(n / 1e9).toFixed(2)}B` : n >= 1e6 ? `$${(n / 1e6).toFixed(1)}M` : `$${Math.round(n).toLocaleString('en-US')}`);
const pct = (n: number) => `${Math.round(n * 10) / 10}%`;
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Price per tonne in US dollars, only when a weight is held. */
export function unitUsdT(p: { value_usd: number; qty_kg: number | null }): number | null {
  return p.qty_kg && p.qty_kg > 0 && p.value_usd > 0 ? (p.value_usd / p.qty_kg) * 1000 : null;
}

function cagr(s: SeriesPoint[]): { pct: number; from: number; to: number } | null {
  const pts = s.filter((p) => p.value_usd > 0).sort((a, b) => a.year - b.year);
  if (pts.length < 3) return null;
  const a = pts[0];
  const b = pts[pts.length - 1];
  const n = b.year - a.year;
  if (n < 2) return null;
  return { pct: (Math.pow(b.value_usd / a.value_usd, 1 / n) - 1) * 100, from: a.year, to: b.year };
}

function unitSwing(s: SeriesPoint[]): { cv: number; min: number; max: number; years: number } | null {
  const us = s.map(unitUsdT).filter((x): x is number => x != null);
  if (us.length < 3) return null;
  const mean = sum(us) / us.length;
  const sd = Math.sqrt(sum(us.map((u) => (u - mean) ** 2)) / us.length);
  return { cv: sd / mean, min: Math.min(...us), max: Math.max(...us), years: us.length };
}

const latest = (s: SeriesPoint[]) => [...s].sort((a, b) => a.year - b.year).at(-1) ?? null;

export const RULES = {
  buyerDependencePct: 50,
  priceSwingCv: 0.25,
  declinePct: -5,
  growthPct: 5,
  importDependenceRatio: 1,
  leakageMinUsd: 1_000_000,
  costAllowanceLow: 0.15,
  costAllowanceHigh: 0.35,
};

export function runGuide(f: GuideFacts): GuideResult {
  const unavailable: string[] = [
    'Tariffs by market, preferential rates and non-tariff barriers are not part of this walk-through yet.',
    'Who the producers, traders and shippers are by name is not held. Actors below are roles, not companies.',
    'Licensing and state control of a commodity are not checked. Some goods can only be traded by licensed or state bodies in some countries. Confirm who may legally export or import this product before any commitment.',
  ];
  const findings: Finding[] = [];
  const add = (x: Finding) => findings.push(x);

  const xl = latest(f.exports);
  const ml = latest(f.imports);
  const buyTotal = sum(f.buyers.map((b) => b.value_usd));
  const supTotal = sum(f.suppliers.map((b) => b.value_usd));

  // Chain, from data where it exists.
  const chain: GuideResult['chain'] = [
    { stage: 'Production or sourcing', actors: ['Growers, collectors or manufacturers (not named in our data)'], from_data: false },
    { stage: 'Processing and grading', actors: f.related.length ? [`Processors of ${f.product}`, ...f.related.slice(0, 3).map((r) => `Makers of ${r.name}`)] : ['Processors (not named in our data)'], from_data: f.related.length > 0 },
    { stage: f.role === 'supply' ? `Export from ${f.country}` : `Import into ${f.country}`, actors: ['Traders and agents', 'Customs and port operators', 'Freight and shipping lines'], from_data: false },
    {
      stage: f.role === 'supply' ? 'Buyer markets' : 'Supplier countries',
      actors: (f.role === 'supply' ? f.buyers : f.suppliers).slice(0, 5).map((p) => p.name),
      from_data: (f.role === 'supply' ? f.buyers : f.suppliers).length > 0,
    },
    { stage: 'End use and by-products', actors: f.related.length ? f.related.slice(0, 4).map((r) => `${r.name} (${r.kind}, ${r.confidence})`) : ['End users (not named in our data)'], from_data: f.related.length > 0 },
  ];

  // R1 buyer or supplier concentration.
  const side = f.role === 'supply' ? f.buyers : f.suppliers;
  const sideTotal = f.role === 'supply' ? buyTotal : supTotal;
  const top = [...side].sort((a, b) => b.value_usd - a.value_usd)[0];
  if (top && sideTotal > 0) {
    const share = (top.value_usd / sideTotal) * 100;
    if (share >= RULES.buyerDependencePct) {
      add({
        id: 'R1', dimension: 'Political', problem: 'market_dependence',
        text: `${f.role === 'supply' ? 'Sales' : 'Purchases'} lean on one country: ${top.name} is ${pct(share)} of the trade.`,
        evidence: [`Rule: concentration flagged at ${RULES.buyerDependencePct}% or more.`, `${top.name}: ${fmtUsd(top.value_usd)} of ${fmtUsd(sideTotal)} (${xl && f.role === 'supply' ? xl.year : ml?.year ?? 'latest held year'}). Source: UN Comtrade.`],
      });
    }
  }

  // R2 crowded buyer markets.
  const crowded = f.buyer_markets.filter((m) => m.saturation === 'dominated');
  if (f.role === 'supply' && crowded.length) {
    add({
      id: 'R2', dimension: 'Economic', problem: 'market_dependence',
      text: `${crowded.length} of the main buyer markets are already dominated by one supplier (${crowded.map((m) => `${m.name}: ${m.top_supplier} ${m.top_share_pct}%`).join('; ')}).`,
      evidence: ['Rule: dominated means one supplier with 50% or more of that buyer\'s imports. Source: UN Comtrade, buyer import partners.'],
    });
  }

  // R3 raw out, processed in.
  const leaks = f.related.filter((r) => (r.home_import_usd ?? 0) >= RULES.leakageMinUsd && (r.home_export_usd ?? 0) < (r.home_import_usd ?? 0) / 4 && r.confidence !== 'rejected');
  if (leaks.length) {
    add({
      id: 'R3', dimension: 'Technological', problem: 'value_leakage',
      text: `${f.country} imports related goods it could plausibly make from ${f.product}: ${leaks.map((l) => `${l.name} (${fmtUsd(l.home_import_usd ?? 0)} imported)`).join('; ')}.`,
      evidence: [`Rule: imports of at least ${fmtUsd(RULES.leakageMinUsd)} and exports under a quarter of imports.`, 'Source: by-product knowledge base (relationship, confidence shown on the product page) and UN Comtrade.'],
    });
  }
  const byprod = f.related.filter((r) => r.confidence === 'verified' && r.kind !== 'processed');
  if (byprod.length) {
    add({
      id: 'R4', dimension: 'Environmental', problem: 'value_leakage',
      text: `Verified residues or by-products exist for ${f.product}: ${byprod.slice(0, 4).map((r) => r.name).join(', ')}. Whether this country already uses them is not shown by the data.`,
      evidence: ['Source: by-product knowledge base, verified against official HS wording and recorded trade.'],
    });
  }

  // R5 price swing.
  const swing = unitSwing(f.role === 'supply' ? f.exports : f.imports);
  if (swing && swing.cv >= RULES.priceSwingCv) {
    add({
      id: 'R5', dimension: 'Economic', problem: 'price_exposure',
      text: `The price per tonne has swung widely: from ${fmtUsd(swing.min)} to ${fmtUsd(swing.max)} over ${swing.years} years.`,
      evidence: [`Rule: swing flagged when the variation across years is ${RULES.priceSwingCv * 100}% or more of the average (here ${pct(swing.cv * 100)}).`, 'Customs unit values mix grades, so this is a signal, not a quote.'],
    });
  }

  // R6 currency.
  if (f.fx && (f.fx.level === 'high' || f.fx.level === 'moderate')) {
    add({
      id: 'R6', dimension: 'Economic', problem: 'price_exposure',
      text: `The home currency has been ${f.fx.level === 'high' ? 'highly' : 'moderately'} unstable against the dollar.`,
      evidence: [f.fx.reason, 'Source: World Bank PA.NUS.FCRF.'],
    });
  }

  // R7 trend.
  const g = cagr(f.role === 'supply' ? f.exports : f.imports);
  if (g && g.pct <= RULES.declinePct) {
    add({
      id: 'R7', dimension: 'Social', problem: 'volume_trend',
      text: `Trade value has been shrinking: ${pct(g.pct)} a year between ${g.from} and ${g.to}.`,
      evidence: [`Rule: decline flagged at ${RULES.declinePct}% a year or worse. Value in dollars, so price falls and volume falls both show here.`],
    });
  } else if (g && g.pct >= RULES.growthPct) {
    add({
      id: 'R7', dimension: 'Social', problem: 'volume_trend',
      text: `Trade value has been growing: ${pct(g.pct)} a year between ${g.from} and ${g.to}, which means demand or supply is moving and a gap may be opening.`,
      evidence: [`Rule: growth flagged at ${RULES.growthPct}% a year or more.`],
    });
  }

  // R8 import dependence, the procurement angle.
  if (ml && ml.value_usd > 0 && (!xl || ml.value_usd >= xl.value_usd * RULES.importDependenceRatio)) {
    add({
      id: 'R8', dimension: 'Economic', problem: 'supply_gap',
      text: `${f.country} imports ${fmtUsd(ml.value_usd)} of this product (${ml.year})${xl ? ` against ${fmtUsd(xl.value_usd)} exported` : ' and holds no exports of it'}. Local demand is served from abroad.`,
      evidence: [`Rule: flagged when imports are at least ${RULES.importDependenceRatio}x exports. Source: UN Comtrade. Imports may include re-exports or transit.`],
    });
  }

  // Step 3 grouping.
  const dims: Dimension[] = ['Political', 'Economic', 'Social', 'Technological', 'Environmental', 'Legal'];
  const by_dimension = dims.map((d) => ({ dimension: d, findings: findings.filter((x) => x.dimension === d) })).filter((d) => d.findings.length);

  // Step 4 merging, then step 5.
  const keys = [...new Set(findings.map((x) => x.problem))] as ProblemKey[];
  const problems = keys.map((k) => buildProblem(k, findings.filter((x) => x.problem === k), f, side));

  // Risk, a count of the flags that apply.
  const riskReasons = findings.filter((x) => ['R1', 'R2', 'R5', 'R6'].includes(x.id)).map((x) => x.text);
  if (!f.budget_usd) unavailable.push('No budget was given, so no return estimate is made.');
  const risk = { level: (riskReasons.length >= 3 ? 'high' : riskReasons.length >= 1 ? 'moderate' : 'low') as 'low' | 'moderate' | 'high', reasons: riskReasons.length ? riskReasons : ['No concentration, price or currency flag was triggered. This is not the same as no risk.'] };

  return {
    chain, findings, by_dimension, problems, estimate: estimate(f), risk, unavailable,
    method: [
      'Fixed rules over held trade data. The same inputs give the same output.',
      'Dimension, problem and play assignments are Tereflow rules for organising research. They are not findings of fact.',
      `Thresholds: buyer dependence ${RULES.buyerDependencePct}%, price swing ${RULES.priceSwingCv * 100}%, decline ${RULES.declinePct}% a year, growth ${RULES.growthPct}% a year.`,
    ],
  };
}

function buildProblem(key: ProblemKey, fs: Finding[], f: GuideFacts, side: PartnerFact[]): Problem {
  const dimensions = [...new Set(fs.map((x) => x.dimension))];
  const next = [...side].sort((a, b) => b.value_usd - a.value_usd).slice(1, 4).map((p) => p.name);
  const crowdedFree = f.buyer_markets.filter((m) => m.saturation === 'competitive' || m.saturation === 'few-main').map((m) => m.name);
  const P = f.product;
  const C = f.country;
  switch (key) {
    case 'market_dependence':
      return {
        key, title: `Dependence on a single ${f.role === 'supply' ? 'buyer' : 'supplier'} market`, findings: fs, dimensions,
        research_questions: [
          `What would ${P} sell for in ${next.length ? next.join(', ') : 'two or three other countries'} after freight, duty and certification?`,
          `Which buyers in those markets already take ${P} from ${C}'s competitors, and on what terms?`,
          `What standards, certificates or labels does a second market require that the first does not?`,
        ],
        play: {
          title: f.role === 'supply' ? 'Open a second buyer market' : 'Add a second source country',
          how: `Take a small first order to ${next[0] ?? 'the next largest partner'}${crowdedFree.length ? `, where supply is less locked up (${crowdedFree.slice(0, 2).join(', ')})` : ''}, and compare the delivered price with the main market.`,
          when: 'After the research questions are answered, and before committing more than a small share of the budget to any one market.',
          risks: ['The second market may need different certification or packaging.', 'Per-tonne freight to a farther market can erase the price gain.'],
          reward: 'A second outlet lowers the damage of losing the first and gives bargaining room on price.',
        },
      };
    case 'value_leakage':
      return {
        key, title: 'Value leaving as raw goods or unused residue', findings: fs, dimensions,
        research_questions: [
          `What does it cost to process ${P} into the imported goods at the scale a budget of this size allows?`,
          `Which buyers inside ${C} import those goods today, and at what price per tonne?`,
          `Is the residue from ${P} already collected, and by whom?`,
        ],
        play: {
          title: 'Process or collect locally instead of importing or discarding',
          how: `Start with the related good with the largest recorded import. Price a small processing or collection unit against that import price. The by-product table on the product page lists methods and uses, with confidence marked.`,
          when: 'Only after a buyer for the output is identified. Capacity without a buyer is the common failure.',
          risks: ['Process and application detail in the knowledge base is general knowledge unless marked sourced.', 'Equipment, power and quality control raise the entry cost above a pure trading business.'],
          reward: 'Import substitution or a higher-value export, with margin kept inside the country.',
        },
      };
    case 'price_exposure':
      return {
        key, title: 'Exposure to price and currency swings', findings: fs, dimensions,
        research_questions: [
          `Which years drove the price swings of ${P}, and were they harvest, demand or currency years?`,
          'Can contracts be priced in dollars, or on a fixed price for a season, with the buyer?',
          'What did buyers pay for quality-graded lots compared with ungraded lots?',
        ],
        play: {
          title: 'Fix the price with a contract before you buy or sell',
          how: 'Agree the selling price with the buyer before purchasing stock, or buy against a signed order. Price in dollars where the home currency is unstable.',
          when: 'Before any stock is bought. Do not hold unpriced stock through a swing year.',
          risks: ['A fixed price loses upside when the market rises.', 'Counterparty default is not visible in trade data.'],
          reward: 'A narrower, more predictable margin that can be planned and financed.',
        },
      };
    case 'volume_trend':
      return {
        key, title: fs[0].text.includes('shrinking') ? 'A shrinking trade' : 'A growing trade', findings: fs, dimensions,
        research_questions: fs[0].text.includes('shrinking')
          ? [`What explains the fall in ${P} trade: lower prices, lost buyers, lost supply or a rule change?`, 'Did competitors take the volume, and from which country?']
          : [`What is driving growth in ${P}: new buyers, new uses or price rises?`, 'Is supply able to keep up, or is a gap opening that a new entrant could fill?'],
        play: {
          title: fs[0].text.includes('shrinking') ? 'Find out why before entering' : 'Enter early with a small test lot',
          how: fs[0].text.includes('shrinking') ? 'Treat this as a warning to research, not an opening, until the cause is known.' : 'Ship or source a small lot to prove the quality, price and paperwork, then scale.',
          when: fs[0].text.includes('shrinking') ? 'After the cause is known.' : 'Now, with a test lot, then scale in steps.',
          risks: ['Value trends mix price and volume.', 'A trend is a past pattern, not a forecast.'],
          reward: 'Early position in a moving market, or an avoided loss in a falling one.',
        },
      };
    case 'supply_gap':
      return {
        key, title: `${C} depends on imports of ${P}`, findings: fs, dimensions,
        research_questions: [
          `Who inside ${C} buys the imported ${P}, in what sizes and how often?`,
          `Which supplier country offers the lowest delivered price, and is it reliable?`,
          `Could domestic production meet part of this demand at a competitive price?`,
        ],
        play: {
          title: f.role === 'procurement' ? 'Become a consolidated importer for local buyers' : 'Serve local demand directly',
          how: `Pool several small buyers' orders into one shipment from the cheapest dependable supplier, and sell to them at a stated margin.`,
          when: 'Once three or more committed buyers are found. Do not import on speculation.',
          risks: ['Imports may include re-exports and transit, so real local demand can be smaller.', 'Duty, VAT and clearance are not in this model; use the landed cost calculator.'],
          reward: 'A margin between the delivered cost and what local buyers pay, earned on volume you have already sold.',
        },
      };
  }
}

/**
 * A rough range, not a forecast. It takes the gap between what buyers pay per tonne on arrival (customs value, which
 * includes freight) and what this country gets per tonne leaving, then removes a cost allowance. Real duty, freight
 * and handling are not known here, so the allowance is a stated assumption the reader should replace.
 */
export function estimate(f: GuideFacts): Estimate {
  const none = (why: string, basis: string[] = []): Estimate => ({ available: false, low_usd: null, high_usd: null, basis, caveats: [why] });
  if (!f.budget_usd || f.budget_usd <= 0) return none('No budget was given.');

  let buy: number | null = null;
  let sell: number | null = null;
  const basis: string[] = [];

  if (f.role === 'supply') {
    const home = latest(f.exports);
    sell = home ? unitUsdT(home) : null;
    const buyers = f.buyer_markets.map((m) => ({ n: m.name, u: m.import_unit_usd_t })).filter((m): m is { n: string; u: number } => m.u != null);
    if (!sell || !buyers.length) return none('Needs both this country\'s export price per tonne and at least one buyer\'s import price per tonne. One of them is not held.');
    const best = buyers.sort((a, b) => b.u - a.u)[0];
    buy = sell;
    basis.push(`Home export price: ${fmtUsd(sell)} per tonne (${home?.year}).`, `Best held buyer import price: ${best.n}, ${fmtUsd(best.u)} per tonne on arrival.`);
    return range(f.budget_usd, buy, best.u - sell, basis);
  }
  // procurement: compare supplier unit prices
  const prices = f.suppliers.map((s) => ({ n: s.name, u: s.qty_kg && s.qty_kg > 0 ? (s.value_usd / s.qty_kg) * 1000 : null, v: s.value_usd })).filter((s): s is { n: string; u: number; v: number } => s.u != null && s.v >= 100_000);
  const local = latest(f.imports);
  const avg = local ? unitUsdT(local) : null;
  if (prices.length < 2 || !avg) return none('Needs at least two suppliers with weights held and meaningful volume, to compare prices. Not available here.');
  const cheapest = [...prices].sort((a, b) => a.u - b.u)[0];
  basis.push(`Average import price: ${fmtUsd(avg)} per tonne (${local?.year}).`, `Cheapest held supplier: ${cheapest.n}, ${fmtUsd(cheapest.u)} per tonne.`);
  return range(f.budget_usd, cheapest.u, avg - cheapest.u, basis);
}

function range(budget: number, cost: number, spread: number, basis: string[]): Estimate {
  const caveats = [
    `Cost allowance of ${RULES.costAllowanceLow * 100}% to ${RULES.costAllowanceHigh * 100}% of the goods price is an assumption for duty, handling and losses. Replace it using the landed cost calculator.`,
    'Customs unit values mix grades and include freight on arrival, so the gap is a signal, not a quote.',
    'Assumes the whole budget buys goods at the stated price and everything sells. Real sales are slower and smaller.',
  ];
  if (spread <= 0) return { available: true, low_usd: 0, high_usd: 0, basis, caveats: ['No positive price gap is shown by the data, so no profit is indicated.', ...caveats] };
  const tonnes = budget / cost;
  const low = tonnes * (spread - cost * RULES.costAllowanceHigh);
  const high = tonnes * (spread - cost * RULES.costAllowanceLow);
  basis.push(`Budget ${fmtUsd(budget)} buys about ${Math.round(tonnes * 10) / 10} tonnes at the stated price.`);
  return { available: true, low_usd: Math.round(Math.min(low, high)), high_usd: Math.round(Math.max(low, high)), basis, caveats };
}
