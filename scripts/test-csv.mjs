/**
 * Checks on the CSV reader and validator.
 *   node scripts/test-csv.mjs
 *
 * No server. These are pure functions, and they are the layer where a wrong
 * number gets in quietly, so they are worth pinning down on their own.
 *
 * Every case below is a way a spreadsheet typed by a person goes wrong without
 * looking wrong. A thousands separator that means a decimal point in half of
 * Europe. A file saved by Excel with a byte-order mark that stops the first
 * column matching its own header. A row pasted in twice. None of these announce
 * themselves, and all of them change the answer.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-csv-test.mjs';
await build({
  entryPoints: ['shared/csv/index-test-entry.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { parseCsv, parseNumber, parseYear, parsePeriod, normaliseHeader, validate } =
  await import(`./../${OUT}`);

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

/** Does the report carry an issue with this code, optionally on this row? */
function has(report, code, row = undefined) {
  return report.issues.some((i) => i.code === code && (row === undefined || i.row === row));
}

/** Cells come back positional. Name them so a test reads like the spreadsheet. */
function named(parsed, i = 0) {
  const out = {};
  parsed.header.forEach((h, n) => {
    out[h] = parsed.rows[i].cells[n];
  });
  return out;
}

const TRADE_HEAD =
  'country_iso3,year,period,flow,stream,partner_iso3,partner_name,hs_code,product_name,' +
  'sector_code,sector_name,value,currency,value_usd,exchange_rate,quantity,quantity_unit,' +
  'source_name,source_url';

/** A trade row with sane defaults, overridden by field name. */
function tradeRow(over = {}) {
  const f = {
    country_iso3: 'GHA',
    year: '2024',
    period: '',
    flow: 'export',
    stream: 'goods',
    partner_iso3: 'NLD',
    partner_name: 'Netherlands',
    hs_code: '180100',
    product_name: 'Cocoa beans',
    sector_code: '',
    sector_name: '',
    value: '412300000',
    currency: 'USD',
    value_usd: '412300000',
    exchange_rate: '',
    quantity: '520000',
    quantity_unit: 'kg',
    source_name: 'Ghana Statistical Service',
    source_url: 'https://statsghana.gov.gh/trade-2024',
    ...over,
  };
  return TRADE_HEAD.split(',').map((c) => f[c] ?? '').join(',');
}
function tradeCsv(rows) {
  return [TRADE_HEAD, ...rows].join('\n');
}

console.log('\nReading the file');
console.log('----------------');

{
  // Excel writes a byte-order mark. Left in place it becomes part of the first
  // header cell, that column never matches its own name, and every value in it
  // goes missing without a single complaint. This cost 519,948 rows their year
  // once already, in the Python reader, and it was silent there too.
  const r = parseCsv('\uFEFFcountry_iso3,year\nGHA,2024\n');
  check('byte-order mark stripped from first header', r.header[0] === 'country_iso3', `got "${r.header[0]}"`);
  check('byte-order mark reported, not hidden', r.hadBom === true);
}

{
  const r = parseCsv('a,b\n"Cote d\'Ivoire, north",2\n');
  check('comma inside quotes is not a column break', named(r).b === '2', JSON.stringify(named(r)));
  check('quoted comma kept in the value', named(r).a === "Cote d'Ivoire, north");
}

{
  const r = parseCsv('a,b\n"line one\nline two",2\n');
  check('newline inside quotes stays in the cell', named(r).a === 'line one\nline two');
  check('quoted newline does not start a row', r.rows.length === 1, `${r.rows.length} rows`);
}

{
  const r = parseCsv('a,b\n"say ""hi""",2\n');
  check('doubled quote is one quote', named(r).a === 'say "hi"', named(r).a);
}

{
  const crlf = parseCsv('a,b\r\n1,2\r\n');
  const cr = parseCsv('a,b\r1,2\r');
  check('CRLF line endings read', crlf.rows.length === 1 && named(crlf).b === '2');
  check('bare CR line endings read', cr.rows.length === 1 && named(cr).b === '2');
}

{
  // A ragged row is flagged on the row, not on the file, so the message can
  // name the line the person has to go and look at.
  const r = parseCsv('a,b,c\n1,2\n1,2,3,4\n');
  check('short row flagged on the row', r.rows[0].short === true, JSON.stringify(r.rows[0]));
  check('short row keeps its spreadsheet line number', r.rows[0].lineNumber === 2, `${r.rows[0].lineNumber}`);
  check('long row keeps the surplus cells', r.rows[1].extra.length === 1, JSON.stringify(r.rows[1].extra));
}

{
  const r = parseCsv('a,b\n\n1,2\n\n');
  check('blank lines skipped, not read as empty rows', r.rows.length === 1, `${r.rows.length} rows`);
}

{
  check('header folding: case and spacing only', normaliseHeader(' Country ISO3 ') === 'country_iso3');
  check('header folding: hyphen and underscore agree', normaliseHeader('country-iso3') === 'country_iso3');
  check('a different word is not folded into a match', normaliseHeader('nation_iso3') !== 'country_iso3');
}

console.log('\nReading numbers');
console.log('---------------');

{
  // 1,234 is 1234 in English and 1.234 in German. Guessing is a 1000x error
  // that reads as a perfectly ordinary figure at the far end. Refusing is the
  // only honest answer, and the template tells people to type plain numbers.
  const a = parseNumber('1,234');
  check('ambiguous separator refused, not guessed', a.value === null && a.problem !== null, a.problem ?? 'no problem given');
  check('refusal explains itself', /separator|ambiguous|plain/i.test(a.problem ?? ''), a.problem ?? '');
}

check('plain integer', parseNumber('412300000').value === 412300000);
check('plain decimal', parseNumber('3.14').value === 3.14);
check('negative kept', parseNumber('-2.5').value === -2.5);
check('leading and trailing space ignored', parseNumber('  42  ').value === 42);

{
  const r = parseNumber('1.234.567');
  check('repeated separator is grouping', r.value === 1234567, JSON.stringify(r));
}
{
  const r = parseNumber('1.234,56');
  check('both separators present: rightmost is the decimal', r.value === 1234.56, JSON.stringify(r));
}
{
  const r = parseNumber('1,234.56');
  check('both separators, other way round', r.value === 1234.56, JSON.stringify(r));
}
{
  const r = parseNumber('1,204 EUR');
  check('a currency code in a number cell is refused', r.value === null && r.problem !== null, JSON.stringify(r));
}
check('empty cell is null, not zero', parseNumber('').value === null);
check('a dash is null, not zero', parseNumber('-').value === null);

{
  const y = parseYear('2024');
  check('year read', y.value === 2024);
  check('year 1600 refused', parseYear('1600').value === null);
  check('year 2400 refused', parseYear('2400').value === null);
  check('year with text refused', parseYear('FY2024').value === null);
}

{
  check('quarter period read', parsePeriod('2024-Q1').year === 2024);
  check('month period read', parsePeriod('2024-03').year === 2024);
  check('nonsense period refused', parsePeriod('spring').problem !== null);
}

console.log('\nValidating a trade file');
console.log('-----------------------');

{
  const r = validate(tradeCsv([tradeRow()]), 'exports', { expectIso3: 'GHA' });
  check('a good file passes', r.ok === true, JSON.stringify(r.issues.map((i) => i.code)));
  check('one row in, one row out', r.validRows === 1, `${r.validRows}`);
  check('years reported for the replace preview', r.years.includes(2024), JSON.stringify(r.years));
}

{
  const r = validate(tradeCsv([tradeRow({ flow: 'import' })]), 'exports', { expectIso3: 'GHA' });
  check('an import row in the exports file is refused', r.ok === false && has(r, 'wrong_flow'), JSON.stringify(r.issues.map((i) => i.code)));
}

{
  const r = validate(tradeCsv([tradeRow({ country_iso3: 'XXX' })]), 'exports', { expectIso3: 'GHA' });
  check('an unknown ISO3 is refused', r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
  const i = r.issues.find((x) => x.row === 2);
  check('the issue names the spreadsheet row', !!i, JSON.stringify(r.issues));
  check('the issue names the column', !!r.issues.find((x) => x.column === 'country_iso3'));
}

{
  const r = validate(tradeCsv([tradeRow({ country_iso3: 'NGA' })]), 'exports', { expectIso3: 'GHA' });
  check("a real country that is not this country is refused", r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
}

{
  // Same year, flow, stream, partner and HS code twice. Whatever else differs,
  // summing both doubles the money.
  const r = validate(tradeCsv([tradeRow(), tradeRow()]), 'exports', { expectIso3: 'GHA' });
  check('an identical row twice is a duplicate', has(r, 'duplicate_row'), JSON.stringify(r.issues.map((i) => i.code)));
}

{
  const r = validate(
    tradeCsv([tradeRow(), tradeRow({ value: '999', value_usd: '999' })]),
    'exports',
    { expectIso3: 'GHA' },
  );
  check(
    'the same fact with two different figures is a conflict, not a duplicate',
    has(r, 'conflicting_row'),
    JSON.stringify(r.issues.map((i) => i.code)),
  );
}

{
  // Quoted, the way Excel writes it. Unquoted it would split the row, which is
  // its own error and would hide the one being tested.
  const r = validate(tradeCsv([tradeRow({ value: '"412,300"', value_usd: '' })]), 'exports', { expectIso3: 'GHA' });
  check('a thousands separator in a value is refused', r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
  const i = r.issues.find((x) => x.column === 'value' && x.severity === 'error');
  check('the refusal points at the value column', !!i, JSON.stringify(r.issues.filter((x) => x.severity === 'error')));
  check('and says why rather than guessing', /separator|doubt/i.test(i?.message ?? ''), i?.message ?? '');
}

{
  const r = validate(
    tradeCsv([tradeRow({ value: '1000000', currency: '', value_usd: '' })]),
    'exports',
    { expectIso3: 'GHA' },
  );
  check(
    'a value with no currency and no USD is refused',
    r.ok === false,
    JSON.stringify(r.issues.map((i) => i.code)),
  );
}

{
  // 412.3m cedis at 12 to the dollar is about 34m, not 412m. Nothing about the
  // wrong figure looks wrong on its own.
  const r = validate(
    tradeCsv([tradeRow({ value: '412300000', currency: 'GHS', exchange_rate: '12', value_usd: '412300000' })]),
    'exports',
    { expectIso3: 'GHA' },
  );
  check(
    'a USD figure that disagrees with value times rate is flagged',
    r.issues.some((i) => /exchange|rate|usd/i.test(i.code)),
    JSON.stringify(r.issues.map((i) => i.code)),
  );
}

{
  const r = validate(tradeCsv([tradeRow({ value: '1e20', value_usd: '1e20' })]), 'exports', { expectIso3: 'GHA' });
  check('a figure larger than world trade is flagged', r.issues.length > 0, JSON.stringify(r.issues.map((i) => i.code)));
}

{
  const r = validate('country_iso3,year\nGHA,2024\n', 'exports', { expectIso3: 'GHA' });
  check('missing required columns refused', r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
  check('the missing column is named', r.issues.some((i) => /flow|stream|source_name/.test(i.message)), JSON.stringify(r.issues.map((i) => i.message)));
}

{
  const r = validate('', 'exports', { expectIso3: 'GHA' });
  check('an empty file is refused', r.ok === false);
}
{
  const r = validate(TRADE_HEAD + '\n', 'exports', { expectIso3: 'GHA' });
  check('a header with no rows is refused', r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
}
{
  const r = validate(tradeCsv([tradeRow()]), 'not_a_dataset', {});
  check('an unknown dataset is refused', r.ok === false && has(r, 'unknown_dataset'));
}

{
  // A warning must never block. If an unusual but real figure stopped the
  // import, people would edit the data until the tool stopped complaining,
  // which is the opposite of what any of this is for.
  const r = validate(
    tradeCsv([
      tradeRow({ year: '2022', value: '1000000', value_usd: '1000000' }),
      tradeRow({ year: '2023', value: '1100000', value_usd: '1100000' }),
      tradeRow({ year: '2024', value: '80000000', value_usd: '80000000' }),
    ]),
    'exports',
    { expectIso3: 'GHA' },
  );
  check('a sudden jump is noticed', r.warningCount + r.noticeCount > 0, JSON.stringify(r.issues.map((i) => i.code)));
  check('but a warning does not block the import', r.ok === true, `status ${r.status}`);
  check('and the status says warnings were raised', r.status === 'valid_with_warnings', r.status);
}

console.log('\nValidating indicators');
console.log('---------------------');

const IND_HEAD =
  'country_iso3,year,indicator_code,indicator_name,value,unit,sex,age_group,region,urban_rural,source_name,source_url,notes';

{
  const csv = [
    IND_HEAD,
    'GHA,2024,population_total,Total population,34000000,persons,,,,,Ghana Statistical Service,https://statsghana.gov.gh,',
  ].join('\n');
  const r = validate(csv, 'demographics', {
    expectIso3: 'GHA',
    indicators: [
      { code: 'population_total', name: 'Total population', category: 'demographics', unit: 'persons', min_value: 0, max_value: 2e9 },
    ],
  });
  check('a known indicator passes', r.ok === true, JSON.stringify(r.issues.map((i) => i.code)));
}

{
  const csv = [
    IND_HEAD,
    'GHA,2024,invented_code,Made up,1,persons,,,,,Source,https://x.test,',
  ].join('\n');
  const r = validate(csv, 'demographics', {
    expectIso3: 'GHA',
    indicators: [
      { code: 'population_total', name: 'Total population', category: 'demographics', unit: 'persons', min_value: 0, max_value: 2e9 },
    ],
  });
  check('an unknown indicator code is caught', r.issues.length > 0, JSON.stringify(r.issues.map((i) => i.code)));
}

{
  // 0.65 pasted into a column that means percent is 65 percent read as 0.65
  // percent. It is a 100x error and it looks entirely normal.
  const csv = [
    IND_HEAD,
    'GHA,2024,literacy_rate,Literacy rate,0.65,percent,,,,,Source,https://x.test,',
  ].join('\n');
  const r = validate(csv, 'demographics', {
    expectIso3: 'GHA',
    indicators: [
      { code: 'literacy_rate', name: 'Literacy rate', category: 'demographics', unit: 'percent', min_value: 0, max_value: 100 },
    ],
  });
  check(
    'a percent below 1 is flagged as probably a fraction',
    r.issues.length > 0,
    JSON.stringify(r.issues.map((i) => i.message)),
  );
  check('but it is not refused, because it might be right', r.ok === true, r.status);
}

{
  const csv = [
    IND_HEAD,
    'GHA,2024,literacy_rate,Literacy rate,250,percent,,,,,Source,https://x.test,',
  ].join('\n');
  const r = validate(csv, 'demographics', {
    expectIso3: 'GHA',
    indicators: [
      { code: 'literacy_rate', name: 'Literacy rate', category: 'demographics', unit: 'percent', min_value: 0, max_value: 100 },
    ],
  });
  check('a value outside the indicator bounds is caught', r.issues.length > 0, JSON.stringify(r.issues.map((i) => i.code)));
}

{
  const csv = [
    IND_HEAD,
    'GHA,2023,population_total,Total population,33000000,persons,,,,,Source,https://x.test,',
    'GHA,2024,population_total,Total population,34000000,thousands,,,,,Source,https://x.test,',
  ].join('\n');
  const r = validate(csv, 'demographics', {
    expectIso3: 'GHA',
    indicators: [
      { code: 'population_total', name: 'Total population', category: 'demographics', unit: 'persons', min_value: 0, max_value: 2e9 },
    ],
  });
  check(
    'the same indicator in two different units across years is caught',
    r.issues.some((i) => /unit/i.test(i.code) || /unit/i.test(i.message)),
    JSON.stringify(r.issues.map((i) => i.message)),
  );
}

{
  const csv = [
    IND_HEAD,
    'GHA,2024,population_total,Total population,,persons,,,,,Source,https://x.test,',
  ].join('\n');
  const r = validate(csv, 'demographics', { expectIso3: 'GHA' });
  check('a required value left blank is refused', r.ok === false, JSON.stringify(r.issues.map((i) => i.code)));
}

console.log('\nWhat the report has to tell the importer');
console.log('----------------------------------------');

{
  // trade_facts.value_usd is NOT NULL, so a row with only a local figure cannot
  // be stored. The report must not promise it will be. Saying "3 rows ready"
  // and writing 1 is how an import comes to look like it lost data.
  const r = validate(
    tradeCsv([
      tradeRow(),
      tradeRow({ hs_code: '090111', value: '5000000', currency: 'GHS', value_usd: '' }),
      tradeRow({ hs_code: '080131', value: '3000000', currency: 'GHS', value_usd: '' }),
    ]),
    'exports',
    { expectIso3: 'GHA' },
  );
  const s = r.summary.join(' ');
  check('the no-USD warning says the row will not be imported', /will not be imported/i.test(r.issues.find((i) => i.code === 'no_usd')?.message ?? ''), r.issues.find((i) => i.code === 'no_usd')?.message ?? '');
  // The advice must be something that actually works. Nothing derives USD from
  // value and exchange_rate, so telling someone to supply those two would send
  // them round the loop again to the same silent hold-back.
  const noUsd = r.issues.find((i) => i.code === 'no_usd')?.message ?? '';
  check('and tells them to convert it themselves, which is what works', /convert the value yourself/i.test(noUsd), noUsd);
  check('the summary promises only what will land', /1 row ready/i.test(s), s);
  check('and says how many are held back and why', /2 more have no US dollar figure/i.test(s), s);
}

{
  const r = validate(
    tradeCsv([tradeRow({ year: '2023' }), tradeRow({ year: '2024', partner_iso3: 'USA', partner_name: 'United States' })]),
    'exports',
    { expectIso3: 'GHA' },
  );
  check('every year in the file is listed', r.years.includes(2023) && r.years.includes(2024), JSON.stringify(r.years));
  check('rows come back in import shape', r.rows.length === 2 && typeof r.rows[0].values === 'object');
  check('each returned row keeps its spreadsheet line number', r.rows[0].row === 2 && r.rows[1].row === 3, JSON.stringify(r.rows.map((x) => x.row)));
  check('a human-readable summary is produced', Array.isArray(r.summary) && r.summary.length > 0, JSON.stringify(r.summary));
}

{
  const many = [];
  for (let i = 0; i < 400; i++) many.push(tradeRow({ country_iso3: 'XXX', hs_code: String(100000 + i) }));
  const r = validate(tradeCsv(many), 'exports', { expectIso3: 'GHA', maxIssues: 50 });
  check('one broken file cannot produce unbounded issues', r.issues.length <= 50, `${r.issues.length}`);
  check('but the row count is the file, not the issue list', r.totalRows === 400, `${r.totalRows}`);
  check('and the error count is not capped with the list', r.errorCount >= 400, `${r.errorCount}`);
  check('the summary says the list was cut short', r.summary.some((s) => /cut short/i.test(s)), JSON.stringify(r.summary));
}

{
  const r = validate(tradeCsv([tradeRow({ country_iso3: 'XXX' }), tradeRow()]), 'exports', { expectIso3: 'GHA' });
  check('a file with any error yields no importable rows', r.ok === false);
  check('and does not quietly import the good half', r.rows.length === 0 || r.ok === false, `${r.rows.length} rows returned`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exit(failed === 0 ? 0 : 1);
