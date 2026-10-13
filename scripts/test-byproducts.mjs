/** Invariants for the by-product template.   npm run test:byproducts */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-byproducts.mjs';
await build({ entryPoints: ['shared/byproducts.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { byproductAnalysis, clampThresholds, DEFAULT_THRESHOLDS } = await import(`../${OUT}`);
rmSync(OUT);

// import gap beats under-processed
const a = byproductAnalysis('180100', 100_000_000, [
  { hs4: '1802', exports_usd: 50_000_000, imports_usd: null },
  { hs4: '1803', exports_usd: 1_000_000, imports_usd: 2_000_000 }, { hs4: '1806', exports_usd: 40_000_000, imports_usd: 9_000_000 },
  { hs4: '1804', exports_usd: 2_000_000, imports_usd: 0 },
  { hs4: '1805', exports_usd: null, imports_usd: null },
]);
const v = Object.fromEntries(a.rows.map((r) => [r.hs4, r.verdict]));
assert.equal(v['1802'], 'covered');
assert.equal(v['1803'], 'import-gap');
assert.equal(v['1804'], 'under-processed');
assert.equal(v['1805'], 'no-data');
assert.ok(a.services.length === 1 && a.services[0].title.includes('storage'));

// below the main-export floor nothing is claimed and no services are suggested
const b = byproductAnalysis('180100', 1_000_000, [{ hs4: '1803', exports_usd: 0, imports_usd: 9_000_000 }]);
assert.equal(b.eligible, false);
assert.equal(b.rows.find((r) => r.hs4 === '1803').verdict, 'covered');
assert.equal(b.services.length, 0);

// thresholds are tunable and clamped
const c = byproductAnalysis('180100', 100_000_000, [{ hs4: '1803', exports_usd: 20_000_000, imports_usd: null }], { under_ratio: 0.5 });
assert.equal(c.rows.find((r) => r.hs4 === '1803').verdict, 'under-processed');
assert.deepEqual(clampThresholds({ under_ratio: 7, min_main_usd: -1 }), DEFAULT_THRESHOLDS);

// unknown heading gives no suggestions and says so
const d = byproductAnalysis('999900', 100_000_000, []);
assert.equal(d.rows.length, 0);
assert.ok(d.limitations[0].includes('No by-products are listed'));

// perishable chapters get cold-chain ideas
const e = byproductAnalysis('080410', 50_000_000, []);
assert.ok(e.services.some((s) => s.title.includes('Cold chain')));

// a country that already exports plenty of a by-product is not flagged just because it also imports some
const f = byproductAnalysis('180100', 100_000_000, [{ hs4: '1803', exports_usd: 80_000_000, imports_usd: 9_000_000 }]);
assert.equal(f.rows.find((r) => r.hs4 === '1803').verdict, 'covered');

console.log('byproducts: all invariants hold');
