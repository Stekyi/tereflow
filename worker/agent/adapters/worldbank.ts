import type { AdapterResult, FactRow } from '../types';

const BASE = 'https://api.worldbank.org/v2';
const SOURCE_REF = 'world-bank';

/**
 * World Bank fills the gaps Comtrade does not cover:
 *   - trade in SERVICES (Comtrade is merchandise only)
 *   - goods-and-services totals for the commerce-flow view
 *   - GDP, so trade can be expressed as a share of the economy
 *
 * Free, no key, ISO3 addressed, generous rate limit.
 */
const INDICATORS = {
  services_export: 'BX.GSR.NFSV.CD',
  services_import: 'BM.GSR.NFSV.CD',
  goods_services_export: 'NE.EXP.GNFS.CD',
  goods_services_import: 'NE.IMP.GNFS.CD',
  gdp: 'NY.GDP.MKTP.CD',
} as const;

export interface WorldBankContext {
  gdp_by_year: Record<number, number>;
  services_export_by_year: Record<number, number>;
  services_import_by_year: Record<number, number>;
  gns_export_by_year: Record<number, number>;
  gns_import_by_year: Record<number, number>;
}

export async function fetchWorldBank(
  iso3: string,
  years: number[],
): Promise<AdapterResult & { context: WorldBankContext }> {
  const from = Math.min(...years);
  const to = Math.max(...years);
  const rows: FactRow[] = [];
  const context: WorldBankContext = {
    gdp_by_year: {},
    services_export_by_year: {},
    services_import_by_year: {},
    gns_export_by_year: {},
    gns_import_by_year: {},
  };
  const notes: string[] = [];

  const entries = await Promise.all(
    Object.entries(INDICATORS).map(async ([key, code]) => {
      const series = await series_(iso3, code, from, to);
      return [key, series] as const;
    }),
  );

  for (const [key, series] of entries) {
    if (!series.ok) {
      notes.push(`${key}: ${series.error}`);
      continue;
    }
    for (const [year, value] of Object.entries(series.byYear)) {
      const y = Number(year);
      switch (key) {
        case 'gdp':
          context.gdp_by_year[y] = value;
          break;
        case 'services_export':
          context.services_export_by_year[y] = value;
          rows.push(serviceRow(y, 'export', value));
          break;
        case 'services_import':
          context.services_import_by_year[y] = value;
          rows.push(serviceRow(y, 'import', value));
          break;
        case 'goods_services_export':
          context.gns_export_by_year[y] = value;
          break;
        case 'goods_services_import':
          context.gns_import_by_year[y] = value;
          break;
      }
    }
  }

  return {
    rows,
    context,
    source_ref: SOURCE_REF,
    ok: rows.length > 0 || Object.keys(context.gdp_by_year).length > 0,
    note: notes.length ? notes.join('; ') : `World Bank series loaded for ${iso3}`,
  };
}

function serviceRow(year: number, flow: 'export' | 'import', value: number): FactRow {
  return {
    year,
    flow,
    stream: 'services',
    partner_iso3: null,
    partner_name: null,
    hs_code: null,
    product_name: 'Commercial services (all types)',
    sector: 'Services',
    value_usd: value,
    source_ref: SOURCE_REF,
  };
}

async function series_(
  iso3: string,
  indicator: string,
  from: number,
  to: number,
): Promise<{ ok: boolean; byYear: Record<number, number>; error?: string }> {
  const url =
    `${BASE}/country/${encodeURIComponent(iso3)}/indicator/${indicator}` +
    `?format=json&per_page=200&date=${from}:${to}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) return { ok: false, byYear: {}, error: `HTTP ${res.status}` };
    const body = (await res.json()) as unknown;
    if (!Array.isArray(body) || body.length < 2) return { ok: false, byYear: {}, error: 'no data' };
    const points = body[1] as { date: string; value: number | null }[] | null;
    const byYear: Record<number, number> = {};
    for (const p of points ?? []) {
      if (p?.value == null) continue;
      byYear[Number(p.date)] = p.value;
    }
    return { ok: true, byYear };
  } catch (err) {
    return { ok: false, byYear: {}, error: err instanceof Error ? err.message : 'fetch failed' };
  }
}
