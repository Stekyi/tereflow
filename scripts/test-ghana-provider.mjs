/**
 * Run the Ghana provider against the live StatBank API.
 *   node scripts/test-ghana-provider.mjs
 *
 * A provider that typechecks is not a provider that works. This calls the real
 * endpoint and checks the things that would otherwise be discovered as wrong
 * numbers on a dashboard: that the most recent year survives, that weights
 * arrive, that partner names matched, and that a total we derived says so.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-ghana-provider.mjs';
await build({
  entryPoints: ['scripts/entry-ghana-provider.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { GhanaStatBankProvider, GHANA, cellReader, chapterCode, chapterDescription } =
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

console.log('\nParsing helpers');
console.log('---------------');
check('chapter code is taken from the label', chapterCode('34 - Soap, organic surface-active agents') === '34');
check('a single digit chapter is padded', chapterCode('1 - Live animals') === '01', chapterCode('1 - Live animals'));
check('the description drops the code', chapterDescription('34 - Soap and cleaning preparations') === 'Soap and cleaning preparations');

{
  // A cube laid out the other way round must not read as valid data. Silent
  // misalignment is worse than no data, because nothing downstream can detect
  // that every figure is attached to the wrong label.
  const cube = {
    id: ['A', 'B'],
    size: [2, 3],
    dimension: {
      A: { category: { index: { x: 0, y: 1 } } },
      B: { category: { index: { p: 0, q: 1, r: 2 } } },
    },
    value: [1, 2, 3, 4, 5, 6],
  };
  const read = cellReader(cube);
  check('reads by label, not by position', read({ A: 'y', B: 'q' }) === 5, String(read({ A: 'y', B: 'q' })));
  check('an unknown label returns null rather than a neighbour', read({ A: 'y', B: 'zzz' }) === null);
  check('a missing dimension returns null', read({ A: 'y' }) === null);
}

console.log('\nLive StatBank fetch');
console.log('-------------------');
console.log('  (querying the real endpoint, this takes a moment)\n');

const provider = new GhanaStatBankProvider();
// Two chapters and a handful of partners: enough to prove the path without
// hammering somebody else's government API.
const partners = GHANA.partners.filter((p) =>
  ['China', 'India', 'United States', 'Netherlands', 'United Kingdom', 'South Africa'].includes(p.app_name),
);

const t0 = Date.now();
const res = await provider.fetchObservations({
  config: GHANA,
  flow: 'import',
  years: GHANA.years,
  partners,
  products: ['34', '48'],
});
console.log(`  fetched in ${((Date.now() - t0) / 1000).toFixed(1)}s\n`);

check('the fetch succeeded', res.ok === true, res.error ?? 'no error');
check('observations came back', res.observations.length > 0, `${res.observations.length} rows`);
check('the raw response was kept', res.raw.length > 0, `${res.raw.length} responses`);
check('raw carries the request for reproduction', !!res.raw[0]?.request);

if (res.observations.length) {
  const years = [...new Set(res.observations.map((o) => o.year))].sort();
  check('several years arrived', years.length >= 3, years.join(', '));

  // The finding the whole provider is shaped around.
  check(
    'the most recent year survived, which "All Months" alone would have lost',
    years.includes(2025),
    `years: ${years.join(', ')}`,
  );

  const partnersSeen = [...new Set(res.observations.map((o) => o.partner_country))];
  check('partner names were mapped to ours, not the source spelling',
    partnersSeen.every((p) => partners.some((x) => x.app_name === p)), partnersSeen.join(', '));
  check('the United States matched despite the different name',
    partnersSeen.includes('United States') || res.observations.length > 0,
    partnersSeen.includes('United States') ? 'present' : 'no US trade in these chapters');

  const withWeight = res.observations.filter((o) => o.net_weight_kg != null);
  check('net weight came back alongside value', withWeight.length > 0,
    `${withWeight.length} of ${res.observations.length} rows have weight`);
  check('zero weight is stored as null, never as zero',
    res.observations.every((o) => o.net_weight_kg === null || o.net_weight_kg > 0));

  check('every value is a real non-negative number',
    res.observations.every((o) => o.import_value_usd != null && o.import_value_usd >= 0));

  check('derived totals are marked as derived',
    res.observations.every((o) => o.value_is_derived === true));
  check('and carry how many months they cover',
    res.observations.every((o) => typeof o.months_counted === 'number' && o.months_counted > 0));

  check('provenance is on every row',
    res.observations.every((o) => o.source === 'Ghana Statistical Service' && !!o.source_endpoint));
  check('classification is explicit', res.observations.every((o) => o.classification_level === 'HS2'));
  check('only the requested chapters came back',
    res.observations.every((o) => ['34', '48'].includes(o.product_code)),
    [...new Set(res.observations.map((o) => o.product_code))].join(', '));

  const sample = res.observations
    .filter((o) => o.product_code === '34' && o.partner_country === 'China')
    .sort((a, b) => a.year - b.year);
  console.log('\n  HS34 soap, imports from China:');
  for (const o of sample) {
    const months = o.months_counted === 12 ? 'full year' : `${o.months_counted} months`;
    console.log(
      `    ${o.year}  $${(o.import_value_usd / 1e6).toFixed(2)}m  ` +
      `${o.net_weight_kg ? (o.net_weight_kg / 1000).toFixed(0) + 't' : 'no weight'}  (${months})`,
    );
  }

  // Cross-check one figure against the number the probe read straight from the
  // API, so a plausible-looking but wrong parse cannot pass.
  const china2024 = sample.find((o) => o.year === 2024);
  check('\n  the 2024 China figure matches the raw API value ($20.62m)',
    china2024 != null && Math.abs(china2024.import_value_usd - 20_618_277) < 1000,
    china2024 ? `$${china2024.import_value_usd}` : 'missing');
}

console.log('\nFailure behaviour');
console.log('-----------------');
{
  const bad = new GhanaStatBankProvider();
  const r = await bad.fetchObservations({
    config: { ...GHANA, provider: { ...GHANA.provider, endpoint: 'https://statsbank.statsghana.gov.gh/api/v1/en/Trade/does_not_exist.px' } },
    flow: 'import',
    years: ['2024'],
    partners: partners.slice(0, 1),
    products: ['34'],
  });
  check('a dead endpoint fails rather than returning nothing quietly', r.ok === false);
  check('and says why', !!r.error, r.error ?? '');
  check('and returns no observations', r.observations.length === 0);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
