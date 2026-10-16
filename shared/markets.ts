/**
 * Comtrade's catch-all partner areas. They carry real trade but are not countries, so they have no tariff,
 * no currency and no market to assess. They are excluded wherever a buyer or a market is named.
 */
export const NOT_A_MARKET = new Set(['WLD', '_X', '_X ', 'X1', 'X2', 'XX', 'ZZ', 'E19', 'F19', 'F97', 'R91', 'S19', 'U2', 'XA', 'XB']);

export const isMarket = (iso3: string): boolean => iso3.trim() !== '' && !NOT_A_MARKET.has(iso3) && !NOT_A_MARKET.has(iso3.trim());
