/**
 * Partner codes that are not a single country.
 *
 * Comtrade reports some trade against areas it cannot attribute to one country: "areas, nes", bunkers,
 * free zones, and groupings such as "Other Asia, nes". They carry real trade, so the figures stay in the
 * totals, but they are not a buyer, a supplier, a market or a currency, and they have no tariff. They must
 * never be named as a top partner or measured for concentration, and they should be described as what they
 * are rather than shown as a raw code.
 *
 * Codes can arrive with trailing spaces ("_X "), so every lookup trims first.
 */
export const AREA_NAMES: Record<string, string> = {
  WLD: 'World',
  S19: 'Other Asia, not elsewhere specified',
  _X: 'Areas, not elsewhere specified',
  XX: 'Special categories',
  X1: 'Special categories (1)',
  X2: 'Special categories (2)',
  E19: 'Europe, not elsewhere specified',
  F19: 'Free zones',
  A79: 'Western Asia, not elsewhere specified',
  O19: 'Oceania, not elsewhere specified',
  A59: 'Other areas, not elsewhere specified',
};

const clean = (iso3: string | null | undefined): string => (iso3 ?? '').trim();

/** True for a single country or territory that can buy, sell, charge a tariff and hold a currency. */
export const isMarket = (iso3: string | null | undefined): boolean => {
  const c = clean(iso3);
  return /^[A-Z]{3}$/.test(c) && !(c in AREA_NAMES);
};

/** The plain name of a non-country area, or null for anything else. */
export const areaName = (iso3: string | null | undefined): string | null => AREA_NAMES[clean(iso3)] ?? null;

/**
 * What to call a partner. A country gets its name, a known area gets its description, and an unknown code is
 * labelled as unrecognised instead of leaking the raw code as if it were a place.
 */
export function partnerName(iso3: string | null | undefined, countryNames: Record<string, string>): string {
  const c = clean(iso3);
  if (!c) return 'Unspecified';
  return countryNames[c] ?? AREA_NAMES[c] ?? `Unrecognised area (${c})`;
}

/** Keeps only real markets, for any place that picks a top buyer, a top supplier or measures concentration. */
export function onlyMarkets<T extends { iso3: string }>(rows: T[]): T[] {
  return rows.filter((r) => isMarket(r.iso3));
}
