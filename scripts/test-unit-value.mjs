/** Invariants for the unit-value analysis.   npm run test:unit-value */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-unit-value.mjs';
await build({ entryPoints: ['shared/unit-value.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { analyseUnitValues } = await import(`../${OUT}`);
rmSync(OUT);

const p = (partner, value_usd, kg) => ({ partner, value_usd, net_weight_kg: kg, unit_value_usd_per_kg: kg ? value_usd / kg : null });

// median, positions and the 15% band
const a = analyseUnitValues([p('A', 100, 100), p('B', 200, 100), p('C', 300, 100), p('D', 205, 100)]);
assert.equal(a.median_usd_per_kg, 2.03); // unit values 1, 2, 3, 2.05 -> median 2.025
assert.equal(a.rows.find((r) => r.partner === 'A').position, 'below');
assert.equal(a.rows.find((r) => r.partner === 'C').position, 'above');
assert.equal(a.rows.find((r) => r.partner === 'B').position, 'in-line');

// missing weight is counted, not invented
const b = analyseUnitValues([p('A', 100, 100), p('B', 200, 100), p('C', 300, 100), p('Z', 500, null)]);
assert.equal(b.covered, 3);
assert.equal(b.total, 4);
assert.equal(b.covered_value_pct, 54.5); // 600 of 1100
assert.ok(b.limitations.some((l) => l.includes('1 of 4 partners reported no weight')));
assert.ok(!b.rows.some((r) => r.partner === 'Z'));

// too few points: no median, no rows, and it says so
const c = analyseUnitValues([p('A', 100, 100), p('B', 200, 100)]);
assert.equal(c.median_usd_per_kg, null);
assert.deepEqual(c.rows, []);
assert.ok(c.limitations.some((l) => l.includes('Fewer than three')));

// empty and zero-value input do not throw or divide by zero
assert.equal(analyseUnitValues([]).covered_value_pct, 0);
assert.equal(analyseUnitValues([p('A', 0, 0)]).rows.length, 0);

console.log('unit-value: all checks passed');
