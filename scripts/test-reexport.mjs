/** Invariants for the re-export signal.   npm run test:reexport */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-reexport.mjs';
await build({ entryPoints: ['shared/reexport.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { reexportSignal } = await import(`../${OUT}`);
rmSync(OUT);

const y = (year, value_usd, qty_kg = null) => ({ year, value_usd, qty_kg });

// similar size, similar price: possible
let s = reexportSignal([y(2022, 100, 100), y(2023, 120, 120), y(2024, 90, 90)], [y(2022, 110, 110), y(2023, 100, 100), y(2024, 100, 100)]);
assert.equal(s.verdict, 'possible');
assert.deepEqual(s.years, [2022, 2023, 2024]);
assert.ok(s.unit_value_ratio > 0.9 && s.unit_value_ratio < 1.1);

// no weight: still possible, and it says no price comparison was made
s = reexportSignal([y(2022, 100), y(2023, 100)], [y(2022, 100), y(2023, 100)]);
assert.equal(s.verdict, 'possible');
assert.equal(s.unit_value_ratio, null);
assert.ok(s.reason.includes('No weight'));

// one year out of range breaks it
s = reexportSignal([y(2022, 100), y(2023, 500)], [y(2022, 100), y(2023, 100)]);
assert.equal(s.verdict, 'volumes-differ');

// similar volumes but very different prices per kg: different goods
s = reexportSignal([y(2022, 100, 10), y(2023, 100, 10)], [y(2022, 100, 100), y(2023, 100, 100)]);
assert.equal(s.verdict, 'volumes-differ');
assert.ok(s.reason.includes('unit values differ'));

// one direction only, and too few common years
assert.equal(reexportSignal([y(2022, 100), y(2023, 100)], []).verdict, 'one-directional');
assert.equal(reexportSignal([], [y(2022, 100)]).verdict, 'one-directional');
assert.equal(reexportSignal([y(2022, 100), y(2023, 100)], [y(2024, 100), y(2025, 100)]).verdict, 'insufficient');
assert.equal(reexportSignal([y(2022, 100)], [y(2022, 100)]).verdict, 'insufficient');

// zero values are ignored rather than dividing by zero
s = reexportSignal([y(2022, 0), y(2023, 100), y(2024, 100)], [y(2022, 100), y(2023, 100), y(2024, 100)]);
assert.deepEqual(s.years, [2023, 2024]);

// the limits always travel with the answer
assert.ok(reexportSignal([y(2022, 1)], []).limitations.length >= 2);

console.log('reexport: all checks passed');
