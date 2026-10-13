/** Invariants for the import and export frameworks.   npm run test:frameworks */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-frameworks.mjs';
await build({ entryPoints: ['shared/frameworks.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { landedCost, marginRange, INCOTERMS } = await import(`../${OUT}`);
rmSync(OUT);

// 100 t at 1000, freight 5000, 1% insurance, 10% duty, 15% VAT, 2000 other
const a = landedCost({ goods_per_tonne: 1000, tonnes: 100, freight_total: 5000, insurance_pct: 1, duty_pct: 10, vat_pct: 15, other_costs: 2000, sale_per_tonne: 1600 });
assert.equal(a.goods, 100000);
assert.equal(a.insurance, 1050);
assert.equal(a.cif_value, 106050);
assert.equal(a.duty, 10605);
assert.equal(a.vat, 17498.25);
assert.equal(a.total, 136153.25);
assert.equal(a.per_tonne, 1361.53);
assert.equal(a.margin_per_tonne, 238.47);
assert.equal(a.margin_pct, 14.9);

// no sale price gives no margin rather than a guess
assert.equal(landedCost({ goods_per_tonne: 1000, tonnes: 1, freight_total: 0, insurance_pct: 0, duty_pct: 0, vat_pct: 0, other_costs: 0 }).margin_pct, null);

// bad inputs are refused
assert.equal(landedCost({ goods_per_tonne: -1, tonnes: 1, freight_total: 0, insurance_pct: 0, duty_pct: 0, vat_pct: 0, other_costs: 0 }), null);
assert.equal(landedCost({ goods_per_tonne: 1, tonnes: 0, freight_total: 0, insurance_pct: 0, duty_pct: 0, vat_pct: 0, other_costs: 0 }), null);

// margin range
assert.deepEqual(marginRange(1000, 1250, 2000).low, 20);
assert.equal(marginRange(1000, 1250, 2000).high, 50);
assert.equal(marginRange(1000, 900, 800).low, null);

assert.equal(new Set(INCOTERMS.map((t) => t.code)).size, 9);
console.log('frameworks: all invariants hold');
