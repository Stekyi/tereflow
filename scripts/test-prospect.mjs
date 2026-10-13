/** Invariants for saturation and FX risk.   npm run test:prospect */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-prospect.mjs';
await build({ entryPoints: ['shared/prospect.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { saturation, fxRisk } = await import(`../${OUT}`);
rmSync(OUT);

const s = (name, v) => ({ name, value_usd: v });

// one supplier above 50% is dominated
const a = saturation([s('A', 600_000), s('B', 200_000), s('C', 200_000)]);
assert.equal(a.level, 'dominated');
assert.equal(a.top_share_pct, 60);

// ten even suppliers is competitive
const b = saturation(Array.from({ length: 10 }, (_, i) => s('S' + i, 100_000)));
assert.equal(b.level, 'competitive');
assert.equal(b.hhi, 0.1);

// in between
const c = saturation([s('A', 400_000), s('B', 300_000), s('C', 300_000)]);
assert.equal(c.level, 'few-main');
assert.equal(c.top3_share_pct, 100);

// too little trade, and zero values ignored
assert.equal(saturation([s('A', 1000)]).level, 'insufficient');
assert.equal(saturation([]).level, 'insufficient');
assert.equal(saturation([s('A', 0), s('B', 0)]).suppliers, 0);

// stable currency
const stable = fxRisk([2020, 2021, 2022, 2023, 2024, 2025].map((year, i) => ({ year, rate: 10 * (1 + 0.02 * i) })));
assert.equal(stable.level, 'low');

// a currency that loses half its value in one year
const wild = fxRisk([
  { year: 2020, rate: 5 }, { year: 2021, rate: 5.2 }, { year: 2022, rate: 8 },
  { year: 2023, rate: 11 }, { year: 2024, rate: 14 }, { year: 2025, rate: 12.5 },
]);
assert.equal(wild.level, 'high');
assert.equal(wild.worst_year.year, 2022);
assert.ok(wild.span_change_pct < -50);

// gaps and short series give no verdict
assert.equal(fxRisk([{ year: 2020, rate: 5 }, { year: 2024, rate: 9 }]).level, 'insufficient');
assert.equal(fxRisk([]).level, 'insufficient');
assert.equal(fxRisk([{ year: 2020, rate: -1 }, { year: 2021, rate: 0 }]).level, 'insufficient');

// a rate that never moves is reported as such, with no invented worst year
const fixed = fxRisk([2020, 2021, 2022, 2023, 2024, 2025].map((year) => ({ year, rate: 1 })));
assert.equal(fixed.level, 'low');
assert.equal(fixed.worst_year, null);
assert.ok(fixed.reason.includes('did not change'));

console.log('prospect: all invariants hold');
