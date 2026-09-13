/**
 * Trade observations from a PDF report.
 *
 * Some statistics offices publish a monthly trade bulletin as a PDF and nothing
 * else. The analytics must not care: types.ts already says "adding Nigeria
 * should mean a new config and a new parser, not a new branch in the maths",
 * and a source arriving as a table in a document rather than as JSON over HTTP
 * is the same principle one layer out.
 *
 * So this produces TradeObservation and nothing downstream can tell where a
 * figure came from. The column mapping lives in config, not in code, because
 * every office lays its tables out differently and a new layout should be a new
 * row in entity_sources rather than a new branch in here.
 *
 * WHAT THIS REFUSES TO DO
 *
 * A PDF is a layout, not a data format. Text extraction gets columns wrong when
 * a table wraps, a cell spans, or a footnote sits mid-row, and the result is a
 * number in the wrong field rather than a parse error. Two consequences:
 *
 *   - Every row that cannot be read completely is rejected with the raw text
 *     attached, never guessed at and never partially kept.
 *   - The rejection count is reported alongside the accepted count, so a run
 *     that read a fifth of the document is visibly different from one that read
 *     all of it. Those two look identical if you only publish what worked.
 */
import type {
  ClassificationLevel,
  PartnerMapping,
  ProviderResult,
  TradeFlow,
  TradeObservation,
} from './types';

/** A row as a text extractor hands it over: column name to cell text. */
export type RawRecord = Record<string, string>;

/**
 * Which column holds what.
 *
 * Stored in entity_sources.config_json. Names are matched case-insensitively
 * and ignoring punctuation, because "Net Weight (Kg)" and "net_weight_kg" are
 * the same column and a source is entitled to spell it either way.
 */
export interface PdfColumnMap {
  product_code: string;
  product_description?: string;
  partner_country?: string;
  value_usd: string;
  net_weight_kg?: string;
  year?: string;
  month?: string;
}

export interface PdfSourceConfig {
  columns: PdfColumnMap;
  classification_level: ClassificationLevel;
  /** Used when the table has no year column, which is common in an annual report. */
  default_year?: number;
  /** Used when the table has no partner column: a national total, not a bilateral one. */
  default_partner?: string;
  trade_flow: TradeFlow;
  /**
   * Multiplier to reach US dollars. A report in thousands sets 1000. Explicit
   * because a table headed "US$ '000" read as units understates by a thousandfold
   * and still looks like a plausible number.
   */
  value_multiplier?: number;
  /** Multiplier to reach kilograms. A report in tonnes sets 1000. */
  weight_multiplier?: number;
}

function normaliseKey(key: string): string {
  return key.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/** Finds a column by name, tolerating spelling and punctuation differences. */
function cell(record: RawRecord, column: string | undefined): string | null {
  if (!column) return null;
  if (record[column] != null) return record[column];
  const want = normaliseKey(column);
  for (const [k, v] of Object.entries(record)) {
    if (normaliseKey(k) === want) return v;
  }
  return null;
}

/**
 * A number from a report cell.
 *
 * Returns null rather than 0 for anything unreadable. Zero is a real figure
 * meaning "no trade"; an unparseable cell means the extractor lost the column,
 * and turning the second into the first would fill the dataset with confident
 * zeroes.
 *
 * Handles the shapes reports actually use: thousands separators, a currency
 * symbol, and parentheses for negatives.
 */
export function parseReportNumber(text: string | null): number | null {
  if (text == null) return null;
  const trimmed = text.trim();
  if (!trimmed) return null;
  // A dash or an explicit marker is the source saying "nothing here", which is
  // a statement rather than a gap.
  if (/^[-–—]$|^n\/?a$|^nil$|^\.\.$/i.test(trimmed)) return 0;

  const negative = /^\(.*\)$/.test(trimmed);
  const inner = negative ? trimmed.slice(1, -1) : trimmed;

  // Strip only what a report legitimately decorates a number with: currency
  // symbols and codes, thousands separators, percent signs, whitespace.
  //
  // The currency words are stripped without a trailing word boundary, because
  // "US$" ends in a symbol and \b after it never matches, which left "US4500"
  // behind and rejected a perfectly readable cell.
  const stripped = inner
    .replace(/\b(?:us\$|usd|ghs|eur|gbp|kgs?|tonnes?|mt)/gi, '')
    .replace(/[$€£¥₵%,\s]/g, '');

  // What is left has to be the whole number and nothing else. Without this,
  // "see note 3" strips down to "3" and a footnote reference becomes a trade
  // value: a real figure, in the right column, off by whatever the true number
  // was. Nothing downstream could detect it.
  if (!/^[+-]?\d+(?:\.\d+)?$/.test(stripped)) return null;

  const n = Number(stripped);
  if (!Number.isFinite(n)) return null;
  return negative ? -Math.abs(n) : n;
}

/** The HS code from a cell, at the depth the config says to expect. */
function parseProductCode(text: string | null, level: ClassificationLevel): string | null {
  if (!text) return null;
  const m = text.trim().match(/^(\d{2,10})/);
  if (!m) return null;
  const want = level === 'HS2' ? 2 : level === 'HS4' ? 4 : level === 'HS6' ? 6 : 10;
  const digits = m[1];
  // A shorter code than declared is a different product than the one claimed,
  // so it is rejected rather than padded. Padding "07" to "070000" invents a
  // specific product out of a chapter.
  if (digits.length < want) return null;
  return digits.slice(0, want);
}

export interface PdfParseInput {
  records: RawRecord[];
  config: PdfSourceConfig;
  countryCode: string;
  partners: PartnerMapping[];
  sourceName: string;
  sourceEndpoint: string;
  retrievedAt?: string;
}

/**
 * Turns extracted rows into observations.
 *
 * Deterministic and offline: no fetch, no clock unless one is handed in. The
 * same rows in produce the same observations out, which is what makes a run
 * arguable after the fact.
 */
export function recordsToObservations(input: PdfParseInput): {
  observations: TradeObservation[];
  rejected: Array<{ reason: string; detail: string }>;
} {
  const { records, config, countryCode, partners } = input;
  const observations: TradeObservation[] = [];
  const rejected: Array<{ reason: string; detail: string }> = [];
  const retrievedAt = input.retrievedAt ?? new Date().toISOString();

  const valueScale = config.value_multiplier ?? 1;
  const weightScale = config.weight_multiplier ?? 1;

  // Source spelling to this application's name, built once.
  const partnerBySource = new Map<string, PartnerMapping>();
  for (const p of partners) partnerBySource.set(normaliseKey(p.source_name), p);

  for (const record of records) {
    const detail = JSON.stringify(record).slice(0, 300);

    const code = parseProductCode(cell(record, config.columns.product_code), config.classification_level);
    if (!code) {
      // Header rows, totals lines and footnotes all land here. That is the
      // normal case for a PDF and is why the rejection count is reported rather
      // than treated as a failure on its own.
      rejected.push({
        reason: `No ${config.classification_level} product code in this row.`,
        detail,
      });
      continue;
    }

    const value = parseReportNumber(cell(record, config.columns.value_usd));
    if (value == null) {
      rejected.push({ reason: 'Value column could not be read as a number.', detail });
      continue;
    }

    const year = config.columns.year
      ? parseReportNumber(cell(record, config.columns.year))
      : (config.default_year ?? null);
    if (year == null || year < 1900 || year > 2100) {
      rejected.push({
        reason: config.columns.year
          ? 'Year column could not be read as a year.'
          : 'No year column and no default year configured.',
        detail,
      });
      continue;
    }

    const partnerText = config.columns.partner_country
      ? cell(record, config.columns.partner_country)
      : (config.default_partner ?? null);
    if (!partnerText) {
      rejected.push({ reason: 'No partner column and no default partner configured.', detail });
      continue;
    }

    // An unmapped partner is rejected rather than passed through under its
    // source spelling. Keeping it would put a name in the data that nothing
    // else in the application can join to, and it would silently become its
    // own country in every ranking.
    const mapped = partnerBySource.get(normaliseKey(partnerText));
    if (!mapped) {
      rejected.push({
        reason: `Partner "${partnerText}" is not in this country's partner mapping.`,
        detail,
      });
      continue;
    }

    const weight = config.columns.net_weight_kg
      ? parseReportNumber(cell(record, config.columns.net_weight_kg))
      : null;

    const month = config.columns.month ? parseReportNumber(cell(record, config.columns.month)) : 0;

    observations.push({
      country_code: countryCode,
      year,
      month: month != null && month >= 1 && month <= 12 ? month : 0,
      trade_flow: config.trade_flow,
      classification_system: 'HS',
      classification_level: config.classification_level,
      product_code: code,
      product_description: cell(record, config.columns.product_description) ?? null,
      partner_country: mapped.app_name,
      partner_iso3: mapped.iso3,
      import_value_usd: value * valueScale,
      net_weight_kg: weight != null && weight > 0 ? weight * weightScale : null,
      // A figure printed in a report is a reported figure, not one this
      // application summed from months.
      value_is_derived: false,
      months_counted: month != null && month >= 1 && month <= 12 ? 1 : 12,
      source: input.sourceName,
      source_endpoint: input.sourceEndpoint,
      retrieved_at: retrievedAt,
    });
  }

  return { observations, rejected };
}

/**
 * Everything a run needs from one PDF, in the shape every provider returns.
 *
 * `extractText` is injected because pdf-parse is a Node library and this module
 * has to stay testable without it, and without the network.
 */
export async function fetchPdfObservations(args: {
  url: string;
  config: PdfSourceConfig;
  countryCode: string;
  partners: PartnerMapping[];
  sourceName: string;
  extractRecords: (bytes: ArrayBuffer) => Promise<RawRecord[]>;
  fetchImpl?: typeof fetch;
}): Promise<ProviderResult> {
  const doFetch = args.fetchImpl ?? fetch;
  const notes: string[] = [];

  let response: Response;
  try {
    response = await doFetch(args.url);
  } catch (err) {
    return {
      ok: false,
      observations: [],
      raw: [],
      rejected: [],
      notes,
      error: `Could not reach ${args.url}: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (!response.ok) {
    return {
      ok: false,
      observations: [],
      raw: [],
      rejected: [],
      notes,
      error: `${args.url} returned ${response.status} ${response.statusText}`,
    };
  }

  const bytes = await response.arrayBuffer();
  let records: RawRecord[];
  try {
    records = await args.extractRecords(bytes);
  } catch (err) {
    return {
      ok: false,
      observations: [],
      raw: [],
      rejected: [],
      notes,
      error: `Could not read the PDF: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const { observations, rejected } = recordsToObservations({
    records,
    config: args.config,
    countryCode: args.countryCode,
    partners: args.partners,
    sourceName: args.sourceName,
    sourceEndpoint: args.url,
  });

  notes.push(
    `Read from a PDF report. ${observations.length} of ${records.length} extracted rows became ` +
      'observations; the rest were headers, totals, or rows the text extractor could not read cleanly.',
  );

  // A document that yielded almost nothing usually means the column mapping no
  // longer matches the layout, which is a different problem from a quiet year.
  if (records.length > 0 && observations.length === 0) {
    notes.push(
      'No row in the document matched the configured columns. The report layout has probably changed.',
    );
  }

  return {
    ok: observations.length > 0,
    observations,
    // The extracted rows, kept so a parser bug can be told from a layout change.
    raw: [
      {
        endpoint: args.url,
        request: { columns: args.config.columns },
        http_status: response.status,
        content_type: response.headers.get('content-type'),
        body: JSON.stringify(records).slice(0, 200_000),
      },
    ],
    rejected,
    notes,
    error: observations.length > 0 ? null : 'The document produced no usable observations.',
  };
}
