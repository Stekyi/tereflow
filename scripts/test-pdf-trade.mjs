/**
 * Checks on reading trade figures out of a PDF report.
 *   node scripts/test-pdf-trade.mjs
 *
 * A PDF is a layout, not a data format. Text extraction gets columns wrong when
 * a table wraps, a cell spans, or a footnote sits mid-row, and the result is a
 * number in the wrong field rather than an error. Almost everything below is
 * about refusing a row rather than reading one, because a parser that guesses
 * produces a dataset nobody can tell is wrong.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-pdf-trade.mjs';
await build({
  entryPoints: ['scripts/entry-pdf.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { recordsToObservations, parseReportNumber, fetchPdfObservations } = await import(`./../${OUT}`);

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

const PARTNERS = [
  { app_name: 'China', source_name: 'China', iso3: 'CHN' },
  { app_name: 'Viet Nam', source_name: 'Viet Nam', iso3: 'VNM' },
];

const CONFIG = {
  columns: {
    product_code: 'HS Code',
    product_description: 'Description',
    partner_country: 'Partner',
    value_usd: 'Value (US$)',
    net_weight_kg: 'Net Weight (Kg)',
  },
  classification_level: 'HS6',
  default_year: 2025,
  trade_flow: 'import',
};

const run = (records, over = {}) =>
  recordsToObservations({
    records,
    config: { ...CONFIG, ...over },
    countryCode: 'GH',
    partners: PARTNERS,
    sourceName: 'Test Bulletin',
    sourceEndpoint: 'https://example.gov/bulletin.pdf',
    retrievedAt: '2026-09-13T00:00:00.000Z',
  });

console.log('\nA clean row becomes an observation');
console.log('----------------------------------');
{
  const { observations, rejected } = run([
    {
      'HS Code': '070200 - Tomatoes, fresh',
      Description: 'Tomatoes, fresh or chilled',
      Partner: 'China',
      'Value (US$)': '1,234,567',
      'Net Weight (Kg)': '890,000',
    },
  ]);
  check('one observation', observations.length === 1, `${observations.length}`);
  check('no rejections', rejected.length === 0);

  const o = observations[0];
  check('code is taken at the configured depth', o.product_code === '070200', o.product_code);
  check('thousands separators are handled', o.import_value_usd === 1234567, `${o.import_value_usd}`);
  check('weight is read', o.net_weight_kg === 890000, `${o.net_weight_kg}`);
  check('partner uses the application name', o.partner_country === 'China' && o.partner_iso3 === 'CHN');
  check('the default year is applied', o.year === 2025, `${o.year}`);

  // A figure printed in a report is a reported figure, not one summed here.
  check('it is not marked derived', o.value_is_derived === false);
  check('and the source is recorded', o.source_endpoint === 'https://example.gov/bulletin.pdf');
}

console.log('\nColumn names are matched loosely, values are not');
console.log('-----------------------------------------------');
{
  // "Net Weight (Kg)" and "net_weight_kg" are the same column and a source is
  // entitled to spell it either way.
  const { observations } = run([
    {
      hs_code: '070200',
      partner: 'China',
      'value_us$': '500',
      net_weight_kg: '100',
    },
  ]);
  check('punctuation and case differences still match', observations.length === 1, `${observations.length}`);
  check('and the value is read from the right column', observations[0]?.import_value_usd === 500);
}

console.log('\nAn unreadable number is refused, not turned into zero');
console.log('----------------------------------------------------');
{
  // Zero is a real figure meaning no trade. An unreadable cell means the
  // extractor lost the column. Conflating them fills the dataset with
  // confident zeroes that nothing downstream can question.
  check('a dash is a reported nil', parseReportNumber('-') === 0);
  check('and so is n/a', parseReportNumber('n/a') === 0);
  check('an empty cell is unknown', parseReportNumber('') === null);
  // "see note 3" once stripped to "3" and became a trade value: a real figure,
  // in the right column, off by whatever the true number was. Nothing
  // downstream could have detected it.
  check('and so is text with a digit in it', parseReportNumber('see note 3') === null);
  check('as is a units label', parseReportNumber('12 boxes') === null);
  check('thousands separators are read', parseReportNumber('1,234,567') === 1234567);
  check('currency symbols are stripped', parseReportNumber('US$ 4,500') === 4500);
  check('parenthesised negatives are negative', parseReportNumber('(1,200)') === -1200);
  check('a bare decimal point is not a number', parseReportNumber('.') === null);

  const { observations, rejected } = run([
    { 'HS Code': '070200', Partner: 'China', 'Value (US$)': 'see note 3' },
  ]);
  check('a row with an unreadable value is rejected', observations.length === 0 && rejected.length === 1);
  check('and the reason names the column', /[Vv]alue column/.test(rejected[0].reason), rejected[0].reason);
  check('with the raw row attached', rejected[0].detail.includes('see note 3'));
}

console.log('\nA short code is refused rather than padded');
console.log('------------------------------------------');
{
  // Padding "07" to "070000" invents a specific product out of a chapter, and
  // the invented product would rank alongside real ones.
  const { observations, rejected } = run([
    { 'HS Code': '07 - Edible vegetables', Partner: 'China', 'Value (US$)': '500' },
  ]);
  check('a chapter code is not accepted as HS6', observations.length === 0);
  check('and says why', /HS6 product code/.test(rejected[0]?.reason ?? ''), rejected[0]?.reason);

  const asChapter = run([{ 'HS Code': '07 - Edible vegetables', Partner: 'China', 'Value (US$)': '500' }], {
    classification_level: 'HS2',
  });
  check('the same row is fine when HS2 is configured', asChapter.observations.length === 1);
  check('and keeps two digits', asChapter.observations[0]?.product_code === '07');
}

console.log('\nHeaders, totals and footnotes fall out without drama');
console.log('---------------------------------------------------');
{
  // This is the normal case for a PDF, which is why the rejection count is
  // reported rather than treated as a failure on its own.
  const { observations, rejected } = run([
    { 'HS Code': 'HS Code', Partner: 'Partner', 'Value (US$)': 'Value (US$)' },
    { 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500' },
    { 'HS Code': 'TOTAL', Partner: '', 'Value (US$)': '999,999' },
    { 'HS Code': 'Source: Customs Division', Partner: '', 'Value (US$)': '' },
  ]);
  check('only the real row survives', observations.length === 1, `${observations.length}`);
  check('the rest are counted', rejected.length === 3, `${rejected.length}`);
  // A total row carries a large number. Accepting it would add the whole table
  // to itself, and the result would look like a plausible figure.
  check('the total line did not become an observation',
    !observations.some((o) => o.import_value_usd === 999999));
}

console.log('\nAn unmapped partner is refused, not passed through');
console.log('--------------------------------------------------');
{
  // Passing it through under the source spelling would put a name in the data
  // nothing else can join to, and it would become its own country in every
  // ranking.
  const { observations, rejected } = run([
    { 'HS Code': '070200', Partner: 'Freeport Zone', 'Value (US$)': '500' },
  ]);
  check('the row is rejected', observations.length === 0);
  check('and the partner is named in the reason',
    /Freeport Zone/.test(rejected[0]?.reason ?? ''), rejected[0]?.reason);
}

console.log('\nScale is applied, because a mis-scaled figure still looks plausible');
console.log('------------------------------------------------------------------');
{
  // A table headed "US$ '000" read as units understates by a thousandfold and
  // the result is still a number somebody could believe.
  const { observations } = run(
    [{ 'HS Code': '070200', Partner: 'China', 'Value (US$)': '1,500', 'Net Weight (Kg)': '2' }],
    { value_multiplier: 1000, weight_multiplier: 1000 },
  );
  check('value is scaled', observations[0]?.import_value_usd === 1_500_000, `${observations[0]?.import_value_usd}`);
  check('weight is scaled', observations[0]?.net_weight_kg === 2000, `${observations[0]?.net_weight_kg}`);
}

console.log('\nA missing year is refused rather than assumed');
console.log('---------------------------------------------');
{
  const noYear = recordsToObservations({
    records: [{ 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500' }],
    config: { ...CONFIG, default_year: undefined },
    countryCode: 'GH',
    partners: PARTNERS,
    sourceName: 'Test',
    sourceEndpoint: 'x',
  });
  check('no year and no default is rejected', noYear.observations.length === 0);
  check('and says so plainly', /no default year/i.test(noYear.rejected[0]?.reason ?? ''), noYear.rejected[0]?.reason);

  const badYear = run([{ 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500', Yr: '20' }], {
    columns: { ...CONFIG.columns, year: 'Yr' },
  });
  check('an implausible year is refused', badYear.observations.length === 0);
}

console.log('\nA monthly row is marked monthly');
console.log('-------------------------------');
{
  const { observations } = run(
    [{ 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500', Month: '7' }],
    { columns: { ...CONFIG.columns, month: 'Month' } },
  );
  check('the month is kept', observations[0]?.month === 7, `${observations[0]?.month}`);
  // months_counted is what tells the analytics a figure is not a full year.
  check('and it counts as one month', observations[0]?.months_counted === 1);

  const annual = run([{ 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500' }]);
  check('an annual row is month 0', annual.observations[0]?.month === 0);
  check('covering twelve months', annual.observations[0]?.months_counted === 12);
}

console.log('\nA layout change is reported, not returned as no trade');
console.log('----------------------------------------------------');
{
  // Rows extracted but none matching the configured columns means the report
  // layout moved. That is a different problem from a country having a quiet
  // year, and the two must not look the same.
  const res = await fetchPdfObservations({
    url: 'https://example.gov/bulletin.pdf',
    config: CONFIG,
    countryCode: 'GH',
    partners: PARTNERS,
    sourceName: 'Test',
    extractRecords: async () => [{ Something: 'else', Another: 'column' }],
    fetchImpl: async () =>
      new Response(new ArrayBuffer(8), { status: 200, headers: { 'content-type': 'application/pdf' } }),
  });
  check('the result is not ok', res.ok === false);
  check('and the layout change is named',
    res.notes.some((n) => /layout has probably changed/.test(n)), res.notes.join(' | '));
  check('the extracted rows are kept for comparison', res.raw[0]?.body.includes('Something'));
}

console.log('\nA fetch failure says what failed');
console.log('--------------------------------');
{
  const notFound = await fetchPdfObservations({
    url: 'https://example.gov/gone.pdf',
    config: CONFIG,
    countryCode: 'GH',
    partners: PARTNERS,
    sourceName: 'Test',
    extractRecords: async () => [],
    fetchImpl: async () => new Response('', { status: 404, statusText: 'Not Found' }),
  });
  check('an http failure is reported', notFound.ok === false);
  check('with the status', /404/.test(notFound.error ?? ''), notFound.error);
  check('and no observations invented', notFound.observations.length === 0);

  const unreadable = await fetchPdfObservations({
    url: 'https://example.gov/bulletin.pdf',
    config: CONFIG,
    countryCode: 'GH',
    partners: PARTNERS,
    sourceName: 'Test',
    extractRecords: async () => {
      throw new Error('not a PDF');
    },
    fetchImpl: async () => new Response(new ArrayBuffer(8), { status: 200 }),
  });
  check('an unreadable document is reported', unreadable.ok === false);
  check('and distinguished from an empty one',
    /Could not read the PDF/.test(unreadable.error ?? ''), unreadable.error);
}

console.log('\nThe output is the same contract every other source produces');
console.log('----------------------------------------------------------');
{
  // types.ts: "the analytics below it never learns the word Ghana". A figure
  // from a PDF has to be indistinguishable from one fetched over an API, or
  // the analytics would need to know which it was.
  const { observations } = run([
    { 'HS Code': '070200', Partner: 'China', 'Value (US$)': '500', 'Net Weight (Kg)': '10' },
  ]);
  const o = observations[0];
  const required = [
    'country_code', 'year', 'month', 'trade_flow', 'classification_system',
    'classification_level', 'product_code', 'product_description', 'partner_country',
    'partner_iso3', 'import_value_usd', 'net_weight_kg', 'value_is_derived',
    'months_counted', 'source', 'source_endpoint', 'retrieved_at',
  ];
  const missing = required.filter((k) => !(k in o));
  check('every TradeObservation field is present', missing.length === 0, missing.join(', '));
  check('classification_system is HS', o.classification_system === 'HS');
  check('and nothing identifies it as coming from a PDF',
    !Object.keys(o).some((k) => /pdf/i.test(k)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
