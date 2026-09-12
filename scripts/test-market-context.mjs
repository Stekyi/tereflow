/**
 * Checks on the market context panel.
 *   node scripts/test-market-context.mjs
 *
 * Most of this is about years. The World Bank publishes these series on
 * different cycles: population is modelled annually, while poverty and Gini
 * come from household surveys a country runs every few years. Ghana's
 * population figure is 2025 and its Gini is 2016.
 *
 * A panel that printed both without their years would present a nine-year-old
 * inequality reading as current. That is the kind of error that does not look
 * like one, because the number is correct and only its age is wrong. So the
 * tests below are mostly about whether the age survives.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-market-context.mjs';
await build({
  entryPoints: ['worker/lib/market-context.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { loadMarketContext } = await import(`./../${OUT}`);

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

const dbOf = (rows) => ({
  prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }),
});

const row = (code, year, value, unit = 'percent', category = 'macro') => ({
  indicator_code: code,
  category,
  year,
  value,
  unit,
  source_url: `https://api.worldbank.org/v2/country/GHA/indicator/${code}`,
});

console.log('\nNothing ingested is not an empty market');
console.log('--------------------------------------');
{
  const res = await loadMarketContext(dbOf([]), 'ent_ghana');
  check('returns null rather than a panel of blanks', res === null);
}

console.log('\nEvery figure keeps its own year');
console.log('-------------------------------');
{
  const res = await loadMarketContext(
    dbOf([
      row('POP_TOTAL', 2024, 34_000_000, 'persons', 'demographics'),
      row('POP_TOTAL', 2025, 35_064_272, 'persons', 'demographics'),
      row('GINI', 2016, 43.5, 'index', 'consumer'),
    ]),
    'ent_ghana',
  );
  const all = res.groups.flatMap((g) => g.figures);
  const pop = all.find((f) => f.code === 'POP_TOTAL');
  const gini = all.find((f) => f.code === 'GINI');

  check('the newest reading is the one shown', pop.value === 35_064_272 && pop.year === 2025);
  check('an older series keeps its own year', gini.year === 2016);
  check('the reference year is the newest anywhere', res.latest_year === 2025);
}

console.log('\nAn old figure says it is old, in three places');
console.log('--------------------------------------------');
{
  const res = await loadMarketContext(
    dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics'), row('GINI', 2016, 43.5, 'index', 'consumer')]),
    'ent_ghana',
  );
  const gini = res.groups.flatMap((g) => g.figures).find((f) => f.code === 'GINI');

  check('the figure itself carries a note', typeof gini.stale_note === 'string' && gini.stale_note.length > 0, gini.stale_note);
  check('the note states the gap in years', /9 years/.test(gini.stale_note), gini.stale_note);
  check('and is listed once at the top of the panel', res.stale_figures.some((s) => /Income inequality \(2016\)/.test(s)), res.stale_figures.join(', '));
  // Said three times on purpose. Somebody scanning a grid of numbers should not
  // have to notice a year themselves to avoid being misled by it.
}

console.log('\nA current figure is not marked as old');
console.log('------------------------------------');
{
  const res = await loadMarketContext(
    dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics'), row('GDP_GROWTH', 2025, 5.7)]),
    'ent_ghana',
  );
  const all = res.groups.flatMap((g) => g.figures);
  check('no note on anything current', all.every((f) => f.stale_note === null));
  check('and nothing is listed as stale', res.stale_figures.length === 0);
}

console.log('\nStaleness is measured against the data, not the calendar');
console.log('-------------------------------------------------------');
{
  // A dataset that ends in 2019 is not stale, it is what exists. Comparing
  // against the current year would flag every figure in an old dataset as
  // suspect and drown the one that genuinely is.
  const res = await loadMarketContext(
    dbOf([row('POP_TOTAL', 2019, 30_000_000, 'persons', 'demographics'), row('GDP_GROWTH', 2019, 6.5)]),
    'ent_ghana',
  );
  check('an old but internally consistent set flags nothing', res.stale_figures.length === 0, res.stale_figures.join(', '));
  check('and reports its own newest year', res.latest_year === 2019);
}

console.log('\nThe boundary holds on both sides');
console.log('--------------------------------');
{
  const at = async (giniYear) => {
    const res = await loadMarketContext(
      dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics'), row('GINI', giniYear, 43.5, 'index', 'consumer')]),
      'ent_ghana',
    );
    return res.stale_figures.length;
  };
  check('two years behind is not called old', (await at(2023)) === 0);
  check('three years behind is', (await at(2022)) === 1);
}

console.log('\nHistory is kept in order, oldest first');
console.log('-------------------------------------');
{
  const res = await loadMarketContext(
    dbOf([
      row('GDP_GROWTH', 2022, 3.1),
      row('GDP_GROWTH', 2023, 2.9),
      row('GDP_GROWTH', 2024, 5.7),
    ]),
    'ent_ghana',
  );
  const g = res.groups.flatMap((x) => x.figures).find((f) => f.code === 'GDP_GROWTH');
  check('every year is retained', g.history.length === 3);
  check('in ascending order', JSON.stringify(g.history.map((h) => h.year)) === '[2022,2023,2024]');
  check('and the headline is the last of them', g.value === 5.7 && g.year === 2024);
}

console.log('\nA series nobody publishes is named, not zeroed');
console.log('---------------------------------------------');
{
  const res = await loadMarketContext(dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics')]), 'ent_ghana');
  const all = res.groups.flatMap((g) => g.figures);
  check('absent series do not appear as figures', all.length === 1, String(all.length));
  check('they are listed as not published', res.not_published.includes('Income inequality'), res.not_published.slice(0, 4).join(', '));
  check(
    'and no figure is invented with a zero value',
    all.every((f) => f.value !== 0),
  );
}

console.log('\nAn empty group is not rendered as an empty group');
console.log('-----------------------------------------------');
{
  const res = await loadMarketContext(dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics')]), 'ent_ghana');
  check('only groups with figures survive', res.groups.length === 1, res.groups.map((g) => g.title).join(', '));
  check('and it is the right one', res.groups[0].key === 'people');
}

console.log('\nEvery figure explains itself and cites its source');
console.log('------------------------------------------------');
{
  const res = await loadMarketContext(
    dbOf([
      row('GNI_PER_CAPITA', 2025, 2630, 'usd'),
      row('HH_CONSUMPTION_PC', 2024, 1728, 'usd', 'consumer'),
    ]),
    'ent_ghana',
  );
  const all = res.groups.flatMap((g) => g.figures);
  check('each carries a plain-language meaning', all.every((f) => f.meaning.length > 20));
  check('each carries the endpoint it came from', all.every((f) => (f.source_url ?? '').startsWith('https://')));

  // GNI per head includes company and government income and is roughly a
  // factor off household income. Saying so is the difference between a figure
  // and a misleading one.
  const gni = all.find((f) => f.code === 'GNI_PER_CAPITA');
  check('GNI per head does not claim to be household income', /not what a household earns/i.test(gni.meaning), gni.meaning);
}

console.log('\nAn unmapped code is ignored rather than shown raw');
console.log('------------------------------------------------');
{
  const res = await loadMarketContext(
    dbOf([row('POP_TOTAL', 2025, 35_000_000, 'persons', 'demographics'), row('SOME_FUTURE_CODE', 2025, 1.23)]),
    'ent_ghana',
  );
  const all = res.groups.flatMap((g) => g.figures);
  check('no figure appears without a label and a meaning', all.every((f) => f.label && f.meaning));
  check('the unmapped one is left out', !all.some((f) => f.code === 'SOME_FUTURE_CODE'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
