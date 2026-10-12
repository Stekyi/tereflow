/** Invariants for the production signal and its HS to FAO table.   npm run test:production */
import { build } from 'esbuild';
import { rmSync, readFileSync, existsSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-production.mjs';
await build({ entryPoints: ['shared/production.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { productionSignal, PRODUCTION_ITEMS } = await import(`../${OUT}`);
rmSync(OUT);

// the table has no duplicate headings or FAO codes
assert.equal(new Set(PRODUCTION_ITEMS.map((p) => p.hs)).size, PRODUCTION_ITEMS.length);
assert.equal(new Set(PRODUCTION_ITEMS.map((p) => p.faoCode)).size, PRODUCTION_ITEMS.length);
assert.ok(PRODUCTION_ITEMS.every((p) => /^\d{4}$/.test(p.hs) && p.item && p.label));

// every entry matches the real FAOSTAT item list, by code AND name, when that file is on disk
const f = 'local/fao/x/Production_Crops_Livestock_E_ItemCodes.csv';
if (existsSync(f)) {
  const rows = readFileSync(f, 'utf8').split(/\r?\n/).slice(1).filter(Boolean).map((l) => l.match(/("([^"]|"")*"|[^,]*)/g).filter((_, i) => i % 2 === 0).map((c) => c.replace(/^"|"$/g, '')));
  const byCode = new Map(rows.map((r) => [Number(r[0]), r[2]]));
  for (const p of PRODUCTION_ITEMS) assert.equal((byCode.get(p.faoCode) ?? '').replace(/;/g, ','), p.item, `FAO ${p.faoCode} is "${byCode.get(p.faoCode)}", not "${p.item}"`);
  console.log(`  checked ${PRODUCTION_ITEMS.length} items against the real FAOSTAT item list`);
}

const pt = (year, tonnes, flag = 'A') => ({ year, tonnes, area_ha: null, flag });

// a normal series: latest, five-year change, and the proportion to exports
let s = productionSignal('180100', [pt(2018, 1000), pt(2019, 1100), pt(2020, 1200), pt(2021, 1300), pt(2022, 1500)], { 2022: 600_000 });
assert.equal(s.available, true);
assert.equal(s.latest_year, 2022);
assert.equal(s.latest_tonnes, 1500);
assert.equal(s.change_5y_pct, 50);
assert.equal(s.production_to_export_ratio, 2.5);  // 1500 t produced vs 600 t exported
assert.equal(s.item, 'cocoa beans');

// no export weight: ratio is absent, never zero
s = productionSignal('180100', [pt(2021, 100), pt(2022, 110)], {});
assert.equal(s.production_to_export_ratio, null);

// a heading not in the table is unavailable and says so, never an approximation
s = productionSignal('870323', [pt(2022, 5)]);
assert.equal(s.available, false);
assert.ok(s.reason.includes('not one of the crops'));

// a mapped product with no data for the country
s = productionSignal('180100', []);
assert.equal(s.available, false);
assert.ok(s.reason.includes('no production figure'));

// missing values are ignored, a zero first year does not divide by zero
s = productionSignal('180100', [pt(2020, 0), pt(2021, null), pt(2022, 50)]);
assert.equal(s.latest_tonnes, 50);
assert.equal(s.change_5y_pct, null);

// six-digit and ten-digit codes resolve through their heading
assert.equal(productionSignal('100590', [pt(2022, 7)]).item, 'maize');
assert.equal(productionSignal('1005901000', [pt(2022, 7)]).item, 'maize');

// source, scope and limits always travel with the answer
assert.ok(productionSignal('999999', []).limitations.length >= 2);
assert.ok(productionSignal('999999', []).source.includes('FAOSTAT'));

console.log('production: all checks passed');
