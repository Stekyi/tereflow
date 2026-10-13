/** Invariants for the unit cost trend.   npm run test:unit-cost */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-unit-cost.mjs';
await build({ entryPoints: ['shared/unit-cost.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { unitCostTrend } = await import(`../${OUT}`);
rmSync(OUT);

// per kilogram with year-on-year change
const a = unitCostTrend([
  { year: 2022, value_usd: 1000, qty_kg: 500 },
  { year: 2023, value_usd: 1500, qty_kg: 500 },
]);
assert.equal(a.rows[0].price, 2);
assert.equal(a.rows[1].price, 3);
assert.equal(a.rows[1].change_pct, 50);
assert.equal(a.rows[0].change_pct, null);

// unit fallback when weight is missing, and no change figure across different bases
const b = unitCostTrend([
  { year: 2022, value_usd: 1000, qty_kg: 500 },
  { year: 2023, value_usd: 900, qty_kg: null, qty: 300, qty_unit: 'items' },
]);
assert.equal(b.rows[1].basis, 'unit');
assert.equal(b.rows[1].price, 3);
assert.equal(b.rows[1].change_pct, null);
assert.ok(b.limitations.some((l) => l.includes('not comparable')));

// a year with neither is counted, not filled, and breaks the change chain
const c = unitCostTrend([
  { year: 2021, value_usd: 100, qty_kg: 100 },
  { year: 2022, value_usd: 100, qty_kg: null },
  { year: 2023, value_usd: 200, qty_kg: 100 },
]);
assert.equal(c.years_priced, 2);
assert.equal(c.rows[1].change_pct, null);
assert.ok(c.limitations.some((l) => l.includes('1 of 3 years')));

// nothing priceable gives no rows
assert.equal(unitCostTrend([{ year: 2022, value_usd: 5, qty_kg: null }]).rows.length, 0);

// a year-on-year move of 100% or more is flagged for checking, not presented as a plain trend
const d = unitCostTrend([
  { year: 2024, value_usd: 100, qty_kg: 100 },
  { year: 2025, value_usd: 370, qty_kg: 100 },
]);
assert.ok(d.limitations.some((l) => l.includes('2025') && l.includes('check the source')));
assert.ok(!unitCostTrend([{ year: 2022, value_usd: 100, qty_kg: 100 }, { year: 2023, value_usd: 150, qty_kg: 100 }]).limitations.some((l) => l.includes('check the source')));

console.log('unit-cost: all invariants hold');
