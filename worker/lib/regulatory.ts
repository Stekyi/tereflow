import { parseCommodity, pickCommodity, type RegulatorySummary } from '../../shared/regulatory';

const BASE = 'https://www.trade-tariff.service.gov.uk/api/v2';
const TIMEOUT_MS = 9000;
const CACHE_SECONDS = 43_200;

export type RegulatoryResult =
  | {
      available: true;
      source: string;
      scope: string;
      summary: RegulatorySummary;
      /** How many tariff lines sit under the requested code; the summary is for the first one. */
      lines: number;
      limitations: string[];
    }
  | { available: false; reason: string; scope: string };

const SCOPE = 'UK import rules only. Export rules and other countries\u2019 import rules are not covered.';
const SOURCE = 'UK Trade Tariff (trade-tariff.service.gov.uk)';

async function get(path: string): Promise<unknown | null> {
  const res = await fetch(`${BASE}${path}`, {
    headers: { accept: 'application/json' },
    signal: AbortSignal.timeout(TIMEOUT_MS),
    cf: { cacheTtl: CACHE_SECONDS, cacheEverything: true },
  } as RequestInit);
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`UK Trade Tariff returned ${res.status}`);
  return res.json();
}

/** Looks up the standard UK import rules for a 6 to 10 digit code. Never guesses: anything it cannot resolve is reported as unavailable. */
export async function loadRegulatory(hs: string): Promise<RegulatoryResult> {
  if (!/^\d{6,10}$/.test(hs)) {
    return { available: false, scope: SCOPE, reason: 'Rules are looked up for a product line of 6 or more digits.' };
  }
  const prefix = hs.length >= 8 ? hs.slice(0, 8) : hs.slice(0, 6);
  try {
    const heading = (await get(`/headings/${hs.slice(0, 4)}`)) as Parameters<typeof pickCommodity>[0];
    let picked = pickCommodity(heading, prefix);
    // A heading that is itself a tariff line lists no lines beneath it; its line is the code padded with zeros.
    if (!picked && heading && !(heading.included ?? []).some((x) => x.type === 'commodity')) {
      picked = { code: hs.slice(0, 6).padEnd(10, '0'), lines: 1 };
    }
    if (!picked) return { available: false, scope: SCOPE, reason: 'No tariff line was found for this code.' };
    const summary = parseCommodity((await get(`/commodities/${picked.code}`)) as Parameters<typeof parseCommodity>[0]);
    if (!summary) return { available: false, scope: SCOPE, reason: 'The tariff has no rules recorded for this line.' };
    return {
      available: true,
      source: SOURCE,
      scope: SCOPE,
      summary,
      lines: picked.lines,
      limitations: [
        picked.lines > 1
          ? `This code covers ${picked.lines} tariff lines; the rules shown are for ${summary.commodity_code}, and the others can differ.`
          : 'The rules shown are for this single tariff line.',
        'Rates and controls change; check the live tariff before relying on them for a shipment.',
      ],
    };
  } catch (e) {
    return { available: false, scope: SCOPE, reason: e instanceof Error && e.name === 'TimeoutError' ? 'The UK Trade Tariff did not answer in time.' : 'The UK Trade Tariff could not be reached.' };
  }
}
