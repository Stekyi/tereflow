/**
 * Ghana StatBank, read through the PXWeb API.
 *
 * Fetches and normalises. It does not score, rank or judge anything: the
 * analytics engine downstream is meant to work the same whether the numbers
 * came from Accra, Abuja or a spreadsheet.
 *
 * Two things about this endpoint that cost real data if you assume otherwise.
 *
 * 1. THE ANNUAL CELL IS NOT ALWAYS POPULATED. The dimension offers "All Months"
 *    as a pre-aggregated year. For 2021 to 2024 it agrees with the sum of the
 *    twelve months exactly. For 2025 it is null while all twelve months hold
 *    data, nationally about 20.5 billion dollars of it. Asking only for "All
 *    Months" therefore drops the freshest year and nothing anywhere says so.
 *    This provider asks for months and sums them, and marks any total it
 *    derived that way, because a derived figure is not the same claim as a
 *    reported one.
 *
 * 2. A PARTNER NAME THAT DOES NOT MATCH RETURNS AN EMPTY CUBE, NOT AN ERROR.
 *    The names are mapped in the country config from ours to StatBank's. Five
 *    differ, including the United States. A mismatch would have that country
 *    contribute zero to every share with nothing to show why.
 */
import type {
  CountryConfig,
  PartnerMapping,
  ProviderResult,
  TradeDataProvider,
  TradeFlow,
  TradeObservation,
} from './types';

/** json-stat2, the shape PXWeb returns when asked for it. */
interface JsonStat2 {
  class?: string;
  label?: string;
  source?: string;
  updated?: string;
  id: string[];
  size: number[];
  dimension: Record<string, { category: { index: Record<string, number> | string[]; label?: Record<string, string> } }>;
  value: Array<number | null>;
}

/**
 * PXWeb refuses a request whose selection is too large, and the refusal is an
 * HTML error page rather than JSON. Requesting one chapter at a time across all
 * partners keeps every call comfortably inside the limit and means one bad
 * chapter cannot lose the whole run.
 */
const MAX_ATTEMPTS = 3;
const RETRY_PAUSE_MS = 1500;
const REQUEST_TIMEOUT_MS = 90_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class GhanaStatBankProvider implements TradeDataProvider {
  readonly name = 'ghana-statbank';

  async fetchObservations(input: {
    config: CountryConfig;
    flow: TradeFlow;
    years: string[];
    partners: PartnerMapping[];
    products: string[] | 'all';
  }): Promise<ProviderResult> {
    const { config, flow, years, partners } = input;
    const result: ProviderResult = {
      ok: false,
      observations: [],
      raw: [],
      rejected: [],
      notes: [],
      error: null,
    };

    let chapters: string[];
    try {
      const meta = await this.metadata(config.provider.endpoint);
      chapters = this.chaptersFrom(meta, config);
      const offered = this.yearsFrom(meta, config);
      const missing = years.filter((y) => !offered.includes(y));
      if (missing.length) {
        // Asking for a year the source does not carry is not an error, but
        // silently returning fewer years than requested would make a shrinking
        // dataset look like shrinking trade.
        result.notes.push(
          `Requested ${missing.join(', ')} but the source offers only ${offered.join(', ')}.`,
        );
      }
    } catch (err) {
      result.error = `Could not read the StatBank dimensions: ${message(err)}`;
      return result;
    }

    const wanted = input.products === 'all'
      ? chapters
      : chapters.filter((c) => input.products.includes(chapterCode(c)));

    if (!wanted.length) {
      result.error = 'No product chapters matched the request.';
      return result;
    }

    const retrievedAt = new Date().toISOString();
    let anySucceeded = false;

    for (const chapter of wanted) {
      try {
        const { observations, raw, rejected, notes } = await this.fetchChapter({
          config,
          flow,
          years,
          partners,
          chapter,
          retrievedAt,
        });
        result.observations.push(...observations);
        result.raw.push(raw);
        result.rejected.push(...rejected);
        result.notes.push(...notes);
        anySucceeded = true;
      } catch (err) {
        // One chapter failing is a gap, not a dead run. It is recorded so the
        // gap is visible rather than looking like a chapter with no trade.
        result.rejected.push({
          reason: 'chapter_fetch_failed',
          detail: `${chapterCode(chapter)}: ${message(err)}`,
        });
      }
    }

    if (!anySucceeded) {
      result.error = 'Every chapter request failed. No data was retrieved.';
      return result;
    }

    result.ok = result.observations.length > 0;
    if (!result.ok) {
      result.error = 'The source answered but returned no usable observations.';
    }
    return result;
  }

  private async metadata(endpoint: string): Promise<{ variables: Array<{ code: string; values: string[] }> }> {
    const res = await fetch(endpoint, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} reading dimensions`);
    return (await res.json()) as { variables: Array<{ code: string; values: string[] }> };
  }

  private chaptersFrom(
    meta: { variables: Array<{ code: string; values: string[] }> },
    config: CountryConfig,
  ): string[] {
    const dim = meta.variables.find((v) => v.code === config.provider.dimensions.product);
    if (!dim) throw new Error(`The endpoint has no ${config.provider.dimensions.product} dimension.`);
    return dim.values.filter((v) => v !== config.provider.values.all_products);
  }

  private yearsFrom(
    meta: { variables: Array<{ code: string; values: string[] }> },
    config: CountryConfig,
  ): string[] {
    const dim = meta.variables.find((v) => v.code === config.provider.dimensions.year);
    return dim ? dim.values : [];
  }

  /**
   * One chapter, every requested partner, every requested year, by month.
   *
   * Months rather than "All Months" on purpose: see the note at the top of this
   * file. Summing twelve cells we can see beats trusting one cell that is
   * sometimes empty.
   */
  private async fetchChapter(input: {
    config: CountryConfig;
    flow: TradeFlow;
    years: string[];
    partners: PartnerMapping[];
    chapter: string;
    retrievedAt: string;
  }): Promise<{
    observations: TradeObservation[];
    raw: ProviderResult['raw'][number];
    rejected: ProviderResult['rejected'];
    notes: string[];
  }> {
    const { config, flow, years, partners, chapter, retrievedAt } = input;
    const d = config.provider.dimensions;
    const v = config.provider.values;

    const query = [
      { code: d.valuation, selection: { filter: 'item', values: [v.value_usd, v.weight_kg] } },
      { code: d.flow, selection: { filter: 'item', values: [flow === 'import' ? v.flow_import : v.flow_export] } },
      { code: d.year, selection: { filter: 'item', values: years } },
      { code: d.month, selection: { filter: 'item', values: v.months } },
      { code: d.product, selection: { filter: 'item', values: [chapter] } },
      { code: d.partner, selection: { filter: 'item', values: partners.map((p) => p.source_name) } },
    ];
    const request = { query, response: { format: 'json-stat2' } };

    const { body, status, contentType } = await this.post(config.provider.endpoint, request);

    let cube: JsonStat2;
    try {
      cube = JSON.parse(body) as JsonStat2;
    } catch {
      // PXWeb answers an over-large or malformed selection with an HTML error
      // page. Saying so beats "unexpected token < in JSON".
      throw new Error(
        `The source did not return JSON (HTTP ${status}, ${contentType ?? 'no content type'}). ` +
        `It usually means the selection was refused: ${body.slice(0, 140).replace(/\s+/g, ' ')}`,
      );
    }

    const read = cellReader(cube);
    const observations: TradeObservation[] = [];
    const rejected: ProviderResult['rejected'] = [];
    const notes: string[] = [];
    const code = chapterCode(chapter);
    const description = chapterDescription(chapter);
    let derivedYears = 0;

    for (const partner of partners) {
      for (const year of years) {
        let valueSum = 0;
        let weightSum = 0;
        let monthsWithValue = 0;
        let sawWeight = false;
        let bad = false;

        for (let m = 0; m < v.months.length; m++) {
          const pick = {
            [d.flow]: flow === 'import' ? v.flow_import : v.flow_export,
            [d.year]: year,
            [d.month]: v.months[m],
            [d.product]: chapter,
            [d.partner]: partner.source_name,
          };
          const value = read({ ...pick, [d.valuation]: v.value_usd });
          const weight = read({ ...pick, [d.valuation]: v.weight_kg });

          if (value != null) {
            if (!Number.isFinite(value) || value < 0) {
              // A negative import value is not a small import, it is a figure
              // that would quietly subtract from a total.
              rejected.push({
                reason: 'implausible_value',
                detail: `${code} ${partner.app_name} ${year}-${m + 1}: value ${value}`,
              });
              bad = true;
              continue;
            }
            valueSum += value;
            monthsWithValue++;
          }
          if (weight != null && Number.isFinite(weight) && weight >= 0) {
            weightSum += weight;
            sawWeight = true;
          }
        }

        if (bad || monthsWithValue === 0) continue;

        observations.push({
          country_code: config.code,
          year: Number(year),
          month: 0,
          trade_flow: flow,
          classification_system: 'HS',
          classification_level: config.classification.level,
          product_code: code,
          product_description: description,
          partner_country: partner.app_name,
          partner_iso3: partner.iso3,
          import_value_usd: valueSum,
          // Zero weight is not a weight. Left null so a unit value is refused
          // rather than computed as a division by nothing.
          net_weight_kg: sawWeight && weightSum > 0 ? weightSum : null,
          // Always derived here, because this provider always sums months. The
          // flag stays honest about how the annual figure was arrived at.
          value_is_derived: true,
          months_counted: monthsWithValue,
          source: 'Ghana Statistical Service',
          source_endpoint: config.provider.endpoint,
          retrieved_at: retrievedAt,
        });
        if (monthsWithValue < 12) derivedYears++;
      }
    }

    if (derivedYears > 0) {
      notes.push(
        `${code}: ${derivedYears} country-year totals cover fewer than twelve months. ` +
        `A part year compared against a full one reads as a fall in demand, so these are marked.`,
      );
    }

    return {
      observations,
      raw: {
        endpoint: config.provider.endpoint,
        request,
        http_status: status,
        content_type: contentType,
        body,
      },
      rejected,
      notes,
    };
  }

  private async post(
    endpoint: string,
    request: unknown,
  ): Promise<{ body: string; status: number; contentType: string | null }> {
    let lastError = 'unknown';
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify(request),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
        const body = await res.text();
        if (res.ok) {
          return { body, status: res.status, contentType: res.headers.get('content-type') };
        }
        // A 4xx is the server saying the request is wrong, which retrying does
        // not fix. Only a 5xx or a rate limit is worth another attempt.
        if (res.status < 500 && res.status !== 429) {
          throw new Error(`HTTP ${res.status}: ${body.slice(0, 160).replace(/\s+/g, ' ')}`);
        }
        lastError = `HTTP ${res.status}`;
      } catch (err) {
        lastError = message(err);
        if (/HTTP 4/.test(lastError)) throw err;
      }
      if (attempt < MAX_ATTEMPTS) await sleep(RETRY_PAUSE_MS * attempt);
    }
    throw new Error(`Request failed after ${MAX_ATTEMPTS} attempts: ${lastError}`);
  }
}

/**
 * Read a json-stat2 cube by dimension labels.
 *
 * The value array is flat and its order depends on the order of `id` and the
 * sizes in `size`. Computing the offset from the labels, rather than assuming a
 * layout, means a reordering upstream produces no data instead of the wrong
 * data. Silent misalignment is the worse failure by a long way.
 */
export function cellReader(cube: JsonStat2): (pick: Record<string, string>) => number | null {
  const ids = cube.id;
  const sizes = cube.size;
  const positions: Record<string, (key: string) => number> = {};

  for (const dim of ids) {
    const index = cube.dimension[dim]?.category?.index;
    if (Array.isArray(index)) {
      positions[dim] = (key: string) => index.indexOf(key);
    } else if (index && typeof index === 'object') {
      positions[dim] = (key: string) => (key in index ? index[key] : -1);
    } else {
      positions[dim] = () => -1;
    }
  }

  return (pick) => {
    let offset = 0;
    for (let i = 0; i < ids.length; i++) {
      const dim = ids[i];
      const key = pick[dim];
      if (key === undefined) return null;
      const pos = positions[dim](key);
      if (pos < 0) return null;
      offset = offset * sizes[i] + pos;
    }
    const v = cube.value[offset];
    return v == null ? null : v;
  };
}

/** "34 - Soap, organic surface-active agents, ..." becomes "34". */
export function chapterCode(label: string): string {
  const m = label.match(/^\s*(\d{1,2})\s*-/);
  return m ? m[1].padStart(2, '0') : label.slice(0, 2);
}

/** The readable half of a chapter label, without the leading code. */
export function chapterDescription(label: string): string {
  const m = label.match(/^\s*\d{1,2}\s*-\s*(.+)$/);
  return (m ? m[1] : label).trim();
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
