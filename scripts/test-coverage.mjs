/** Invariants for ranking data coverage.   npm run test:coverage */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-coverage.mjs';
await build({ entryPoints: ['shared/coverage.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { assessCoverage, itemRankable, MIN_YEARS_TO_RANK } = await import(`../${OUT}`);
rmSync(OUT);

const items = (...ys) => ys.map((y) => ({ years_available: y }));

// one product's eligibility, with a reason for every refusal
assert.deepEqual(itemRankable(5, 2025, 2025), { ok: true, reason: null });
assert.equal(itemRankable(2, 2025, 2025).ok, false);
assert.match(itemRankable(2, 2025, 2025).reason, /Only 2 years/);
assert.match(itemRankable(1, 2025, 2025).reason, /Only 1 year of data/);
assert.match(itemRankable(null, 2025, 2025).reason, /not known/);
assert.equal(MIN_YEARS_TO_RANK, 3);
// a country behind the newest year is not compared with it
assert.equal(itemRankable(5, 2023, 2025).ok, false);
assert.match(itemRankable(5, 2023, 2025).reason, /trails the newest/);
// one year behind is tolerated
assert.equal(itemRankable(5, 2024, 2025).ok, true);

// identical coverage needs no disclosure
const same = assessCoverage([
  { iso3: 'NLD', name: 'Netherlands', latest_year: 2025, items: items(5, 5, 5, 5) },
  { iso3: 'BEL', name: 'Belgium', latest_year: 2025, items: items(5, 5, 5, 5) },
]);
assert.equal(same.comparable, true);
assert.equal(same.disclosure, null);
assert.equal(same.countries[0].level, 'complete');
assert.equal(same.countries[0].period, '2021 to 2025');

// different coverage is always disclosed, naming each country
const mixed = assessCoverage([
  { iso3: 'NLD', name: 'Netherlands', latest_year: 2025, items: items(5, 5, 5, 5) },
  { iso3: 'BEL', name: 'Belgium', latest_year: 2025, items: items(5, 2, 1, 2) },
]);
assert.equal(mixed.comparable, false);
assert.match(mixed.disclosure, /Netherlands/);
assert.match(mixed.disclosure, /Belgium/);
assert.match(mixed.disclosure, /not adjusted/);
const bel = mixed.countries.find((c) => c.iso3 === 'BEL');
assert.equal(bel.items_ranked, 1);
assert.equal(bel.items_excluded, 3);
assert.equal(bel.excluded_for_few_years, 3);
assert.equal(bel.completeness_pct, 25);
assert.equal(bel.level, 'limited');

// a country whose data stops years earlier is limited and none of its products are ranked
const stale = assessCoverage([
  { iso3: 'NLD', name: 'Netherlands', latest_year: 2025, items: items(5, 5) },
  { iso3: 'FRA', name: 'France', latest_year: 2022, items: items(5, 5) },
]);
const fra = stale.countries.find((c) => c.iso3 === 'FRA');
assert.equal(fra.stale, true);
assert.equal(fra.items_ranked, 0);
assert.equal(fra.level, 'limited');
assert.match(fra.note, /behind 2025/);
assert.equal(stale.comparable, false);

// missing years are never read as zero: an unknown count is excluded, not ranked as if it were complete
const unknown = assessCoverage([{ iso3: 'NLD', name: 'Netherlands', latest_year: 2025, items: [{ years_available: null }, { years_available: 5 }] }]);
assert.equal(unknown.countries[0].items_ranked, 1);
assert.equal(unknown.countries[0].items_excluded, 1);
assert.equal(unknown.countries[0].completeness_pct, 50);

// a country with nothing to rank is limited, not a division by zero
const empty = assessCoverage([{ iso3: 'NLD', name: 'Netherlands', latest_year: 2025, items: [] }]);
assert.equal(empty.countries[0].completeness_pct, 0);
assert.equal(empty.countries[0].level, 'limited');
assert.equal(empty.countries[0].period, null);
assert.deepEqual(assessCoverage([]), { newest_year: null, countries: [], comparable: true, disclosure: null });

console.log('coverage: all invariants hold');