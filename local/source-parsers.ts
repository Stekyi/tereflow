import * as XLSX from 'xlsx';
import { PDFParse } from 'pdf-parse';
import type { EntitySource, Flow, Stream } from '../shared/types';
import type { AdapterResult, FactRow } from '../worker/agent/types';

export interface SourceParserConfig {
  method?: 'GET' | 'POST';
  request_body?: unknown;
  headers?: Record<string, string>;
  year?: string;
  flow?: string;
  stream?: string;
  value_usd?: string;
  value?: string;
  currency?: string;
  exchange_rate?: number;
  hs_code?: string;
  product_name?: string;
  sector?: string;
  partner_iso3?: string;
  partner_name?: string;
  qty?: string;
  qty_unit?: string;
  rows_path?: string;
  delimiter?: string;
  header_row?: number;
  pdf_line_pattern?: string;
}

export interface SourceFetchContext {
  source: EntitySource;
  iso3: string;
  years: number[];
}

type RawRecord = Record<string, unknown>;

const asText = (value: unknown): string => (value == null ? '' : String(value).trim());
const asNumber = (value: unknown): number | null => {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const cleaned = asText(value).replace(/[,%\s]/g, '');
  if (!cleaned) return null;
  const n = Number(cleaned);
  return Number.isFinite(n) ? n : null;
};

const FIELD_ALIASES: Record<string, string[]> = {
  year: ['year', 'period', 'refyear', 'time', 'date'],
  flow: ['flow', 'tradeflow', 'direction', 'trade_type', 'type'],
  value: ['value_usd', 'trade_value_usd', 'value', 'trade_value', 'amount', 'us dollars', 'usd'],
  hs_code: ['hs_code', 'hscode', 'hs', 'commodity_code', 'product_code', 'item_code'],
  product_name: ['product_name', 'product', 'commodity', 'commodity_name', 'item', 'description'],
  partner_iso3: ['partner_iso3', 'partner_iso', 'reporter_iso3', 'country_code'],
  partner_name: ['partner_name', 'partner', 'country', 'destination', 'origin'],
  qty: ['qty', 'quantity', 'net_weight', 'weight'],
  qty_unit: ['qty_unit', 'unit', 'quantity_unit', 'weight_unit'],
  stream: ['stream', 'product_type', 'trade_stream'],
  sector: ['sector', 'industry', 'category'],
};

function normalizedKeys(record: RawRecord): Map<string, string> {
  return new Map(Object.keys(record).map((key) => [key.toLowerCase().replace(/[^a-z0-9]+/g, '_'), key]));
}

function inferredField(record: RawRecord, requested: string | undefined, kind: string): string | undefined {
  if (requested && requested in record) return requested;
  const keys = normalizedKeys(record);
  const aliases = FIELD_ALIASES[kind] ?? [];
  for (const alias of aliases) {
    const key = keys.get(alias.replace(/[^a-z0-9]+/g, '_'));
    if (key) return key;
  }
  return undefined;
}

function configOf(source: EntitySource): SourceParserConfig {
  try {
    const parsed = JSON.parse(source.config_json || '{}') as unknown;
    return parsed && typeof parsed === 'object' ? (parsed as SourceParserConfig) : {};
  } catch {
    throw new Error(`Invalid parser config for ${source.url}`);
  }
}

function requireMachineSource(source: EntitySource) {
  const parser = source.parser_key === 'auto' ? source.fmt : source.parser_key;
  if (parser === 'html' && source.endpoint_type === 'html_download') return;
}

function getPath(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  return path.split('.').reduce<unknown>((current, key) => {
    if (Array.isArray(current) && /^\d+$/.test(key)) return current[Number(key)];
    if (current && typeof current === 'object') return (current as Record<string, unknown>)[key];
    return undefined;
  }, value);
}

function recordsFromJson(body: unknown, config: SourceParserConfig): RawRecord[] {
  const rows = getPath(body, config.rows_path);
  if (!Array.isArray(rows)) throw new Error('JSON source did not contain an array at rows_path');
  return rows.filter((row): row is RawRecord => Boolean(row && typeof row === 'object'));
}

function parseCsv(text: string, delimiter = ','): RawRecord[] {
  const lines = text.replace(/^\uFEFF/, '').split(/\r?\n/).filter((line) => line.trim());
  if (lines.length < 2) return [];
  const split = (line: string) => line.split(delimiter).map((cell) => cell.trim().replace(/^"|"$/g, ''));
  const headers = split(lines[0]);
  return lines.slice(1).map((line) => {
    const cells = split(line);
    return Object.fromEntries(headers.map((header, i) => [header, cells[i] ?? '']));
  });
}

function parseSdmx(text: string, config: SourceParserConfig): RawRecord[] {
  const rows = parseCsv(text, config.delimiter ?? ',');
  if (rows.length) return rows;
  const matches = [...text.matchAll(/<Obs[^>]*TIME_PERIOD="([^"]+)"[^>]*OBS_VALUE="([^"]+)"[^>]*>/g)];
  return matches.map((match) => ({
    [config.year ?? 'year']: match[1],
    [config.value ?? 'value']: match[2],
  }));
}

function parseJsonStat(body: unknown, config: SourceParserConfig): RawRecord[] {
  const data = body as { id?: string[]; size?: number[]; dimension?: Record<string, { category?: { index?: Record<string, number> } }>; value?: unknown[] };
  if (!data?.id || !data.size || !Array.isArray(data.value)) throw new Error('Invalid JSON-stat dataset');
  const dimensions = data.id;
  return data.value.map((value, flatIndex) => {
    let remainder = flatIndex;
    const row: RawRecord = { [config.value ?? 'value']: value };
    for (let i = dimensions.length - 1; i >= 0; i--) {
      const size = data.size![i];
      const index = remainder % size;
      remainder = Math.floor(remainder / size);
      const dim = data.dimension?.[dimensions[i]]?.category?.index ?? {};
      const key = Object.entries(dim).find(([, position]) => position === index)?.[0] ?? String(index);
      row[dimensions[i]] = key;
    }
    return row;
  });
}

function parseHtml(text: string): RawRecord[] {
  const rows: RawRecord[] = [];
  for (const match of text.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)) {
    const cells = [...match[1].matchAll(/<(?:td|th)[^>]*>([\s\S]*?)<\/(?:td|th)>/gi)]
      .map((cell) => cell[1].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim());
    if (cells.length) rows.push(Object.fromEntries(cells.map((cell, index) => [`column_${index}`, cell])));
  }
  if (rows.length < 2) return [];
  const headers = Object.values(rows[0]);
  return rows.slice(1).map((row) => Object.fromEntries(Object.values(row).map((value, i) => [headers[i], value])));
}

function toFactRows(records: RawRecord[], source: EntitySource, iso3: string, config: SourceParserConfig): FactRow[] {
  const rows: FactRow[] = [];
  for (const record of records) {
    const year = asNumber(record[inferredField(record, config.year, 'year') ?? 'year']);
    const value = asNumber(record[inferredField(record, config.value_usd ?? config.value, 'value') ?? 'value']);
    const rawFlow = asText(record[inferredField(record, config.flow, 'flow') ?? 'flow']).toLowerCase();
    const flow: Flow = rawFlow.startsWith('im') || rawFlow === 'm' || source.category === 'import' ? 'import' : 'export';
    const stream: Stream = (asText(record[inferredField(record, config.stream, 'stream') ?? 'stream']).toLowerCase() || 'goods') === 'services' ? 'services' : 'goods';
    if (!year || value == null) continue;
    const rate = config.exchange_rate ?? 1;
    rows.push({
      year,
      flow,
      stream,
      partner_iso3: asText(record[inferredField(record, config.partner_iso3, 'partner_iso3') ?? 'partner_iso3']) || null,
      partner_name: asText(record[inferredField(record, config.partner_name, 'partner_name') ?? 'partner_name']) || null,
      hs_code: asText(record[inferredField(record, config.hs_code, 'hs_code') ?? 'hs_code']) || null,
      product_name: asText(record[inferredField(record, config.product_name, 'product_name') ?? 'product_name']) || null,
      sector: asText(record[inferredField(record, config.product_name, 'sector') ?? 'sector']) || null,
      value_usd: value * rate,
      qty: asNumber(record[inferredField(record, config.qty, 'qty') ?? 'qty']),
      qty_unit: asText(record[inferredField(record, config.qty_unit, 'qty_unit') ?? 'qty_unit']) || null,
      source_ref: `national:${iso3.toLowerCase()}:${source.url}`,
    });
  }
  return rows;
}

async function bodyToRecords(response: Response, source: EntitySource, config: SourceParserConfig): Promise<RawRecord[]> {
  const contentType = response.headers.get('content-type')?.toLowerCase() ?? '';
  const parser = source.parser_key === 'auto'
    ? contentType.includes('spreadsheet') || /\.xlsx?(?:\?|$)/i.test(source.url) ? 'xlsx'
      : contentType.includes('pdf') || /\.pdf(?:\?|$)/i.test(source.url) ? 'pdf'
        : contentType.includes('csv') || /\.csv(?:\?|$)/i.test(source.url) ? 'csv'
          : source.fmt
    : source.parser_key;
  if (parser === 'xlsx') {
    const workbook = XLSX.read(await response.arrayBuffer(), { type: 'array' });
    const sheet = workbook.Sheets[workbook.SheetNames[0]];
    return XLSX.utils.sheet_to_json<RawRecord>(sheet, { range: config.header_row ?? 0, defval: '' });
  }
  if (parser === 'pdf') {
    const pdf = new PDFParse({ data: new Uint8Array(await response.arrayBuffer()) });
    const result = await pdf.getText();
    await pdf.destroy();
    const text = result.text;
    const delimiter = config.delimiter ?? '|';
    const rows = parseCsv(text, delimiter);
    if (rows.length) return rows;
    return text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const cells = line.split(/\s{2,}/).map((cell) => cell.trim());
        return Object.fromEntries(cells.map((cell, index) => [`column_${index}`, cell]));
      });
  }
  const text = await response.text();
  if (parser === 'csv') return parseCsv(text, config.delimiter ?? ',');
  if (parser === 'html') return parseHtml(text);
  const body = JSON.parse(text) as unknown;
  if (parser === 'json-stat' || source.endpoint_type === 'json_stat' || source.endpoint_type === 'pxweb') return parseJsonStat(body, config);
  if (parser === 'sdmx' || source.endpoint_type === 'sdmx') return parseSdmx(text, config);
  return recordsFromJson(body, config);
}

function discoveredDownload(html: string, pageUrl: string): { url: string; parser: string } | null {
  const candidates: { url: string; score: number; parser: string }[] = [];
  for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].trim();
    if (!href || href.startsWith('#') || href.startsWith('javascript:')) continue;
    const text = match[2].replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
    const absolute = new URL(href, pageUrl).href;
    const haystack = `${absolute} ${text}`;
    const parser = /\.xlsx?(?:\?|$)/i.test(absolute) ? 'xlsx'
      : /\.pdf(?:\?|$)/i.test(absolute) ? 'pdf'
        : /\.csv(?:\?|$)/i.test(absolute) ? 'csv'
          : /\.json(?:\?|$)/i.test(absolute) ? 'json'
            : /sdmx|\.xml(?:\?|$)/i.test(absolute) ? 'sdmx' : '';
    if (!parser) continue;
    const score = (/(download|export|trade|statistics|report|data|bulletin)/i.test(haystack) ? 10 : 0)
      + (text.length > 0 ? 2 : 0)
      - (/(archive|old|press-release)/i.test(haystack) ? 1 : 0);
    candidates.push({ url: absolute, score, parser });
  }
  candidates.sort((a, b) => b.score - a.score);
  const best = candidates[0];
  return best ? { url: best.url, parser: best.parser } : null;
}

export async function fetchNationalSource(context: SourceFetchContext): Promise<AdapterResult> {
  const { source, iso3 } = context;
  const config = configOf(source);
  requireMachineSource(source);
  const method = config.method ?? (source.endpoint_type === 'pxweb' ? 'POST' : 'GET');
  const response = await fetch(source.url, {
    method,
    redirect: 'follow',
    headers: config.headers,
    body: method === 'POST' ? JSON.stringify(config.request_body ?? {}) : undefined,
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) throw new Error(`${source.url} -> HTTP ${response.status}`);
  let parseSource = source;
  let parseConfig = config;
  let parseResponse = response;
  if ((source.parser_key === 'html' || source.fmt === 'html') && source.endpoint_type !== 'html_download') {
    const discovered = discoveredDownload(await response.text(), source.url);
    if (!discovered) throw new Error(`${source.url} has no downloadable PDF, XLSX, CSV, JSON, or SDMX link`);
    parseResponse = await fetch(discovered.url, { redirect: 'follow', signal: AbortSignal.timeout(60_000) });
    if (!parseResponse.ok) throw new Error(`${discovered.url} -> HTTP ${parseResponse.status}`);
    parseSource = { ...source, url: discovered.url, fmt: discovered.parser as EntitySource['fmt'], parser_key: discovered.parser as EntitySource['parser_key'] };
    parseConfig = { ...config };
  }
  const records = await bodyToRecords(parseResponse, parseSource, parseConfig);
  const rows = toFactRows(records, parseSource, iso3, parseConfig);
  if (!rows.length) throw new Error(`${source.url} produced no normalized trade rows`);
  return {
    rows,
    source_ref: `national:${iso3.toLowerCase()}:${parseSource.url}`,
    ok: true,
    note: `${rows.length} rows from ${source.label ?? source.url}`,
    meta: { source_id: source.id, source_url: parseSource.url, parser_key: parseSource.parser_key },
  };
}