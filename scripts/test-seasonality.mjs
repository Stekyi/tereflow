/** Invariants for the seasonality signal.   npm run test:seasonality */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-seasonality.mjs';
await build({ entryPoints: ['shared/seasonality.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { seasonality } = await import(`../${OUT}`);
rmSync(OUT);

const years = (ys, f) => ys.flatMap((year) => Array.from({ length: 12 }, (_, i) => ({ year, month: i + 1, value_usd: f(year, i + 1) })));

// flat: no seasonality, and the index is 1.0 everywhere
let s = seasonality(years([2021, 2022, 2023, 2024], () => 1_000_000));
assert.equal(s.verdict, 'not-seasonal');
assert.ok(s.index.every((v) => v === 1));

// a December peak that recurs every year, at three times a normal month
s = seasonality(years([2021, 2022, 2023, 2024], (_y, m) => (m === 12 ? 3_000_000 : 1_000_000)));
assert.equal(s.verdict, 'seasonal');
assert.equal(s.peak_month, 12);
assert.equal(s.consistency_pct, 100);
assert.ok(s.peak_index > 2);

// growth alone does not read as seasonal: every month doubles year on year
s = seasonality(years([2021, 2022, 2023, 2024], (y) => 1_000_000 * 2 ** (y - 2021)));
assert.equal(s.verdict, 'not-seasonal');

// a peak that moves around each year is not reliable
const wander = { 2021: 3, 2022: 7, 2023: 11, 2024: 5 };
s = seasonality(years([2021, 2022, 2023, 2024], (y, m) => (m === wander[y] ? 3_000_000 : 1_000_000)));
assert.notEqual(s.verdict, 'seasonal');
assert.ok(s.consistency_pct < 66);

// a modest recurring peak is mild, not strong
s = seasonality(years([2021, 2022, 2023], (_y, m) => (m === 6 ? 2_500_000 : 1_000_000)));
assert.ok(['mildly-seasonal', 'seasonal'].includes(s.verdict));
s = seasonality(years([2021, 2022, 2023], (_y, m) => (m === 6 ? 1_450_000 : 1_000_000)));
assert.equal(s.verdict, 'mildly-seasonal');

// an incomplete year is left out, and too few complete years says so
const partial = years([2021, 2022], () => 1_000_000).concat(years([2023], () => 1_000_000).slice(0, 8));
s = seasonality(partial);
assert.equal(s.verdict, 'insufficient');
assert.deepEqual(s.years, [2021, 2022]);
assert.ok(s.reason.includes('2 years'));

// trade too small to read a pattern from
s = seasonality(years([2021, 2022, 2023, 2024], () => 1_000));
assert.equal(s.verdict, 'insufficient');
assert.ok(s.reason.includes('too small'));

// empty, zero and out-of-range months are ignored without throwing
assert.equal(seasonality([]).verdict, 'insufficient');
assert.equal(seasonality([{ year: 2021, month: 13, value_usd: 5 }, { year: 2021, month: 1, value_usd: 0 }]).verdict, 'insufficient');

// limits always travel with the answer
assert.ok(seasonality([]).limitations.length >= 2);

console.log('seasonality: all checks passed');
