export interface TariffRow {
  year: number;
  tariff_type: string;
  hs_revision: string | null;
  rate_pct: number | null;
  rate_measure: string | null;
  no_ad_valorem: number | boolean | null;
  total_lines: number | null;
  pref_lines: number | null;
  mfn_lines: number | null;
  na_lines: number | null;
  min_rate_pct: number | null;
  max_rate_pct: number | null;
  partner_code: string | null;
  source: string | null;
  source_url: string | null;
  retrieved_at: string | null;
}

export type TariffStatus = 'verified' | 'specific-duty' | 'unavailable';

export interface TariffRead {
  status: TariffStatus;
  /** One plain sentence a reader can act on. */
  headline: string;
  year: number | null;
  hs_revision: string | null;
  tariff_type: string | null;
  rate_pct: number | null;
  min_rate_pct: number | null;
  max_rate_pct: number | null;
  total_lines: number | null;
  /** True when the product heading holds several tariff lines at different rates. */
  mixed: boolean;
  source: string | null;
  source_url: string | null;
  retrieved_at: string | null;
  history: { year: number; rate_pct: number | null; status: TariffStatus }[];
  limitations: string[];
}

const LIMITS = [
  'This is the Most Favoured Nation (MFN) rate, the standard rate charged to trading partners without a special agreement. It is not necessarily the rate your goods pay.',
  'Preferential rates under trade agreements can be lower and are not shown. Whether a given exporter qualifies depends on rules of origin, which this page does not check.',
  'The rate is an average over the tariff lines in this six-digit heading, so a single line inside it can be higher or lower.',
];

const pct = (n: number) => (Math.round(n * 10) / 10).toString();

/**
 * Reads stored tariff rows for one product and importing market. Only a rate the source printed against real
 * lines is shown as a rate. A heading whose lines are all specific duties (a fixed amount per tonne) has no
 * percentage, and one with no row at all is unavailable. Nothing is estimated or filled in.
 */
export function readTariff(rows: TariffRow[], marketName: string): TariffRead {
  const mfn = rows.filter((r) => r.tariff_type === 'MFN' && r.partner_code === '000').sort((a, b) => b.year - a.year);
  const history = mfn.map((r) => ({
    year: r.year,
    rate_pct: r.no_ad_valorem ? null : r.rate_pct,
    status: (r.no_ad_valorem ? 'specific-duty' : r.rate_pct == null ? 'unavailable' : 'verified') as TariffStatus,
  })).sort((a, b) => a.year - b.year);
  const empty = { year: null, hs_revision: null, tariff_type: null, rate_pct: null, min_rate_pct: null, max_rate_pct: null, total_lines: null, mixed: false, source: null, source_url: null, retrieved_at: null };

  if (!mfn.length) {
    return { ...empty, status: 'unavailable', headline: `No verified tariff is held for ${marketName} for this product.`, history, limitations: ['A missing tariff is shown as unavailable. Tereflow does not estimate one.'] };
  }
  const latest = mfn[0];
  const base = {
    year: latest.year, hs_revision: latest.hs_revision, tariff_type: latest.tariff_type, total_lines: latest.total_lines,
    source: latest.source, source_url: latest.source_url, retrieved_at: latest.retrieved_at, history,
  };
  if (latest.no_ad_valorem) {
    return {
      ...base, status: 'specific-duty', rate_pct: null, min_rate_pct: null, max_rate_pct: null, mixed: false,
      headline: `${marketName} charges a fixed amount per unit on this product (a specific duty), so there is no percentage rate to show.`,
      limitations: ['The duty is a fixed charge such as an amount per tonne. Check the official tariff schedule for the exact amount.', ...LIMITS.slice(1, 2)],
    };
  }
  if (latest.rate_pct == null) {
    return { ...base, status: 'unavailable', rate_pct: null, min_rate_pct: null, max_rate_pct: null, mixed: false, headline: `No verified tariff is held for ${marketName} for this product.`, limitations: ['A missing tariff is shown as unavailable. Tereflow does not estimate one.'] };
  }
  const lo = latest.min_rate_pct;
  const hi = latest.max_rate_pct;
  const mixed = (latest.total_lines ?? 1) > 1 && lo != null && hi != null && hi - lo > 0.05;
  const headline = mixed
    ? `${marketName}'s MFN tariff averages ${pct(latest.rate_pct)}% across ${latest.total_lines} tariff lines in ${latest.year}, ranging from ${pct(lo as number)}% to ${pct(hi as number)}%.`
    : `${marketName}'s MFN tariff is ${pct(latest.rate_pct)}% in ${latest.year}.`;
  return { ...base, status: 'verified', rate_pct: latest.rate_pct, min_rate_pct: lo, max_rate_pct: hi, mixed, headline, limitations: LIMITS };
}
