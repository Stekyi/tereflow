/**
 * Turning a dataset definition into the two things an administrator needs
 * before they can upload anything: a blank CSV with the right columns, and a
 * README that says what every column is for.
 *
 * Both are generated from the same DATASETS definition the validator checks
 * against, so a template can never offer a column the validator rejects, nor
 * omit one it requires. Writing either by hand is how they drift.
 */

import {
  datasetSpec,
  type ColumnSpec,
  type DatasetCode,
  type DatasetSpec,
} from './schema';

/**
 * A CSV cell may contain a comma, a quote or a newline. Quoting only when one
 * of those is present keeps the common case readable, which matters because a
 * human opens this file and edits it by hand.
 */
function csvCell(value: string): string {
  if (value === '') return '';
  if (/[",\r\n]/.test(value)) {
    return `"${value.replace(/"/g, '""')}"`;
  }
  return value;
}

function csvRow(cells: string[]): string {
  return cells.map(csvCell).join(',');
}

/**
 * The first example row comes straight from each column's `example`. The
 * second is deliberately a different shape so the file shows more than one way
 * a row can look: for trade that is a country total, with partner and product
 * left blank, which is a real and common row and proves those columns are
 * optional. For the indicator and sector sheets it is a second, plainly
 * different record so nobody thinks every row has to repeat the first.
 */
function exampleRows(spec: DatasetSpec): string[][] {
  const first = spec.columns.map((c) => c.example ?? '');

  const second = spec.columns.map((c) => secondExample(spec, c));

  return [first, second];
}

function secondExample(spec: DatasetSpec, col: ColumnSpec): string {
  const name = col.name;

  if (spec.target === 'trade') {
    // A country total: every partner and product, summed. Partner and product
    // columns are blank, which is what makes this row a total rather than a line.
    switch (name) {
      case 'country_iso3':
        return 'GHA';
      case 'year':
        return '2023';
      case 'flow':
        return spec.fixedFlow ?? col.example ?? '';
      case 'stream':
        return 'goods';
      case 'partner_iso3':
      case 'partner_name':
      case 'hs_code':
      case 'product_name':
        return '';
      case 'value_usd':
        return '15870000000';
      case 'quantity':
      case 'quantity_unit':
        return '';
      case 'source_name':
        return 'Ghana Statistical Service';
      case 'source_url':
        return 'https://statsghana.gov.gh/trade-2023';
      default:
        return '';
    }
  }

  if (spec.code === 'demographics') {
    switch (name) {
      case 'country_iso3':
        return 'GHA';
      case 'year':
        return '2024';
      case 'indicator_code':
        return 'POP_URBAN_SHARE';
      case 'indicator_name':
        return 'Urban share of population';
      case 'value':
        return '58.7';
      case 'unit':
        return 'percent';
      case 'source_name':
        return 'Ghana Statistical Service';
      case 'source_url':
        return 'https://statsghana.gov.gh/census-2021';
      default:
        return '';
    }
  }

  if (spec.code === 'income') {
    switch (name) {
      case 'country_iso3':
        return 'GHA';
      case 'year':
        return '2024';
      case 'indicator_code':
        return 'GDP_PER_CAPITA';
      case 'indicator_name':
        return 'GDP per capita';
      case 'value':
        return '2350';
      case 'unit':
        return 'currency';
      case 'currency':
        return 'USD';
      case 'price_basis':
        return 'nominal';
      case 'source_name':
        return 'Bank of Ghana';
      case 'source_url':
        return 'https://www.bog.gov.gh/statistics';
      default:
        return '';
    }
  }

  if (spec.code === 'investment') {
    switch (name) {
      case 'country_iso3':
        return 'GHA';
      case 'year':
        return '2024';
      case 'indicator_code':
        return 'ELECTRICITY_ACCESS';
      case 'indicator_name':
        return 'Access to electricity';
      case 'value':
        return '86.3';
      case 'unit':
        return 'percent';
      case 'category':
        return 'infrastructure';
      case 'source_name':
        return 'Ghana Energy Commission';
      case 'source_url':
        return 'https://www.energycom.gov.gh';
      case 'confidence':
        return '0.7';
      default:
        return '';
    }
  }

  if (spec.code === 'sectors') {
    switch (name) {
      case 'country_iso3':
        return 'GHA';
      case 'year':
        return '2024';
      case 'sector_code':
        return 'manufacturing';
      case 'sector_name':
        return 'Manufacturing';
      case 'value':
        return '54200000000';
      case 'unit':
        return 'currency';
      case 'currency':
        return 'GHS';
      case 'share_of_gdp':
        return '11.3';
      case 'growth_rate':
        return '2.1';
      case 'employment':
        return '1450000';
      case 'employment_share':
        return '11.9';
      case 'source_name':
        return 'Ghana Statistical Service';
      case 'source_url':
        return 'https://statsghana.gov.gh/national-accounts';
      default:
        return '';
    }
  }

  return '';
}

/** The CSV an administrator downloads: header, then two example rows. */
export function buildTemplate(code: DatasetCode): string {
  const spec = datasetSpec(code);
  if (!spec) throw new Error(`No dataset called ${code}`);

  const header = spec.columns.map((c) => c.name);
  const rows = exampleRows(spec);

  // A trailing newline so the last row is terminated the way a spreadsheet
  // writes it, and appending never joins onto the final row.
  return [csvRow(header), ...rows.map(csvRow)].join('\r\n') + '\r\n';
}

function required(col: ColumnSpec): string {
  return col.required ? 'required' : 'optional';
}

function accepted(col: ColumnSpec): string {
  if (!col.accepts || !col.accepts.length) {
    const bounds: string[] = [];
    if (col.min != null) bounds.push(`at least ${col.min}`);
    if (col.max != null) bounds.push(`at most ${col.max}`);
    if (col.nonNegative && col.min == null) bounds.push('not negative');
    return bounds.length ? bounds.join(', ') : 'any';
  }
  const list = col.accepts.join(', ');
  return col.acceptsOpen
    ? `usually one of ${list}; another value loads with a warning`
    : `one of ${list}`;
}

/**
 * The README, in Markdown. It has to be usable by somebody who has never seen
 * the application, so it says per column what the column means, whether it is
 * required, what values it takes and one example, then the dataset-level notes
 * the schema carries. If a reader still has to guess, this file has failed.
 */
export function buildReadme(code: DatasetCode): string {
  const spec = datasetSpec(code);
  if (!spec) throw new Error(`No dataset called ${code}`);

  const out: string[] = [];

  out.push(`# ${spec.name} upload template`);
  out.push('');
  out.push(spec.description);
  out.push('');
  out.push(`Refresh: ${spec.refresh}`);
  out.push('');
  out.push(
    'Fill the CSV that came with this file. The first line is the header and ' +
      'must stay exactly as written. The two rows under it are examples: replace ' +
      'them with your own figures, or delete them and paste yours below the header.',
  );
  out.push('');
  out.push(
    'Do not add comment lines to the CSV. A spreadsheet reads every line as data, ' +
      'so a note in the file would be checked as if it were a figure and rejected. ' +
      'Anything you want to record about a row goes in that row, in a notes column ' +
      'where the dataset has one.',
  );
  out.push('');

  out.push('## Columns');
  out.push('');
  for (const col of spec.columns) {
    out.push(`### ${col.name}`);
    out.push('');
    out.push(`- Required: ${required(col)}`);
    out.push(`- Meaning: ${col.help}`);
    out.push(`- Accepted values: ${accepted(col)}`);
    const example = col.example && col.example.length ? `\`${col.example}\`` : 'left blank';
    out.push(`- Example: ${example}`);
    out.push('');
  }

  out.push('## What makes one row different from another');
  out.push('');
  out.push(
    `Two rows that share ${spec.logicalKey.join(', ')} are treated as the same ` +
      'observation stated twice. Importing both would count the figure twice, so a ' +
      'repeat is refused. Change one of those columns if the rows really are ' +
      'different things.',
  );
  out.push('');

  if (spec.notes.length) {
    out.push('## Notes');
    out.push('');
    for (const note of spec.notes) {
      out.push(`- ${note}`);
    }
    out.push('');
  }

  out.push('## Source columns');
  out.push('');
  out.push(
    'Every row asks who published the figure. A number with no source cannot be ' +
      'checked by anybody later, which is the difference between a figure and a ' +
      'guess. The source URL is optional but strongly recommended: it is what ' +
      'still lets somebody verify the number a year from now.',
  );
  out.push('');

  return out.join('\n');
}
