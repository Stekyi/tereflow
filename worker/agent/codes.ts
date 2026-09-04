/**
 * ISO3 -> UN M49 numeric code.
 *
 * UN Comtrade addresses reporters and partners by M49, while the World Bank,
 * our seed data and the UI all use ISO3. This is the bridge.
 */
export const ISO3_TO_M49: Record<string, number> = {
  AFG: 4, ALB: 8, DZA: 12, AND: 20, AGO: 24, ATG: 28, ARG: 32, ARM: 51,
  ABW: 533, AUS: 36, AUT: 40, AZE: 31, BHS: 44, BHR: 48, BGD: 50, BRB: 52,
  BLR: 112, BEL: 56, BLZ: 84, BEN: 204, BMU: 60, BTN: 64, BOL: 68, BIH: 70,
  BWA: 72, BRA: 76, BRN: 96, BGR: 100, BFA: 854, BDI: 108, CPV: 132, KHM: 116,
  CMR: 120, CAN: 124, CYM: 136, CAF: 140, TCD: 148, CHL: 152, CHN: 156,
  COL: 170, COM: 174, COG: 178, COD: 180, CRI: 188, CIV: 384, HRV: 191,
  CUB: 192, CUW: 531, CYP: 196, CZE: 203, DNK: 208, DJI: 262, DMA: 212,
  DOM: 214, ECU: 218, EGY: 818, SLV: 222, GNQ: 226, ERI: 232, EST: 233,
  SWZ: 748, ETH: 231, FJI: 242, FIN: 246, FRA: 251, PYF: 258, GAB: 266,
  GMB: 270, GEO: 268, DEU: 276, GHA: 288, GRC: 300, GRL: 304, GRD: 308,
  GTM: 320, GIN: 324, GNB: 624, GUY: 328, HTI: 332, HND: 340, HKG: 344,
  HUN: 348, ISL: 352, IND: 699, IDN: 360, IRN: 364, IRQ: 368, IRL: 372,
  ISR: 376, ITA: 381, JAM: 388, JPN: 392, JOR: 400, KAZ: 398, KEN: 404,
  KIR: 296, KWT: 414, KGZ: 417, LAO: 418, LVA: 428, LBN: 422, LSO: 426,
  LBR: 430, LBY: 434, LTU: 440, LUX: 442, MAC: 446, MDG: 450, MWI: 454,
  MYS: 458, MDV: 462, MLI: 466, MLT: 470, MHL: 584, MRT: 478, MUS: 480,
  MEX: 484, FSM: 583, MDA: 498, MNG: 496, MNE: 499, MAR: 504, MOZ: 508,
  MMR: 104, NAM: 516, NPL: 524, NLD: 528, NCL: 540, NZL: 554, NIC: 558,
  NER: 562, NGA: 566, PRK: 408, MKD: 807, NOR: 579, OMN: 512, PAK: 586,
  PLW: 585, PAN: 591, PNG: 598, PRY: 600, PER: 604, PHL: 608, POL: 616,
  PRT: 620, QAT: 634, ROU: 642, RUS: 643, RWA: 646, KNA: 659, LCA: 662,
  VCT: 670, WSM: 882, STP: 678, SAU: 682, SEN: 686, SRB: 688, SYC: 690,
  SLE: 694, SGP: 702, SVK: 703, SVN: 705, SLB: 90, SOM: 706, ZAF: 710,
  KOR: 410, SSD: 728, ESP: 724, LKA: 144, SDN: 729, SUR: 740, SWE: 752,
  CHE: 757, SYR: 760, TWN: 490, TJK: 762, TZA: 834, THA: 764, TLS: 626,
  TGO: 768, TON: 776, TTO: 780, TUN: 788, TUR: 792, TKM: 795, UGA: 800,
  UKR: 804, ARE: 784, GBR: 826, USA: 842, URY: 858, UZB: 860, VUT: 548,
  VEN: 862, VNM: 704, YEM: 887, ZMB: 894, ZWE: 716,
};

export const M49_TO_ISO3: Record<number, string> = Object.fromEntries(
  Object.entries(ISO3_TO_M49).map(([iso, m49]) => [m49, iso]),
);

/** HS chapter (2-digit) -> plain English. Used to label charts for non-specialists. */
export const HS2_LABEL: Record<string, string> = {
  '01': 'Live animals', '02': 'Meat', '03': 'Fish & seafood', '04': 'Dairy, eggs & honey',
  '05': 'Other animal products', '06': 'Live trees & cut flowers', '07': 'Vegetables',
  '08': 'Fruit & nuts', '09': 'Coffee, tea & spices', '10': 'Cereals', '11': 'Milling products',
  '12': 'Oil seeds & oleaginous fruit', '13': 'Gums & resins', '14': 'Vegetable plaiting material',
  '15': 'Animal & vegetable fats/oils', '16': 'Prepared meat & fish', '17': 'Sugar & confectionery',
  '18': 'Cocoa & cocoa preparations', '19': 'Cereal, flour & milk preparations',
  '20': 'Prepared vegetables & fruit', '21': 'Miscellaneous edible preparations',
  '22': 'Beverages & spirits', '23': 'Food residues & animal feed', '24': 'Tobacco',
  '25': 'Salt, sulphur, earths & stone', '26': 'Metal ores & ash', '27': 'Mineral fuels & oils',
  '28': 'Inorganic chemicals', '29': 'Organic chemicals', '30': 'Pharmaceuticals',
  '31': 'Fertilisers', '32': 'Tanning & dyeing extracts', '33': 'Essential oils & cosmetics',
  '34': 'Soaps & waxes', '35': 'Albuminoids, glues & enzymes', '36': 'Explosives',
  '37': 'Photographic goods', '38': 'Miscellaneous chemicals', '39': 'Plastics',
  '40': 'Rubber', '41': 'Raw hides & leather', '42': 'Leather articles', '43': 'Furskins',
  '44': 'Wood & wood articles', '45': 'Cork', '46': 'Straw & basketware',
  '47': 'Wood pulp', '48': 'Paper & paperboard', '49': 'Printed books & newspapers',
  '50': 'Silk', '51': 'Wool & animal hair', '52': 'Cotton', '53': 'Other vegetable fibres',
  '54': 'Man-made filaments', '55': 'Man-made staple fibres', '56': 'Wadding & nonwovens',
  '57': 'Carpets', '58': 'Special woven fabrics', '59': 'Coated textiles',
  '60': 'Knitted fabrics', '61': 'Knitted apparel', '62': 'Woven apparel',
  '63': 'Other textile articles', '64': 'Footwear', '65': 'Headgear', '66': 'Umbrellas',
  '67': 'Prepared feathers & artificial flowers', '68': 'Stone, plaster & cement articles',
  '69': 'Ceramics', '70': 'Glass & glassware', '71': 'Pearls, gems & precious metals',
  '72': 'Iron & steel', '73': 'Iron & steel articles', '74': 'Copper', '75': 'Nickel',
  '76': 'Aluminium', '78': 'Lead', '79': 'Zinc', '80': 'Tin', '81': 'Other base metals',
  '82': 'Tools & cutlery', '83': 'Miscellaneous base metal articles',
  '84': 'Machinery & mechanical appliances', '85': 'Electrical machinery & electronics',
  '86': 'Railway vehicles', '87': 'Vehicles', '88': 'Aircraft & spacecraft', '89': 'Ships & boats',
  '90': 'Optical & medical instruments', '91': 'Clocks & watches', '92': 'Musical instruments',
  '93': 'Arms & ammunition', '94': 'Furniture & bedding', '95': 'Toys, games & sports goods',
  '96': 'Miscellaneous manufactured articles', '97': 'Works of art & antiques',
  '99': 'Unclassified',
};

export function hs2Label(code: string | null | undefined, fallback?: string | null): string {
  if (!code) return fallback ?? 'Unclassified';
  const key = code.padStart(2, '0').slice(0, 2);
  return HS2_LABEL[key] ?? fallback ?? `HS ${key}`;
}

/**
 * Broad sector grouping used for the investor-facing view. HS chapters are
 * too granular to reason about at a glance.
 */
export function hs2Sector(code: string | null | undefined): string {
  const n = Number((code ?? '').slice(0, 2));
  if (n >= 1 && n <= 24) return 'Agriculture & food';
  if (n >= 25 && n <= 27) return 'Minerals & energy';
  if (n >= 28 && n <= 38) return 'Chemicals';
  if (n >= 39 && n <= 40) return 'Plastics & rubber';
  if (n >= 41 && n <= 43) return 'Hides & leather';
  if (n >= 44 && n <= 49) return 'Wood & paper';
  if (n >= 50 && n <= 63) return 'Textiles';
  if (n >= 64 && n <= 67) return 'Footwear & headgear';
  if (n >= 68 && n <= 71) return 'Stone, glass & precious metals';
  if (n >= 72 && n <= 83) return 'Metals';
  if (n >= 84 && n <= 85) return 'Machinery & electronics';
  if (n >= 86 && n <= 89) return 'Transport equipment';
  if (n >= 90 && n <= 92) return 'Instruments';
  if (n >= 93 && n <= 97) return 'Other manufacturing';
  return 'Unclassified';
}
