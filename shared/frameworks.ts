export type Incoterm = 'EXW' | 'FCA' | 'FOB' | 'CFR' | 'CIF' | 'CPT' | 'CIP' | 'DAP' | 'DDP';

export interface IncotermInfo {
  code: Incoterm;
  name: string;
  /** Costs and risks the seller carries up to this point. */
  seller_to: string;
  buyer_note: string;
}

/** Plain-language summary of the standard trade terms, written for Tereflow. Not the ICC text. */
export const INCOTERMS: IncotermInfo[] = [
  { code: 'EXW', name: 'Ex Works', seller_to: "the seller's own premises", buyer_note: 'Buyer arranges everything from pickup, including export clearance.' },
  { code: 'FCA', name: 'Free Carrier', seller_to: 'a named place where the carrier collects', buyer_note: 'Seller clears export; buyer pays main carriage.' },
  { code: 'FOB', name: 'Free On Board', seller_to: 'the goods loaded on the ship at the origin port', buyer_note: 'Sea freight only. Buyer pays freight and insurance from loading.' },
  { code: 'CFR', name: 'Cost and Freight', seller_to: 'the destination port, freight paid', buyer_note: 'Sea freight only. Risk passes at loading; buyer should insure.' },
  { code: 'CIF', name: 'Cost, Insurance and Freight', seller_to: 'the destination port, freight and minimum insurance paid', buyer_note: 'Sea freight only. Insurance is minimum cover.' },
  { code: 'CPT', name: 'Carriage Paid To', seller_to: 'the named destination, freight paid', buyer_note: 'Any transport mode. Risk passes at first carrier.' },
  { code: 'CIP', name: 'Carriage and Insurance Paid To', seller_to: 'the named destination, freight and insurance paid', buyer_note: 'Any transport mode. Insurance level is higher than CIF.' },
  { code: 'DAP', name: 'Delivered At Place', seller_to: 'the buyer destination, ready to unload', buyer_note: 'Buyer pays import clearance, duty and VAT.' },
  { code: 'DDP', name: 'Delivered Duty Paid', seller_to: 'the buyer destination, duty and import taxes paid', buyer_note: 'Maximum seller obligation; seller must be able to clear imports.' },
];

export interface LandedCostInput {
  /** Price per tonne at the seller's gate, FOB or similar, in US dollars. */
  goods_per_tonne: number;
  tonnes: number;
  freight_total: number;
  insurance_pct: number;
  duty_pct: number;
  vat_pct: number;
  /** Port, clearance, inland haulage and other fixed charges in dollars. */
  other_costs: number;
  /** Expected resale price per tonne at the destination. */
  sale_per_tonne?: number | null;
}

export interface LandedCost {
  goods: number;
  freight: number;
  insurance: number;
  cif_value: number;
  duty: number;
  vat: number;
  other: number;
  total: number;
  per_tonne: number;
  margin_per_tonne: number | null;
  margin_pct: number | null;
  steps: string[];
  limitations: string[];
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/**
 * Standard landed-cost build-up: goods, freight and insurance give the CIF value, duty is charged on CIF,
 * VAT is charged on CIF plus duty, then fixed charges are added. Rates are whatever the user supplies;
 * nothing here knows a country's real tariff.
 */
export function landedCost(i: LandedCostInput): LandedCost | null {
  const ok = [i.goods_per_tonne, i.tonnes, i.freight_total, i.insurance_pct, i.duty_pct, i.vat_pct, i.other_costs].every((v) => Number.isFinite(v) && v >= 0);
  if (!ok || i.tonnes <= 0 || i.goods_per_tonne <= 0) return null;
  const goods = i.goods_per_tonne * i.tonnes;
  const insurance = (goods + i.freight_total) * (i.insurance_pct / 100);
  const cif = goods + i.freight_total + insurance;
  const duty = cif * (i.duty_pct / 100);
  const vat = (cif + duty) * (i.vat_pct / 100);
  const total = cif + duty + vat + i.other_costs;
  const perTonne = total / i.tonnes;
  let margin: number | null = null;
  let marginPct: number | null = null;
  if (i.sale_per_tonne != null && Number.isFinite(i.sale_per_tonne) && i.sale_per_tonne > 0) {
    margin = i.sale_per_tonne - perTonne;
    marginPct = (margin / i.sale_per_tonne) * 100;
  }
  return {
    goods: r2(goods), freight: r2(i.freight_total), insurance: r2(insurance), cif_value: r2(cif), duty: r2(duty),
    vat: r2(vat), other: r2(i.other_costs), total: r2(total), per_tonne: r2(perTonne),
    margin_per_tonne: margin == null ? null : r2(margin), margin_pct: marginPct == null ? null : r2(marginPct),
    steps: [
      'Goods value = price per tonne x tonnes.',
      'Insurance = (goods + freight) x insurance rate.',
      'CIF value = goods + freight + insurance.',
      'Duty = CIF value x duty rate.',
      'VAT = (CIF value + duty) x VAT rate.',
      'Landed cost = CIF value + duty + VAT + other charges.',
    ],
    limitations: [
      'Every rate and charge is an input you supply. Tereflow does not look up your real tariff, VAT or freight quote here.',
      'Some countries charge duty on a different base or add levies, so check the local rules before committing.',
      'Currency movement between order and payment is not included.',
    ],
  };
}

export interface MarginRange {
  low: number | null;
  high: number | null;
  basis: string;
}

/**
 * A margin range from a cost per tonne and a low and high expected sale price per tonne. A range is
 * returned rather than a single figure because resale prices move.
 */
export function marginRange(costPerTonne: number, saleLow: number, saleHigh: number): MarginRange {
  if (![costPerTonne, saleLow, saleHigh].every(Number.isFinite) || costPerTonne <= 0 || saleLow <= 0 || saleHigh < saleLow) {
    return { low: null, high: null, basis: 'Needs a positive cost and a sale price range with the high not below the low.' };
  }
  const pct = (s: number) => r2(((s - costPerTonne) / s) * 100);
  return { low: pct(saleLow), high: pct(saleHigh), basis: 'Margin on sale price, from landed cost to the low and high sale price.' };
}
