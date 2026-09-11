/**
 * Checks on the deterministic analytics, scoring and explanation layers.
 *   node scripts/test-analytics.mjs
 *
 * These run without touching the network. Every case here is a way a metric
 * could be wrong or a claim overstated while the dashboard still looks fine:
 * a division by a missing weight, a CAGR computed over the wrong span, a
 * percentage from a base of nothing, a score that moves between runs.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-analytics-test.mjs';
await build({
  entryPoints: ['scripts/entry-analytics.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const {
  computeMetrics, pctChange, cagrOver, coefficientOfVariation, herfindahl,
  buildOpportunities, scoreOne, confidenceFor, exclusionFor, classifySignal, explain,
  GHANA,
} = await import(`./../${OUT}`);

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

let n = 0;
function obs(over = {}) {
  return {
    country_code: 'GH',
    year: 2024,
    month: 0,
    trade_flow: 'import',
    classification_system: 'HS',
    classification_level: 'HS2',
    product_code: '34',
    product_description: 'Soap and cleaning preparations',
    partner_country: 'China',
    partner_iso3: 'CHN',
    import_value_usd: 1_000_000,
    net_weight_kg: 500_000,
    value_is_derived: true,
    months_counted: 12,
    source: 'Ghana Statistical Service',
    source_endpoint: 'https://example.test',
    retrieved_at: '2026-09-11T00:00:00Z',
    id: n++,
    ...over,
  };
}

/** A clean five year series for one product and one partner. */
function series(values, over = {}) {
  return values.map((v, i) => obs({ year: 2021 + i, import_value_usd: v, ...over }));
}

console.log('\nArithmetic that has to refuse');
console.log('-----------------------------');

check('growth from nothing is not a percentage', pctChange(0, 5_000_000) === null);
check('growth from a negative base is refused', pctChange(-100, 100) === null);
check('a normal change is computed', Math.abs(pctChange(100, 150) - 50) < 1e-9, String(pctChange(100, 150)));

{
  const years = [
    { year: 2021, value: 100 }, { year: 2022, value: 110 },
    { year: 2023, value: 121 }, { year: 2024, value: 133.1 },
  ];
  const c3 = cagrOver(years, 3);
  check('three year CAGR uses the year three back, not the first row', Math.abs(c3 - 10) < 0.01, `${c3?.toFixed(2)}%`);
  check('five year CAGR is refused when there is no year five back', cagrOver(years, 5) === null);
}
{
  // The trap the spec warns about: a five year label on a two year span.
  const short = [{ year: 2024, value: 100 }, { year: 2025, value: 200 }];
  check('a five year rate is never computed from two years', cagrOver(short, 5) === null);
  check('and neither is a three year one', cagrOver(short, 3) === null);
}
check('CAGR from a zero base is refused', cagrOver([{ year: 2021, value: 0 }, { year: 2024, value: 100 }], 3) === null);

check('one supplier is a Herfindahl of 1', Math.abs(herfindahl([1]) - 1) < 1e-9);
check('four equal suppliers give 0.25', Math.abs(herfindahl([0.25, 0.25, 0.25, 0.25]) - 0.25) < 1e-9);
check('variation needs at least two points', coefficientOfVariation([5]) === null);

console.log('\nMissing is not zero');
console.log('-------------------');

{
  const m = computeMetrics(series([1e6, 1.1e6, 1.2e6, 1.3e6, 1.4e6], { net_weight_kg: null }))[0];
  check('no weight means no unit value, not a unit value of zero', m.unit_value_usd_per_kg === null);
  check('and the reason is stated', m.limitations.some((l) => /volume is not reported/i.test(l)), JSON.stringify(m.limitations));
}
{
  const m = computeMetrics(series([1e6, 1.1e6, 1.2e6, 1.3e6, 1.4e6], { net_weight_kg: 0 }))[0];
  check('a zero weight is treated as no weight, never divided by', m.unit_value_usd_per_kg === null);
}
{
  const m = computeMetrics([obs({ year: 2025, import_value_usd: 5e6 })])[0];
  check('one year means no year on year growth', m.yoy_value_pct === null);
  check('one year means no three year CAGR', m.cagr_3y_pct === null);
  check('one year means no trend', m.trend === 'insufficient_data', m.trend);
  check('and each absence is named', m.limitations.length >= 3, `${m.limitations.length} limitations`);
}
{
  const m = computeMetrics(series([1e6, 2e6, 3e6, 4e6, 5e6]))[0];
  check('one partner means no supplier concentration', m.supplier_hhi === null, String(m.supplier_hhi));
  check('and says why', m.limitations.some((l) => /fewer than two partner/i.test(l)));
}

console.log('\nThe partial year trap');
console.log('---------------------');

{
  // Exactly the Ghana case: the latest year covers part of the year, which
  // reads as collapsing demand if nothing says otherwise.
  const rows = [
    ...series([10e6, 11e6, 12e6, 13e6]).slice(0, 4),
    obs({ year: 2025, import_value_usd: 4e6, months_counted: 4 }),
  ];
  const m = computeMetrics(rows)[0];
  check('a part year is flagged', m.latest_year_partial === true);
  check('the month count is carried', m.months_in_latest_year === 4, String(m.months_in_latest_year));
  check('and the reader is warned it is not comparable',
    m.limitations.some((l) => /covers 4 months/i.test(l)), JSON.stringify(m.limitations.filter(l => /month/.test(l))));
}

console.log('\nTrend classification');
console.log('--------------------');

{
  const g = computeMetrics(series([1e6, 1.3e6, 1.7e6, 2.2e6, 2.9e6]))[0];
  check('a steady climb is growing', g.trend === 'growing', g.trend);
  const d = computeMetrics(series([5e6, 4e6, 3.2e6, 2.6e6, 2.1e6]))[0];
  check('a steady fall is declining', d.trend === 'declining', d.trend);
  const s = computeMetrics(series([2e6, 2.02e6, 1.99e6, 2.01e6, 2.0e6]))[0];
  check('a flat line is stable', s.trend === 'stable', s.trend);
  const v = computeMetrics(series([1e6, 5e6, 1.2e6, 6e6, 1.5e6]))[0];
  check('wild swings are volatile, not growing', v.trend === 'volatile', v.trend);
}
{
  // 900% growth on a base of nothing is arithmetic, not a market.
  const tiny = computeMetrics(series([3000, 8000, 20000, 45000, 90000]))[0];
  check('a market too small to mean anything is not called growing',
    tiny.trend === 'insufficient_data', tiny.trend);
}

console.log('\nScoring is deterministic');
console.log('------------------------');

{
  const rows = [
    ...series([10e6, 14e6, 19e6, 26e6, 35e6]),
    ...series([4e6, 5e6, 6e6, 7e6, 8e6], { partner_country: 'India', partner_iso3: 'IND' }),
  ];
  const metrics = computeMetrics(rows);
  const a = buildOpportunities(metrics, GHANA);
  const b = buildOpportunities(metrics, GHANA);
  check('the same metrics give the same score', a[0].opportunity_score === b[0].opportunity_score,
    `${a[0].opportunity_score} vs ${b[0].opportunity_score}`);
  check('and the same breakdown', JSON.stringify(a[0].score_breakdown) === JSON.stringify(b[0].score_breakdown));
  check('and the same explanation word for word', a[0].explanation === b[0].explanation);

  const weights = Object.values(GHANA.scoring).reduce((s, w) => s + w, 0);
  check('the configured weights sum to one', Math.abs(weights - 1) < 1e-9, String(weights));
}

console.log('\nScore and confidence are different questions');
console.log('-------------------------------------------');

{
  // A big, fast-growing product known only from two years of chapter data.
  const thin = computeMetrics([
    obs({ year: 2024, import_value_usd: 40e6, net_weight_kg: null }),
    obs({ year: 2025, import_value_usd: 90e6, net_weight_kg: null }),
  ])[0];
  const { level, reasons } = confidenceFor(thin);
  check('thin evidence is low confidence however large the number', level === 'low', level);
  check('and the reasons say what is thin', reasons.some((r) => /2 years/i.test(r)), JSON.stringify(reasons));

  const rich = computeMetrics([
    ...series([10e6, 14e6, 19e6, 26e6, 35e6], { classification_level: 'HS6', product_code: '340111' }),
    ...series([4e6, 5e6, 6e6, 7e6, 8e6], { classification_level: 'HS6', product_code: '340111', partner_country: 'India', partner_iso3: 'IND' }),
    ...series([2e6, 2e6, 2e6, 2e6, 2e6], { classification_level: 'HS6', product_code: '340111', partner_country: 'Turkey', partner_iso3: 'TUR' }),
  ])[0];
  check('five years of HS6 with volume and partners is high confidence',
    confidenceFor(rich).level === 'high', confidenceFor(rich).level);
}

console.log('\nThe traditional commodity filter');
console.log('--------------------------------');

{
  const rules = GHANA.filters.excluded;
  check('gold is excluded', exclusionFor('71', 'Pearls and precious metals', rules) !== null);
  check('petroleum is excluded', exclusionFor('27', 'Mineral fuels', rules) !== null);
  check('the exclusion carries a reason a person can read',
    /gold/i.test(exclusionFor('71', 'x', rules) ?? ''), exclusionFor('71', 'x', rules));
  check('soap is not excluded', exclusionFor('34', 'Soap and cleaning preparations', rules) === null);
  check('cocoa stays in, because Ghana imports chocolate',
    exclusionFor('18', 'Cocoa and cocoa preparations', rules) === null);
  check('edible oils stay in, because refined oil is the opportunity',
    exclusionFor('15', 'Animal or vegetable fats and oils', rules) === null);
}
{
  const rows = [
    ...series([500e6, 600e6, 700e6, 800e6, 900e6], { product_code: '71', product_description: 'Precious metals' }),
    ...series([10e6, 14e6, 19e6, 26e6, 35e6], { product_code: '34', product_description: 'Soap' }),
  ];
  const opps = buildOpportunities(computeMetrics(rows), GHANA);
  const gold = opps.find((o) => o.product_code === '71');
  const soap = opps.find((o) => o.product_code === '34');
  check('the excluded product is kept but marked, not deleted', gold != null && gold.is_excluded === true);
  check('and carries why', !!gold.excluded_reason, gold?.excluded_reason ?? '');
  check('the non-traditional product is not excluded', soap.is_excluded === false);
  check('a filtered ranking leads with the non-traditional product',
    opps.filter((o) => !o.is_excluded)[0].product_code === '34');
}

console.log('\nWhat the explanation will and will not claim');
console.log('-------------------------------------------');

{
  const m = computeMetrics([
    ...series([10e6, 14e6, 19e6, 26e6, 35e6]),
    ...series([4e6, 5e6, 6e6, 7e6, 8e6], { partner_country: 'India', partner_iso3: 'IND' }),
  ])[0];
  const { text, evidence } = explain(m, classifySignal(m));
  check('it states the value and the year', /\$43\.0 million|\$43 million/.test(text) || /in 2025/.test(text), text.slice(0, 90));
  check('it calls itself a signal, not advice', /signal rather than a recommendation/i.test(text));
  check('it admits it cannot see local production',
    /nothing here measures local production/i.test(text));
  check('every claim has a line of evidence', evidence.length >= 3, JSON.stringify(evidence));
  check('no sentence promises a return or a margin',
    !/profit|margin|guaranteed|will earn|returns/i.test(text));
}
{
  const thin = computeMetrics([obs({ year: 2025, import_value_usd: 9e6 })])[0];
  const { text } = explain(thin, classifySignal(thin));
  check('with one year it does not describe a trend', !/has grown|has fallen/i.test(text), text.slice(0, 120));
  check('and does not quote a CAGR it could not compute', !/a year over three years/i.test(text));
}

console.log('\nImport substitution is named only when it applies');
console.log('------------------------------------------------');
{
  const concentrated = computeMetrics(series([10e6, 12e6, 15e6, 18e6, 22e6]))[0];
  check('a single reporting supplier is not called a broadly supplied market',
    classifySignal(concentrated) === 'supplier_diversification', classifySignal(concentrated));

  const twoWithOneDominant = computeMetrics([
    ...series([10e6, 14e6, 19e6, 26e6, 35e6]),
    ...series([4e6, 5e6, 6e6, 7e6, 8e6], { partner_country: 'India', partner_iso3: 'IND' }),
  ])[0];
  check('a dominant supplier reads as diversification',
    classifySignal(twoWithOneDominant) === 'supplier_diversification',
    `hhi ${twoWithOneDominant.supplier_hhi?.toFixed(2)}`);

  const spread = computeMetrics([
    ...series([10e6, 11e6, 12e6, 13e6, 14e6]),
    ...series([9e6, 10e6, 11e6, 12e6, 13e6], { partner_country: 'India', partner_iso3: 'IND' }),
    ...series([8e6, 9e6, 10e6, 11e6, 12e6], { partner_country: 'Turkey', partner_iso3: 'TUR' }),
  ])[0];
  check('a broadly supplied market reads as import substitution',
    classifySignal(spread) === 'import_substitution',
    `hhi ${spread.supplier_hhi?.toFixed(2)}`);

  const exp = computeMetrics(series([10e6, 12e6, 15e6, 18e6, 22e6], { trade_flow: 'export' }))[0];
  check('an export is never called import substitution',
    classifySignal(exp) === 'export_growth', classifySignal(exp));

  // The honesty sentences must not depend on which branch was taken.
  for (const m of [concentrated, spread, exp]) {
    const t = explain(m, classifySignal(m)).text;
    check(`the ${classifySignal(m)} explanation still calls itself a signal`,
      /signal rather than a recommendation/i.test(t), t.slice(-110));
  }
}

console.log('\nMarket size has to mean something');
console.log('---------------------------------');

{
  // The bug the first full Ghana run exposed: on a log scale a $0.1m market
  // scored 0.53 against a $3.2bn ceiling, so silk at half a million dollars
  // outranked a two billion dollar machinery market.
  const rows = [
    ...series([3.0e9, 3.1e9, 3.2e9, 3.2e9, 3.2e9], { product_code: '87', product_description: 'Vehicles' }),
    ...series([60_000, 70_000, 80_000, 90_000, 100_000], { product_code: '43', product_description: 'Furskins' }),
  ];
  const opps = buildOpportunities(computeMetrics(rows), GHANA);
  const vehicles = opps.find((o) => o.product_code === '87');
  const furs = opps.find((o) => o.product_code === '43');

  check('a tiny market does not score near a huge one',
    vehicles.score_breakdown.market_size - furs.score_breakdown.market_size > 0.5,
    `vehicles ${vehicles.score_breakdown.market_size.toFixed(2)} vs furs ${furs.score_breakdown.market_size.toFixed(2)}`);

  check('a market too small to build a business on is excluded',
    furs.is_excluded === true, String(furs.is_excluded));
  check('and the reason says how small', /too small/i.test(furs.excluded_reason ?? ''), furs.excluded_reason ?? '');
  check('the real market is not excluded', vehicles.is_excluded === false);
  check('and leads the filtered ranking',
    opps.filter((o) => !o.is_excluded)[0].product_code === '87');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
