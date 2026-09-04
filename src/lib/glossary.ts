/**
 * Plain-English glossary.
 *
 * The whole premise of this product is that someone who has never exported
 * should be able to read a trade dashboard. That falls apart the moment the
 * page says "HHI 0.43" with no explanation. Every term of art in the interface
 * is tappable and explains itself here.
 *
 * `what`  — what the term means, in one or two sentences, no jargon.
 * `why`   — why an investor or trader should care.
 * `read`  — how to interpret the specific number in front of them.
 */
export interface GlossaryEntry {
  term: string;
  what: string;
  why?: string;
  read?: string;
  source?: { label: string; url: string };
}

export const GLOSSARY: Record<string, GlossaryEntry> = {
  hhi: {
    term: 'Export concentration',
    what: 'A single score for how much of a country\'s exports depend on a small number of products. It is the Herfindahl-Hirschman Index: add up the square of each product\'s share.',
    why: 'A concentrated exporter lives and dies by one price. When that product falls, the currency, the tax base and the buying power of the whole market fall with it.',
    read: 'Below 0.15 is broad. 0.15 to 0.25 is moderate. Above 0.25 the country is leaning hard on a handful of products.',
  },
  cagr: {
    term: 'Growth per year',
    what: 'Compound annual growth rate. The steady yearly rate that would take a figure from where it was to where it is now.',
    why: 'It smooths out one freak year. A product that jumped once then flattened looks very different from one climbing steadily.',
    read: 'Above 20% a year is fast. Sustained over three years it usually means real demand rather than a one-off order.',
  },
  hs_code: {
    term: 'HS code',
    what: 'The Harmonised System: an international numbering scheme for traded goods. Chapter 18 is cocoa, chapter 09 is coffee and spices, chapter 87 is vehicles.',
    why: 'Customs, tariffs, permits and every trade statistic in the world hang off this number. Get it wrong and you pay the wrong duty or get held at the border.',
    read: 'The first two digits are the chapter, which is the level shown here. Real shipments are classified to six or more digits.',
    source: {
      label: 'World Customs Organization',
      url: 'https://www.wcoomd.org/en/topics/nomenclature/instrument-and-tools/hs-nomenclature-2022-edition.aspx',
    },
  },
  trade_balance: {
    term: 'Trade balance',
    what: 'Exports minus imports. Positive is a surplus, negative is a deficit.',
    why: 'Surplus economies usually hold foreign currency, which makes getting paid and taking profit out simpler. Deficit economies can run short of dollars, so check payment terms before you commit.',
    read: 'The size matters relative to total trade. A deficit worth a fifth of all trade is a strain; a small one is normal.',
  },
  surplus: {
    term: 'Trade surplus',
    what: 'The country sells more abroad than it buys.',
    why: 'It usually means foreign currency is available, so invoices get paid and profit can be repatriated without a queue.',
  },
  deficit: {
    term: 'Trade deficit',
    what: 'The country buys more from abroad than it sells.',
    why: 'Foreign currency can be rationed. Ask how you will be paid, in what currency, and how long a transfer actually takes.',
  },
  momentum: {
    term: 'Momentum',
    what: 'Our own score, from 0 to 100%, blending how fast a product is growing, how much market share it has taken, and whether that growth was steady rather than a single spike.',
    why: 'Growth alone is noisy. A product can double because of one large order. Momentum rewards the ones that climb every year.',
    read: 'Above 60% is a strong signal. Below 30% we do not surface it at all.',
  },
  partner: {
    term: 'Trading partner',
    what: 'A country on the other end of a trade flow: where exports go, or where imports come from.',
    why: 'Established routes mean the shipping, the paperwork and the trade finance already exist. Entering an existing lane is far cheaper than opening a new one.',
  },
  services_trade: {
    term: 'Commercial services',
    what: 'Trade that is not goods: transport, tourism, construction, finance, telecoms, IT, consulting, licensing.',
    why: 'A country with real services exports usually has working payment rails and buyers already used to contracting across borders.',
  },
  incoterms: {
    term: 'Incoterms',
    what: 'Three-letter delivery terms published by the International Chamber of Commerce. They fix exactly where the seller stops paying and stops carrying risk.',
    why: 'Most first-time disputes are here. Agreeing a price without agreeing the Incoterm means you have not agreed a price.',
    read: 'EXW puts almost everything on the buyer. DDP puts almost everything on the seller. FOB and CIF sit in between and are the usual starting point.',
    source: {
      label: 'International Chamber of Commerce',
      url: 'https://iccwbo.org/business-solutions/incoterms-rules/',
    },
  },
  letter_of_credit: {
    term: 'Letter of credit',
    what: 'A bank promises to pay you once you present documents proving you shipped what was agreed.',
    why: 'It moves the risk from a buyer you do not know to a bank you can check. That is why it is the usual answer for a first order.',
    read: 'It costs money and it is strict. If a document says something slightly different from the credit, the bank can refuse.',
  },
  certificate_of_origin: {
    term: 'Certificate of origin',
    what: 'A document stating which country the goods were actually produced in, usually issued by a chamber of commerce or an export authority.',
    why: 'Preferential tariffs under agreements like the AfCFTA depend on it. No certificate, no preference, full duty.',
  },
  phytosanitary: {
    term: 'Phytosanitary certificate',
    what: 'An official certificate from the plant health authority confirming a consignment is free of pests and meets the destination country\'s plant health rules.',
    why: 'For fresh produce it is not optional. Without it the shipment is refused entry, and perishable cargo does not survive the argument.',
  },
  eudr: {
    term: 'EU Deforestation Regulation',
    what: 'Regulation (EU) 2023/1115. Cocoa, coffee, palm oil, rubber, soy, wood and cattle sold into or out of the EU must be proven not to come from land deforested after 31 December 2020.',
    why: 'If you sell cocoa to a European buyer, this reaches you through them. They cannot place the product without evidence from you.',
    read: 'Two separate tests: deforestation free, and legally produced under the laws of the country of production.',
    source: {
      label: 'Regulation (EU) 2023/1115',
      url: 'https://eur-lex.europa.eu/eli/reg/2023/1115/oj',
    },
  },
  afcfta: {
    term: 'AfCFTA',
    what: 'The African Continental Free Trade Area. It lowers tariffs on goods traded between member African states.',
    why: 'It is the difference between paying full duty and paying little or none on an intra-African sale. It is not automatic; you have to claim it correctly.',
    read: 'You need to meet the rules of origin and present an AfCFTA certificate of origin.',
  },
  rules_of_origin: {
    term: 'Rules of origin',
    what: 'The test that decides whether a product counts as made in a country, rather than just passed through it.',
    why: 'This is what stops someone importing finished goods, relabelling them, and claiming a trade preference. If you cannot pass it, the preferential tariff does not apply to you.',
  },
  fob: {
    term: 'FOB',
    what: 'Free On Board. The seller delivers the goods onto the ship and pays everything up to that point. Risk passes to the buyer once loaded.',
    why: 'It is a common, balanced starting point for a first sea shipment because each side controls the part of the journey it understands.',
  },
  world_total: {
    term: 'All partners',
    what: 'The figure against every trading partner combined, which is the country total.',
  },
  coverage: {
    term: 'Data coverage',
    what: 'Which years and which sources we actually have for this market.',
    why: 'Trade statistics lag by one to two years, and some countries report late or not at all. Knowing the gap stops you reading a stale number as current.',
  },
  comtrade: {
    term: 'UN Comtrade',
    what: 'The United Nations database of merchandise trade, where almost every country reports its exports and imports on the same classification.',
    why: 'National statistics offices publish in dozens of different formats. Comtrade puts them on one basis, which is the only honest way to compare markets side by side.',
    source: { label: 'UN Comtrade', url: 'https://comtradeplus.un.org/' },
  },
  push_pull: {
    term: 'Push and pull',
    what: 'Push is the markets selling a product outward. Pull is the markets buying it in.',
    why: 'It tells you at a glance whether you would be competing with an established exporter or supplying a hungry importer.',
  },
};

/** Terms that get linked automatically inside playbook and analysis prose. */
export const AUTO_LINK: [RegExp, string][] = [
  [/\bIncoterms?\b/gi, 'incoterms'],
  [/\bletters? of credit\b/gi, 'letter_of_credit'],
  [/\bcertificates? of origin\b/gi, 'certificate_of_origin'],
  [/\bphytosanitary certificates?\b/gi, 'phytosanitary'],
  [/\brules of origin\b/gi, 'rules_of_origin'],
  [/\bAfCFTA\b/g, 'afcfta'],
  [/\bHS codes?\b/gi, 'hs_code'],
  [/\bEU Deforestation Regulation\b/gi, 'eudr'],
];
