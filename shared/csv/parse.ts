/**
 * Reading a CSV that a person made.
 *
 * Written by hand rather than pulled in, because the failure modes here are
 * specific and a general parser handles them by being permissive. This one is
 * permissive about shape and strict about meaning: it will read a ragged file,
 * and it will refuse to guess what a ragged row meant.
 *
 * What it handles, all of it seen in real files an administrator would produce
 * from Excel or a government download:
 *
 *   a UTF-8 BOM, which Excel writes on every CSV it exports and which makes
 *   the first header compare unequal to itself
 *   quoted fields containing commas, newlines and escaped quotes
 *   CRLF, LF and lone CR line endings
 *   blank lines anywhere, including trailing
 *   rows with more or fewer cells than the header
 *
 * Row numbers are 1-based and count the header, so they match what the person
 * sees in the spreadsheet they are looking at. Reporting row 4 when they need
 * to look at row 5 is worse than useless.
 */

export interface ParsedCsv {
  header: string[];
  /** Header as printed, before normalisation, for error messages. */
  headerRaw: string[];
  rows: ParsedRow[];
  /** File-level problems: no header, nothing but a header, unbalanced quotes. */
  problems: string[];
  hadBom: boolean;
  lineEnding: 'crlf' | 'lf' | 'cr' | 'mixed' | 'none';
}

export interface ParsedRow {
  /** 1-based, header included, so it matches the spreadsheet. */
  lineNumber: number;
  cells: string[];
  /** Cells beyond the header width. Kept so the reader can be told. */
  extra: string[];
  /** True when the row had fewer cells than the header. */
  short: boolean;
}

/**
 * Fold a printed header into the name the schema uses.
 *
 * Deliberately narrow. Case, surrounding space, and the choice between spaces,
 * hyphens and underscores are all noise nobody should have to get right. A
 * different word is not noise, and is left to fail the required-column check
 * with a message naming what was expected.
 */
export function normaliseHeader(raw: string): string {
  return String(raw ?? '')
    .replace(/^\uFEFF/, '')
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '_')
    .replace(/[-.]/g, '_')
    .replace(/__+/g, '_')
    .replace(/^_|_$/g, '');
}

export function parseCsv(text: string): ParsedCsv {
  const problems: string[] = [];

  const hadBom = text.charCodeAt(0) === 0xfeff;
  let body = hadBom ? text.slice(1) : text;

  const crlf = (body.match(/\r\n/g) || []).length;
  const bareLf = (body.match(/(?<!\r)\n/g) || []).length;
  const bareCr = (body.match(/\r(?!\n)/g) || []).length;
  let lineEnding: ParsedCsv['lineEnding'] = 'none';
  const kinds = [crlf > 0, bareLf > 0, bareCr > 0].filter(Boolean).length;
  if (kinds > 1) lineEnding = 'mixed';
  else if (crlf > 0) lineEnding = 'crlf';
  else if (bareLf > 0) lineEnding = 'lf';
  else if (bareCr > 0) lineEnding = 'cr';

  // Normalise endings before the scan so the state machine only handles \n.
  // A quoted field can legitimately contain a newline, and this preserves it.
  body = body.replace(/\r\n/g, '\n').replace(/\r/g, '\n');

  const records: { cells: string[]; line: number }[] = [];
  let cells: string[] = [];
  let field = '';
  let inQuotes = false;
  let line = 1;
  let recordStartLine = 1;
  let sawAnyChar = false;

  const endField = () => {
    cells.push(field);
    field = '';
  };
  const endRecord = () => {
    cells.push(field);
    field = '';
    // A line that is entirely empty is skipped rather than becoming a row of
    // one blank cell. Trailing blank lines are extremely common and are not an
    // error, but a row of blanks would fail every required-column check.
    if (!(cells.length === 1 && cells[0].trim() === '')) {
      records.push({ cells, line: recordStartLine });
    }
    cells = [];
    recordStartLine = line + 1;
  };

  for (let i = 0; i < body.length; i++) {
    const ch = body[i];
    sawAnyChar = true;

    if (inQuotes) {
      if (ch === '"') {
        if (body[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        if (ch === '\n') line++;
        field += ch;
      }
      continue;
    }

    if (ch === '"') {
      // A quote after text, as in Ghana"s, is a stray rather than an opener.
      // Treating it as an opener would swallow the rest of the file.
      if (field.length === 0) inQuotes = true;
      else field += ch;
      continue;
    }
    if (ch === ',') {
      endField();
      continue;
    }
    if (ch === '\n') {
      endRecord();
      line++;
      continue;
    }
    field += ch;
  }

  if (inQuotes) {
    problems.push(
      'A quoted field was never closed. Everything after the last opening quote was read as one value. Check for a stray double quote.',
    );
  }
  if (field.length > 0 || cells.length > 0) endRecord();

  if (!sawAnyChar || records.length === 0) {
    return {
      header: [],
      headerRaw: [],
      rows: [],
      problems: ['The file is empty.'],
      hadBom,
      lineEnding,
    };
  }

  const headerRaw = records[0].cells.map((c) => c.trim());
  const header = headerRaw.map(normaliseHeader);

  if (records.length === 1) {
    problems.push('The file has a header but no data rows.');
  }

  const rows: ParsedRow[] = records.slice(1).map((r) => {
    const trimmed = r.cells.map((c) => c.trim());
    return {
      lineNumber: r.line,
      cells: trimmed.slice(0, header.length),
      extra: trimmed.slice(header.length),
      short: trimmed.length < header.length,
    };
  });

  return { header, headerRaw, rows, problems, hadBom, lineEnding };
}

/**
 * Read a number a person typed.
 *
 * Ported from the extraction pipeline, where the same problem cost real
 * accuracy: 1,234 is one thousand two hundred in English and 1.234 in German,
 * and reading it the wrong way is a factor of a thousand that nothing
 * downstream will ever question.
 *
 * Here the answer is stricter than it was there, because a template can ask.
 * The templates say to enter a plain number, so a value with a separator is
 * accepted only where it can be read one way, and refused where it cannot.
 * Refusing gives the person a message naming the cell. Guessing gives them a
 * number that is wrong by a thousand and looks fine.
 */
export function parseNumber(raw: string): { value: number | null; problem: string | null } {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null, problem: null };

  // Conventional markers for absent data. Not zero, and not an error.
  if (/^(n\/?a|na|nil|none|null|-{1,3}|\.{2,}|:)$/i.test(s)) {
    return { value: null, problem: null };
  }

  let t = s.replace(/\u00a0/g, ' ');
  let negative = false;

  if (/^\(.*\)$/.test(t)) {
    negative = true;
    t = t.slice(1, -1).trim();
  }

  const hadPercent = t.endsWith('%');
  if (hadPercent) t = t.slice(0, -1).trim();

  if (/[a-zA-Z$£€¥₵₦]/.test(t.replace(/[eE][-+]?\d+$/, ''))) {
    return {
      value: null,
      problem:
        'Contains letters or a currency symbol. Enter a plain number and put the currency in its own column.',
    };
  }

  if (t.startsWith('-')) {
    negative = true;
    t = t.slice(1).trim();
  } else if (t.startsWith('+')) {
    t = t.slice(1).trim();
  }

  t = t.replace(/ /g, '');
  if (!t) return { value: null, problem: null };

  if (/^\d+(\.\d+)?[eE][-+]?\d+$/.test(t)) {
    const v = Number(t);
    return Number.isFinite(v) ? { value: negative ? -v : v, problem: null } : { value: null, problem: 'Not a number.' };
  }

  const hasComma = t.includes(',');
  const hasDot = t.includes('.');
  let body = t;

  if (hasComma && hasDot) {
    // The rightmost separator is the decimal point, because a thousands
    // separator never appears after one.
    body = t.lastIndexOf(',') > t.lastIndexOf('.')
      ? t.replace(/\./g, '').replace(',', '.')
      : t.replace(/,/g, '');
  } else if (hasComma || hasDot) {
    const sep = hasComma ? ',' : '.';
    const parts = t.split(sep);
    if (parts.length > 2) {
      // Repeated separator can only be grouping: 1.234.567
      if (parts.slice(1).every((p) => p.length === 3)) body = t.split(sep).join('');
      else return { value: null, problem: `Cannot read ${s}. Enter a plain number without separators.` };
    } else {
      const [left, right] = parts;
      if (right.length === 3) {
        if (sep === ',' && left.length > 3) body = t.replace(',', '.');
        else if (left === '0') body = t.replace(sep, '.');
        else {
          return {
            value: null,
            problem: `${s} could be ${left}${right} or ${left}.${right} depending on convention. Remove the separator so there is no doubt.`,
          };
        }
      } else {
        body = t.replace(sep, '.');
      }
    }
  }

  if (!/^\d*\.?\d+$/.test(body)) {
    return { value: null, problem: `${s} is not a number.` };
  }

  let v = Number(body);
  if (!Number.isFinite(v)) return { value: null, problem: `${s} is not a number.` };
  if (hadPercent) v = v; // the percent sign is decoration here, the unit column says what it is
  return { value: negative ? -v : v, problem: null };
}

/** Year, refusing a range because a figure under one could belong to either end. */
export function parseYear(raw: string): { value: number | null; problem: string | null } {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null, problem: null };
  if (/^(19|20)\d{2}$/.test(s)) return { value: Number(s), problem: null };
  if (/^(19|20)\d{2}\.0$/.test(s)) return { value: Number(s.slice(0, 4)), problem: null };

  const years = [...s.matchAll(/\b(19|20)\d{2}\b/g)].map((m) => Number(m[0]));
  const unique = [...new Set(years)];
  if (unique.length === 1) {
    return {
      value: unique[0],
      problem: `Read ${unique[0]} from "${s}". Enter a bare four-digit year to be certain.`,
    };
  }
  if (unique.length > 1) {
    return {
      value: null,
      problem: `"${s}" names more than one year. Split it into one row per year, or say which year the figure belongs to.`,
    };
  }
  return { value: null, problem: `"${s}" is not a year.` };
}

/** A sub-annual label, kept as stated rather than collapsed into a year. */
export function parsePeriod(raw: string): { value: string | null; year: number | null; problem: string | null } {
  const s = String(raw ?? '').trim();
  if (!s) return { value: null, year: null, problem: null };

  const q = s.match(/^((?:19|20)\d{2})[-\/\s]?Q([1-4])$/i);
  if (q) return { value: `${q[1]}-Q${q[2]}`, year: Number(q[1]), problem: null };

  const m = s.match(/^((?:19|20)\d{2})[-\/\s]?M?(0[1-9]|1[0-2])$/i);
  if (m) return { value: `${m[1]}-${m[2]}`, year: Number(m[1]), problem: null };

  if (/^(19|20)\d{2}$/.test(s)) return { value: null, year: Number(s), problem: null };

  return {
    value: null,
    year: null,
    problem: `"${s}" is not a period. Use 2024-Q1 for a quarter or 2024-03 for a month.`,
  };
}
