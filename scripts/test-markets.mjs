/** Catch-all trade areas must never be treated as a buyer or a market.   npm run test:markets */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-markets.mjs';
await build({ entryPoints: ['shared/markets.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { isMarket } = await import(`../${OUT}`);
rmSync(OUT);

for (const real of ['USA', 'NLD', 'JPN', 'TUR', 'CHN', 'GHA']) assert.equal(isMarket(real), true, real);
for (const area of ['WLD', '_X', '_X ', 'X1', 'XX', 'E19', 'R91', '', '  ']) assert.equal(isMarket(area), false, JSON.stringify(area));

console.log('markets: all invariants hold');
