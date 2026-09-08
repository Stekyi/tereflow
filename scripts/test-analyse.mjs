/**
 * Checks on the analysis that a chart cannot show you.
 *   node scripts/test-analyse.mjs
 *
 * Written after an audit found China listed as its own seventh largest import
 * partner, at 117 billion dollars. The row is real: Comtrade reports re-imports
 * and processing trade, so a country genuinely does trade with itself. It is
 * still a nonsense partner, it displaced a real one from the ranking, and every
 * share in the list was computed against a total that included it.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-analyse-test.mjs';
await build({
  entryPoints: ['worker/agent/analyse.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { analyse } = await import(`./../${OUT}`);

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

const EMPTY_CONTEXT = {
  gdp_by_year: {},
  services_export_by_year: {},
  services_import_by_year: {},
  gns_export_by_year: {},
  gns_import_by_year: {},
};

let idSeq = 0;
function fact(over = {}) {
  return {
    id: `f${idSeq++}`,
    year: 2024,
    flow: 'import',
    stream: 'goods',
    partner_iso3: null,
    partner_name: null,
    hs_code: null,
    product_name: null,
    sector: null,
    value_usd: 0,
    qty: null,
    qty_unit: null,
    source_ref: 'test',
    ...over,
  };
}

/** A country with a world total, a few partners, and some chapter detail. */
function countryRows({ includeSelf }) {
  const rows = [];
  for (const year of [2021, 2022, 2023, 2024]) {
    for (const flow of ['export', 'import']) {
      // World total: no partner, no product.
      rows.push(fact({ year, flow, value_usd: 1000 }));
      // Chapter detail so product ranking has something to work on.
      rows.push(fact({ year, flow, hs_code: '09', product_name: 'Coffee and tea', value_usd: 600 }));
      rows.push(fact({ year, flow, hs_code: '27', product_name: 'Mineral fuels', value_usd: 400 }));
      // Partners.
      rows.push(fact({ year, flow, partner_iso3: 'NLD', partner_name: 'Netherlands', value_usd: 500 }));
      rows.push(fact({ year, flow, partner_iso3: 'USA', partner_name: 'United States', value_usd: 300 }));
      if (includeSelf) {
        rows.push(fact({ year, flow, partner_iso3: 'GHA', partner_name: 'Ghana', value_usd: 400 }));
      }
    }
  }
  return rows;
}

console.log('\nA country is not its own trade partner');
console.log('--------------------------------------');

{
  const b = analyse('Ghana', countryRows({ includeSelf: true }), EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  const codes = b.partners_import.map((p) => p.code);
  check('the reporting country is kept out of its own partner list', !codes.includes('GHA'), JSON.stringify(codes));
  check('real partners are still there', codes.includes('NLD') && codes.includes('USA'), JSON.stringify(codes));
}

{
  // Excluding the row from the ranking but leaving it in the denominator would
  // make every share quietly small for a reason nothing on the page explains.
  const withSelf = analyse('Ghana', countryRows({ includeSelf: true }), EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  const without = analyse('Ghana', countryRows({ includeSelf: false }), EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  const a = withSelf.partners_import.find((p) => p.code === 'NLD');
  const c = without.partners_import.find((p) => p.code === 'NLD');
  check(
    'the self row is out of the share denominator too',
    Math.abs(a.share_pct - c.share_pct) < 0.0001,
    `with self ${a.share_pct.toFixed(3)}%, without ${c.share_pct.toFixed(3)}%`,
  );
  check('and the shares are the ones a reader would compute', Math.abs(a.share_pct - 62.5) < 0.001, `${a.share_pct.toFixed(3)}%`);
}

{
  // Case should not decide whether the guard works.
  const rows = countryRows({ includeSelf: false });
  rows.push(fact({ year: 2024, flow: 'import', partner_iso3: 'gha', partner_name: 'Ghana', value_usd: 900 }));
  const b = analyse('Ghana', rows, EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  check('the match ignores case', !b.partners_import.map((p) => p.code.toUpperCase()).includes('GHA'), JSON.stringify(b.partners_import.map((p) => p.code)));
}

{
  // A caller that does not know the code is better served by a ranking with one
  // odd row than by no ranking at all, so the guard stays off rather than
  // guessing which partner is the reporter.
  const b = analyse('Ghana', countryRows({ includeSelf: true }), EMPTY_CONTEXT, ['test'], []);
  check('with no reporter code given, nothing is dropped', b.partners_import.map((p) => p.code).includes('GHA'));
}

console.log('\nNothing else moved');
console.log('------------------');

{
  const withSelf = analyse('Ghana', countryRows({ includeSelf: true }), EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  const without = analyse('Ghana', countryRows({ includeSelf: false }), EMPTY_CONTEXT, ['test'], [], undefined, 'GHA');
  check('the headline totals are untouched', withSelf.overview.import_usd === without.overview.import_usd,
    `${withSelf.overview.import_usd} vs ${without.overview.import_usd}`);
  check('the world total is used, not the partner sum', withSelf.overview.import_usd === 1000, `${withSelf.overview.import_usd}`);
  check('product ranking is unaffected', JSON.stringify(withSelf.top_exports.map((p) => p.code)) === JSON.stringify(without.top_exports.map((p) => p.code)));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
