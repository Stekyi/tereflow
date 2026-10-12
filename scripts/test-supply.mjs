/** Invariants for the supply-constraint signal.   npm run test:supply */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-supply.mjs';
await build({ entryPoints: ['shared/supply.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { supplyConstraint } = await import(`../${OUT}`);
rmSync(OUT);

const p = (name, value_usd) => ({ name, value_usd });

// one dominant partner
let s = supplyConstraint([p('A', 900_000), p('B', 50_000), p('C', 50_000)]);
assert.equal(s.level, 'high');
assert.equal(s.top_supplier, 'A');
assert.equal(s.top_share_pct, 90);
assert.ok(s.reason.includes('90%'));

// ten equal partners: hhi is 0.1, low
s = supplyConstraint(Array.from({ length: 10 }, (_, i) => p(`P${i}`, 200_000)));
assert.equal(s.level, 'low');
assert.equal(s.hhi, 0.1);
assert.equal(s.suppliers, 10);

// a single partner is the extreme case
s = supplyConstraint([p('Only', 500_000)]);
assert.equal(s.level, 'high');
assert.equal(s.hhi, 1);

// moderate by index alone: 4 partners at 40/30/20/10 -> 0.30 -> actually high; 5 at 30/25/20/15/10 -> 0.2 moderate
s = supplyConstraint([p('A', 300_000), p('B', 250_000), p('C', 200_000), p('D', 150_000), p('E', 100_000)]);
assert.equal(s.level, 'moderate');

// well spread but wildly volatile years is moderate, and says why
const spread = Array.from({ length: 12 }, (_, i) => p(`P${i}`, 100_000));
s = supplyConstraint(spread, [100, 900, 150, 1000, 80]);
assert.equal(s.level, 'moderate');
assert.ok(s.reason.includes('swing'));
assert.ok(s.volatility_pct >= 40);

// volatility needs four years; with fewer it is not reported
s = supplyConstraint(spread, [100, 900, 150]);
assert.equal(s.level, 'low');
assert.equal(s.volatility_pct, null);

// too little trade, empty, and zero-value partners are ignored
assert.equal(supplyConstraint([p('A', 5_000)]).level, 'insufficient');
assert.equal(supplyConstraint([]).level, 'insufficient');
s = supplyConstraint([p('A', 0), p('B', 400_000), p('C', 400_000)]);
assert.equal(s.suppliers, 2);

// the limits always travel with it
assert.ok(supplyConstraint([]).limitations.length >= 2);

console.log('supply: all checks passed');
