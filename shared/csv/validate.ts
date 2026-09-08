/**
 * Checking a file before it is allowed anywhere near the database.
 *
 * Three severities and the difference between them matters:
 *
 *   error    the row cannot be stored. Something required is missing or wrong
 *            in a way that would put a false figure in the database.
 *   warning  the row can be stored but somebody should look. Usually a value
 *            that is legal but surprising, or a code nobody recognises.
 *   notice   worth knowing, blocks nothing. Coverage, gaps, what was assumed.
 *
 * A file with any error is not importable. Warnings never block: refusing a
 * whole upload because one figure looks unusual would push people towards
 * editing their data until the tool stops complaining, which is exactly the
 * behaviour to avoid.
 *
 * Every issue names the row and the column. An error report that says
 * "invalid value" without saying where is a report nobody can act on.
 */

import { ISO3_NAME } from '../country-names';
import {
  parseCsv,
  parseNumber,
  parsePeriod,
  parseYear,
  normaliseHeader,
  type ParsedRow,
} from './parse';
import { datasetSpec, requiredColumns, type ColumnSpec, type DatasetSpec } from './schema';

export type Severity = 'error' | 'warning' | 'notice';

export interface Issue {
  severity: Severity;
  /** 1-based and header inclusive, so it matches the spreadsheet on screen. */
  row: number | null;
  column: string | null;
  code: string;
  message: string;
  value?: string;
}

/** One row that passed, in the shape the importer writes. Never partially filled. */
export interface ValidRow {
  row: number;
  values: Record<string, string | number | null>;
}

export interface ValidationReport {
  dataset: string;
  entitySlug: string | null;
  ok: boolean;
  status: 'valid' | 'valid_with_warnings' | 'invalid';
  totalRows: number;
  validRows: number;
  errorCount: number;
  warningCount: number;
  noticeCount: number;
  issues: Issue[];
  rows: ValidRow[];
  /** Years present, so the UI can say what replace_period would delete. */
  periods: string[];
  years: number[];
  summary: string[];
}

export interface IndicatorDef {
  code: string;
  name: string;
  category: string;
  unit: string | null;
  min_value: number | null;
  max_value: number | null;
}

export interface ValidateOptions {
  /** The country the upload is filed against. Rows must match it. */
  expectIso3?: string | null;
  entitySlug?: string | null;
  /** From indicator_definitions. Absent means codes are not checked. */
  indicators?: IndicatorDef[];
  /** From sector_definitions. */
  sectorCodes?: string[];
  /** Cap on issues returned, so one broken file cannot produce a million rows. */
  maxIssues?: number;
}

const MAX_ISSUES_DEFAULT = 500;

// Above this a single trade figure is a separator or unit mistake rather than a
// real number. World merchandise trade is roughly 24 trillion dollars a year,
// so one cell above 100 trillion is not a large trade.
const IMPLAUSIBLE_VALUE = 1e14;

// A year-on-year jump larger than this in the same series is flagged. It is
// not refused: a real one happens, and the point is that somebody looks.
const SUDDEN_CHANGE_FACTOR = 10;

export function validate(
  text: string,
  datasetCode: string,
  options: ValidateOptions = {},
): ValidationReport {
  const spec = datasetSpec(datasetCode);
  const issues: Issue[] = [];
  const maxIssues = options.maxIssues ?? MAX_ISSUES_DEFAULT;
  let truncated = false;
  const tally: Tally = { rows: 0, errors: 0, warnings: 0, notices: 0, failedRows: 0, noUsdRows: 0 };
  const failedRowNumbers = new Set<number>();

  // Count before deciding whether to keep. The list is capped; the truth is not.
  const add = (i: Issue) => {
    if (i.severity === 'error') {
      tally.errors++;
      if (i.row != null && i.row > 1) failedRowNumbers.add(i.row);
    } else if (i.severity === 'warning') tally.warnings++;
    else tally.notices++;

    if (issues.length >= maxIssues) {
      truncated = true;
      return;
    }
    issues.push(i);
  };

  if (!spec) {
    return report(datasetCode, options, [
      { severity: 'error', row: null, column: null, code: 'unknown_dataset', message: `No dataset called ${datasetCode}.` },
    ], [], [], []);
  }

  const parsed = parseCsv(text);

  for (const p of parsed.problems) {
    add({ severity: p.includes('no data rows') || p.includes('empty') ? 'error' : 'error', row: null, column: null, code: 'file', message: p });
  }
  if (parsed.hadBom) {
    add({
      severity: 'notice',
      row: 1,
      column: null,
      code: 'bom',
      message: 'The file starts with a byte order mark, which Excel adds. It was removed and caused no problem.',
    });
  }
  if (parsed.lineEnding === 'mixed') {
    add({
      severity: 'notice',
      row: null,
      column: null,
      code: 'line_endings',
      message: 'The file mixes line endings. It was read correctly, but this usually means it was edited in more than one program.',
    });
  }

  if (!parsed.header.length) {
    return report(datasetCode, options, issues, [], [], []);
  }

  // --- columns ------------------------------------------------------------
  const known = new Set(spec.columns.map((c) => c.name));
  const present = new Map<string, number>();
  parsed.header.forEach((h, i) => {
    if (!present.has(h)) present.set(h, i);
  });

  const missing = requiredColumns(spec).filter((c) => !present.has(c));
  for (const c of missing) {
    const col = spec.columns.find((x) => x.name === c)!;
    add({
      severity: 'error',
      row: 1,
      column: c,
      code: 'missing_column',
      message: `The required column ${c} is not in the file. ${col.help}`,
    });
  }

  parsed.header.forEach((h, i) => {
    if (!h) {
      add({
        severity: 'warning',
        row: 1,
        column: `column ${i + 1}`,
        code: 'blank_header',
        message: `Column ${i + 1} has no name and was ignored.`,
      });
    } else if (!known.has(h)) {
      add({
        severity: 'warning',
        row: 1,
        column: parsed.headerRaw[i] || h,
        code: 'extra_column',
        message: `${parsed.headerRaw[i] || h} is not a column this dataset uses. It was ignored, nothing was lost from the file.`,
      });
    }
  });

  const dupes = parsed.header.filter((h, i) => h && parsed.header.indexOf(h) !== i);
  for (const d of [...new Set(dupes)]) {
    add({
      severity: 'error',
      row: 1,
      column: d,
      code: 'duplicate_column',
      message: `${d} appears more than once. Only the first was read, which is almost certainly not what was meant.`,
    });
  }

  if (missing.length) {
    return report(datasetCode, options, issues, [], [], [], truncated);
  }

  // --- rows ---------------------------------------------------------------
  const cellOf = (row: ParsedRow, name: string): string => {
    const i = present.get(name);
    return i === undefined ? '' : (row.cells[i] ?? '');
  };

  const indicatorByCode = new Map((options.indicators ?? []).map((d) => [d.code.toUpperCase(), d]));
  const sectorSet = new Set((options.sectorCodes ?? []).map((s) => s.toLowerCase()));

  const seenKeys = new Map<string, number>();
  const validRows: ValidRow[] = [];
  const yearsSeen = new Set<number>();
  const periodsSeen = new Set<string>();
  const currencies = new Set<string>();
  const unitByIndicator = new Map<string, Set<string>>();
  const seriesValues = new Map<string, { year: number; value: number; row: number }[]>();
  let rowsMissingSource = 0;

  for (const row of parsed.rows) {
    tally.rows++;
    const n = row.lineNumber;
    let rowOk = true;

    if (row.extra.length) {
      add({
        severity: 'warning',
        row: n,
        column: null,
        code: 'extra_cells',
        message: `This row has ${row.extra.length} more value${row.extra.length === 1 ? '' : 's'} than the header. The extras were ignored.`,
      });
    }
    if (row.short) {
      add({
        severity: 'notice',
        row: n,
        column: null,
        code: 'short_row',
        message: 'This row has fewer values than the header. The missing ones were treated as blank.',
      });
    }

    const values: Record<string, string | number | null> = {};

    for (const col of spec.columns) {
      const raw = cellOf(row, col.name);
      const result = checkCell(raw, col, spec, {
        indicatorByCode,
        sectorSet,
        expectIso3: options.expectIso3 ?? null,
        row: n,
      });
      for (const issue of result.issues) {
        add(issue);
        if (issue.severity === 'error') rowOk = false;
      }
      values[col.name] = result.value;
    }

    // Cross-column rules. These are where the real mistakes live, because each
    // cell can be individually fine while the row as a whole says nothing.
    const year = values.year as number | null;
    const periodRaw = String(cellOf(row, 'period') || '');
    if (periodRaw) {
      const p = parsePeriod(periodRaw);
      if (p.value) periodsSeen.add(p.value);
      if (p.year && year && p.year !== year) {
        add({
          severity: 'error',
          row: n,
          column: 'period',
          code: 'period_year_mismatch',
          message: `The period says ${p.year} and the year column says ${year}. They must agree.`,
          value: periodRaw,
        });
        rowOk = false;
      }
    }
    if (year) yearsSeen.add(year);

    if (spec.target === 'trade') {
      const v = values.value as number | null;
      const usd = values.value_usd as number | null;
      const cur = values.currency as string | null;

      if (v == null && usd == null) {
        add({
          severity: 'error',
          row: n,
          column: 'value',
          code: 'no_value',
          message: 'Neither value nor value_usd is filled. A trade row with no figure says nothing.',
        });
        rowOk = false;
      }
      if (v != null && usd == null && !cur) {
        add({
          severity: 'error',
          row: n,
          column: 'currency',
          code: 'currency_required',
          message: 'A value is given with no currency and no value_usd. A bare figure could be any currency, and guessing dollars would be a real error.',
        });
        rowOk = false;
      }
      if (usd == null) {
        add({
          severity: 'warning',
          row: n,
          column: 'value_usd',
          code: 'no_usd',
          message:
            'No US dollar figure, so this row will not be imported. Trade is stored in dollars, and storing a zero or guessing a rate would invent a number. Fill value_usd, or give currency and exchange_rate.',
        });
        tally.noUsdRows++;
      }
      if (usd != null && usd > IMPLAUSIBLE_VALUE) {
        add({
          severity: 'error',
          row: n,
          column: 'value_usd',
          code: 'implausible',
          message: `${usd.toExponential(2)} dollars in one row is larger than world trade. This is a separator or a unit mistake.`,
        });
        rowOk = false;
      }
      if (cur) currencies.add(cur);

      // Track the dollar series per product line so a year-on-year jump gets
      // the same look as an indicator does. A country's exports of one HS code
      // multiplying by 70 in a year is nearly always a scale mistake in the
      // source table, and it is worth more here than anywhere: trade values are
      // what every chart and ranking downstream is built on.
      if (usd != null && year) {
        const line = `${values.hs_code ?? values.sector_code ?? 'total'} to ${values.partner_iso3 ?? 'world'}`;
        const key = `${line}|${values.stream ?? ''}|`;
        const list = seriesValues.get(key) ?? [];
        list.push({ year, value: usd, row: n });
        seriesValues.set(key, list);
      }

      const hs = values.hs_code as string | null;
      const stream = values.stream as string | null;
      if (stream === 'services' && hs) {
        add({
          severity: 'warning',
          row: n,
          column: 'hs_code',
          code: 'hs_on_services',
          message: 'Services rows do not carry an HS code. Use sector_code instead.',
        });
      }

      const rate = values.exchange_rate as number | null;
      if (rate != null && v != null && usd != null && rate > 0) {
        const implied = v / rate;
        if (Math.abs(implied - usd) / Math.max(usd, 1) > 0.02) {
          add({
            severity: 'warning',
            row: n,
            column: 'exchange_rate',
            code: 'rate_mismatch',
            message: `value divided by exchange_rate gives ${implied.toFixed(0)}, but value_usd says ${usd}. One of the three is wrong.`,
          });
        }
      }
    }

    if (spec.target === 'indicator') {
      const code = String(values.indicator_code ?? '').toUpperCase();
      const unit = values.unit as string | null;
      const value = values.value as number | null;

      if (code && unit) {
        const set = unitByIndicator.get(code) ?? new Set<string>();
        set.add(unit);
        unitByIndicator.set(code, set);
      }
      if (code && value != null && year) {
        const key = `${code}|${values.sex ?? ''}|${values.region ?? ''}`;
        const list = seriesValues.get(key) ?? [];
        list.push({ year, value, row: n });
        seriesValues.set(key, list);
      }
      const def = indicatorByCode.get(code);
      if (def) {
        if (def.unit && unit && def.unit !== unit) {
          add({
            severity: 'warning',
            row: n,
            column: 'unit',
            code: 'unit_mismatch',
            message: `${code} is normally in ${def.unit} and this row says ${unit}. Check which is right before importing.`,
            value: unit ?? undefined,
          });
        }
        if (value != null && def.min_value != null && value < def.min_value) {
          add({
            severity: 'error',
            row: n,
            column: 'value',
            code: 'below_min',
            message: `${value} is below the minimum of ${def.min_value} for ${code}.`,
          });
          rowOk = false;
        }
        if (value != null && def.max_value != null && value > def.max_value) {
          add({
            severity: 'error',
            row: n,
            column: 'value',
            code: 'above_max',
            message: `${value} is above the maximum of ${def.max_value} for ${code}. A percentage above 100 is usually a fraction entered in a percent column.`,
          });
          rowOk = false;
        }
        // A percent that arrived as a fraction. Legal, and almost always meant
        // to be a hundred times larger.
        if (unit === 'percent' && value != null && value > 0 && value < 1 && (def.max_value ?? 100) >= 100) {
          add({
            severity: 'warning',
            row: n,
            column: 'value',
            code: 'fraction_in_percent',
            message: `${value} in a percent column probably means ${(value * 100).toFixed(1)}. Nothing was changed.`,
          });
        }
      } else if (code) {
        add({
          severity: 'warning',
          row: n,
          column: 'indicator_code',
          code: 'unknown_indicator',
          message: `${code} is not in the indicator catalogue. It will be stored but will not appear in the standard charts.`,
          value: code,
        });
      }

      if (unit === 'currency' && !values.currency) {
        add({
          severity: 'error',
          row: n,
          column: 'currency',
          code: 'currency_required',
          message: 'The unit is currency but no currency is given, so the figure has no meaning.',
        });
        rowOk = false;
      }
      if (values.currency) currencies.add(String(values.currency));
    }

    if (spec.target === 'sector') {
      const measures = ['value', 'share_of_gdp', 'growth_rate', 'employment', 'employment_share', 'exports_value', 'imports_value'];
      if (measures.every((m) => values[m] == null)) {
        add({
          severity: 'error',
          row: n,
          column: null,
          code: 'no_measure',
          message: 'This sector row carries no figures at all. At least one measure is needed.',
        });
        rowOk = false;
      }
      if (values.unit === 'currency' && !values.currency) {
        add({
          severity: 'error',
          row: n,
          column: 'currency',
          code: 'currency_required',
          message: 'The unit is currency but no currency is given.',
        });
        rowOk = false;
      }
      if (values.currency) currencies.add(String(values.currency));
    }

    if (!String(cellOf(row, 'source_name') || '').trim()) rowsMissingSource++;

    // Duplicate detection on the logical key. Two rows saying the same thing
    // twice would double whatever is computed from them.
    const key = spec.logicalKey.map((k) => String(values[k] ?? '')).join('|');
    const firstAt = seenKeys.get(key);
    if (firstAt !== undefined) {
      const conflicting = valuesConflict(spec, validRows.find((r) => r.row === firstAt)?.values, values);
      add({
        severity: 'error',
        row: n,
        column: null,
        code: conflicting ? 'conflicting_row' : 'duplicate_row',
        message: conflicting
          ? `This row has the same ${spec.logicalKey.join(', ')} as row ${firstAt} but different figures. One of them is wrong and this file cannot say which.`
          : `This row repeats row ${firstAt}: same ${spec.logicalKey.join(', ')}. Importing both would count it twice.`,
      });
      rowOk = false;
    } else {
      seenKeys.set(key, n);
    }

    if (rowOk) validRows.push({ row: n, values });
  }

  // --- file level ---------------------------------------------------------
  if (currencies.size > 1) {
    add({
      severity: 'warning',
      row: null,
      column: 'currency',
      code: 'mixed_currency',
      message: `The file mixes ${[...currencies].sort().join(', ')}. That is allowed, but nothing here converts between them, so totals will only be right where a dollar figure is given.`,
    });
  }

  for (const [code, units] of unitByIndicator) {
    if (units.size > 1) {
      add({
        severity: 'warning',
        row: null,
        column: 'unit',
        code: 'inconsistent_unit',
        message: `${code} appears in more than one unit: ${[...units].join(', ')}. A series in mixed units cannot be charted as one line.`,
      });
    }
  }

  for (const [key, points] of seriesValues) {
    const sorted = [...points].sort((a, b) => a.year - b.year);
    for (let i = 1; i < sorted.length; i++) {
      const prev = sorted[i - 1];
      const cur = sorted[i];
      if (prev.value > 0 && cur.value > 0 && cur.year !== prev.year) {
        const factor = Math.max(cur.value / prev.value, prev.value / cur.value);
        if (factor >= SUDDEN_CHANGE_FACTOR) {
          add({
            severity: 'warning',
            row: cur.row,
            column: 'value',
            code: 'sudden_change',
            message: `${key.split('|')[0]} changes by a factor of ${factor.toFixed(0)} between ${prev.year} and ${cur.year}. Check the unit and the scale before importing.`,
          });
        }
      }
    }
    const years = sorted.map((p) => p.year);
    const gaps: number[] = [];
    for (let y = Math.min(...years); y <= Math.max(...years); y++) {
      if (!years.includes(y)) gaps.push(y);
    }
    if (gaps.length) {
      add({
        severity: 'notice',
        row: null,
        column: null,
        code: 'series_gap',
        message: `${key.split('|')[0]} is missing ${gaps.join(', ')}. Nothing is filled in: a gap is left as a gap.`,
      });
    }
  }

  if (rowsMissingSource) {
    add({
      severity: 'warning',
      row: null,
      column: 'source_name',
      code: 'missing_source',
      message: `${rowsMissingSource} row${rowsMissingSource === 1 ? ' has' : 's have'} no source. Those figures cannot be traced back to anything.`,
    });
  }

  if (spec.target === 'sector') {
    const byYear = new Map<number, number>();
    for (const r of validRows) {
      const share = r.values.share_of_gdp as number | null;
      const y = r.values.year as number | null;
      if (share != null && y != null && !r.values.subsector_code) {
        byYear.set(y, (byYear.get(y) ?? 0) + share);
      }
    }
    for (const [y, total] of byYear) {
      if (total > 105) {
        add({
          severity: 'warning',
          row: null,
          column: 'share_of_gdp',
          code: 'shares_exceed',
          message: `Sector shares for ${y} add up to ${total.toFixed(1)} percent. Either a subsector is being counted as a sector, or one share is wrong.`,
        });
      } else if (total > 0 && total < 60) {
        add({
          severity: 'notice',
          row: null,
          column: 'share_of_gdp',
          code: 'shares_partial',
          message: `Sector shares for ${y} add up to ${total.toFixed(1)} percent, so the file covers part of the economy rather than all of it.`,
        });
      }
    }
  }

  if (truncated) {
    add({
      severity: 'notice',
      row: null,
      column: null,
      code: 'truncated',
      message: `More than ${maxIssues} issues were found. Only the first ${maxIssues} are listed. Fix these and check again.`,
    });
  }

  tally.failedRows = failedRowNumbers.size;
  return report(
    datasetCode,
    options,
    issues,
    validRows,
    [...yearsSeen].sort(),
    [...periodsSeen].sort(),
    truncated,
    tally,
  );
}

function valuesConflict(
  spec: DatasetSpec,
  a: Record<string, string | number | null> | undefined,
  b: Record<string, string | number | null>,
): boolean {
  if (!a) return false;
  const measures = spec.columns
    .filter((c) => c.kind === 'number' || c.kind === 'ratio')
    .map((c) => c.name);
  return measures.some((m) => a[m] != null && b[m] != null && a[m] !== b[m]);
}

interface CellContext {
  indicatorByCode: Map<string, IndicatorDef>;
  sectorSet: Set<string>;
  expectIso3: string | null;
  row: number;
}

function checkCell(
  raw: string,
  col: ColumnSpec,
  spec: DatasetSpec,
  ctx: CellContext,
): { value: string | number | null; issues: Issue[] } {
  const issues: Issue[] = [];
  const s = String(raw ?? '').trim();
  const at = (severity: Severity, code: string, message: string) =>
    issues.push({ severity, row: ctx.row, column: col.name, code, message, value: s || undefined });

  if (!s) {
    if (col.required) {
      at('error', 'required', `${col.name} is required and is blank. ${col.help}`);
    }
    return { value: null, issues };
  }

  switch (col.kind) {
    case 'iso3': {
      const code = s.toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        at('error', 'bad_iso3', `"${s}" is not a three-letter country code.`);
        return { value: null, issues };
      }
      if (!(code in ISO3_NAME)) {
        at('error', 'unknown_iso3', `${code} is not a country code this system knows.`);
        return { value: null, issues };
      }
      if (col.name === 'country_iso3' && ctx.expectIso3 && code !== ctx.expectIso3) {
        at(
          'error',
          'wrong_country',
          `This row is for ${code} but the upload is filed against ${ctx.expectIso3}. Upload each country's data against that country.`,
        );
        return { value: null, issues };
      }
      return { value: code, issues };
    }

    case 'year': {
      const { value, problem } = parseYear(s);
      if (problem && value == null) {
        at('error', 'bad_year', problem);
        return { value: null, issues };
      }
      if (problem) at('warning', 'loose_year', problem);
      if (value != null && (value < 1960 || value > new Date().getUTCFullYear() + 1)) {
        at('error', 'year_range', `${value} is outside the range these datasets cover.`);
        return { value: null, issues };
      }
      return { value, issues };
    }

    case 'period': {
      const { value, problem } = parsePeriod(s);
      if (problem) {
        at('error', 'bad_period', problem);
        return { value: null, issues };
      }
      return { value, issues };
    }

    case 'flow': {
      const v = s.toLowerCase();
      const expected = spec.fixedFlow;
      if (v !== 'export' && v !== 'import') {
        at('error', 'bad_flow', `"${s}" is not a flow. Use export or import.`);
        return { value: null, issues };
      }
      if (expected && v !== expected) {
        at(
          'error',
          'wrong_flow',
          `This is the ${expected}s template and the row says ${v}. Put ${v}s in the ${v}s file so the two cannot be mixed.`,
        );
        return { value: null, issues };
      }
      return { value: v, issues };
    }

    case 'stream': {
      const v = s.toLowerCase();
      if (v !== 'goods' && v !== 'services') {
        at('error', 'bad_stream', `"${s}" is not a stream. Use goods or services.`);
        return { value: null, issues };
      }
      return { value: v, issues };
    }

    case 'number':
    case 'ratio': {
      const { value, problem } = parseNumber(s);
      if (problem) {
        at('error', 'bad_number', problem);
        return { value: null, issues };
      }
      if (value == null) return { value: null, issues };
      if (col.nonNegative && value < 0) {
        at('error', 'negative', `${value} cannot be negative in ${col.name}.`);
        return { value: null, issues };
      }
      if (col.min != null && value < col.min) {
        at('error', 'below_min', `${value} is below the minimum of ${col.min} for ${col.name}.`);
        return { value: null, issues };
      }
      if (col.max != null && value > col.max) {
        at('error', 'above_max', `${value} is above the maximum of ${col.max} for ${col.name}.`);
        return { value: null, issues };
      }
      return { value, issues };
    }

    case 'currency': {
      const code = s.toUpperCase();
      if (!/^[A-Z]{3}$/.test(code)) {
        at('error', 'bad_currency', `"${s}" is not a three-letter currency code. Use USD, EUR, GHS and so on.`);
        return { value: null, issues };
      }
      return { value: code, issues };
    }

    case 'url': {
      if (!/^https?:\/\//i.test(s)) {
        at('warning', 'bad_url', 'This does not look like a web address. It was kept as written.');
      }
      return { value: s, issues };
    }

    case 'code': {
      if (col.name === 'hs_code') {
        const digits = s.replace(/[.\s-]/g, '');
        if (!/^\d+$/.test(digits)) {
          at('error', 'bad_hs', `"${s}" is not an HS code. Use digits only, 2, 4 or 6 of them.`);
          return { value: null, issues };
        }
        if (![2, 4, 6, 8, 10].includes(digits.length)) {
          at('error', 'bad_hs_length', `An HS code has 2, 4 or 6 digits, or 8 to 10 for a national line. "${s}" has ${digits.length}.`);
          return { value: null, issues };
        }
        if (digits.length > 6) {
          at('notice', 'national_hs', `${digits} is a national tariff line rather than an internationally comparable code. It is stored as given.`);
        }
        return { value: digits, issues };
      }
      if (col.name === 'sector_code' && ctx.sectorSet.size && s) {
        if (!ctx.sectorSet.has(s.toLowerCase())) {
          at('warning', 'unknown_sector', `${s} is not in the sector list. It will be stored but will not group with the standard sectors.`);
        }
        return { value: s.toLowerCase(), issues };
      }
      if (col.name === 'indicator_code') return { value: s.toUpperCase(), issues };
      return { value: s, issues };
    }

    case 'unit':
    case 'enum': {
      if (col.accepts && !col.accepts.includes(s.toLowerCase())) {
        if (col.acceptsOpen) {
          at('warning', 'unusual_value', `"${s}" is not one of the usual values (${col.accepts.join(', ')}). It was kept as written.`);
        } else {
          at('error', 'bad_value', `"${s}" is not allowed in ${col.name}. Use one of: ${col.accepts.join(', ')}.`);
          return { value: null, issues };
        }
      }
      return { value: s.toLowerCase(), issues };
    }

    default:
      return { value: s, issues };
  }
}

function report(
  dataset: string,
  options: ValidateOptions,
  issues: Issue[],
  rows: ValidRow[],
  years: number[],
  periods: string[],
  truncated = false,
  tally?: Tally,
): ValidationReport {
  // Prefer the running tally. It counts every issue raised, including the ones
  // the cap kept out of the list. Without a tally nothing was capped, so the
  // list is the whole truth and counting it is right.
  const errorCount = tally ? tally.errors : issues.filter((i) => i.severity === 'error').length;
  const warningCount = tally ? tally.warnings : issues.filter((i) => i.severity === 'warning').length;
  const noticeCount = tally ? tally.notices : issues.filter((i) => i.severity === 'notice').length;
  const totalRows = tally ? tally.rows : rows.length;
  const ok = errorCount === 0 && rows.length > 0;

  const summary: string[] = [];
  if (rows.length) {
    // State what will actually be written. Rows with no dollar figure pass
    // validation but cannot be stored, and promising a number larger than the
    // one that lands is how an import comes to look like it lost data.
    const held = tally?.noUsdRows ?? 0;
    const willLand = rows.length - held;
    if (held > 0) {
      summary.push(
        `${willLand} row${willLand === 1 ? '' : 's'} ready to import. ` +
          `${held} more ${held === 1 ? 'has' : 'have'} no US dollar figure and will not be imported.`,
      );
    } else {
      summary.push(`${rows.length} row${rows.length === 1 ? '' : 's'} ready to import.`);
    }
  }
  if (errorCount) {
    const where = tally && tally.failedRows ? ` across ${tally.failedRows} of ${totalRows} rows` : '';
    summary.push(`${errorCount} error${errorCount === 1 ? '' : 's'}${where} must be fixed before anything can be imported.`);
  }
  if (warningCount) summary.push(`${warningCount} warning${warningCount === 1 ? '' : 's'} worth reading. They do not block the import.`);
  if (years.length) summary.push(`Covers ${years.length === 1 ? years[0] : `${years[0]} to ${years[years.length - 1]}`}.`);
  if (truncated) summary.push(`The issue list was cut short. The counts above are the full figures.`);

  return {
    dataset,
    entitySlug: options.entitySlug ?? null,
    ok,
    status: errorCount ? 'invalid' : warningCount ? 'valid_with_warnings' : 'valid',
    totalRows,
    validRows: rows.length,
    errorCount,
    warningCount,
    noticeCount,
    issues,
    rows,
    years,
    periods,
    summary,
  };
}

/**
 * Counts, carried separately from the issue list.
 *
 * The issue list is capped so one broken file cannot return a million entries.
 * The counts must not be capped with it. A 400 row file with 400 bad rows once
 * reported "50 rows, 50 errors" because both numbers were derived from the
 * truncated list, which reads as a small broken file rather than a large one,
 * and that is the opposite of what the reader needs to decide what to do next.
 */
interface Tally {
  /** Data rows the reader found, whatever happened to them afterwards. */
  rows: number;
  errors: number;
  warnings: number;
  notices: number;
  /** Distinct rows carrying at least one error. */
  failedRows: number;
  /**
   * Trade rows with no dollar figure. They validate, but trade_facts.value_usd
   * is NOT NULL so they cannot be written. Counted here so the report can
   * promise the number that will actually land rather than the number read.
   */
  noUsdRows: number;
}

export { normaliseHeader };
