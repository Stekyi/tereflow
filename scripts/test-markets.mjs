/** Catch-all trade areas must never be treated as a buyer or a market.   npm run test:markets */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-markets.mjs';
await build({ entryPoints: ['shared/markets.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { isMarket, partnerName, onlyMarkets, areaName, AREA_NAMES } = await import(`../${OUT}`);
rmSync(OUT);

for (const real of ['USA', 'NLD', 'JPN', 'TUR', 'CHN', 'GHA', 'GIB', ' CHN ']) assert.equal(isMarket(real), true, real);
for (const area of ['WLD', '_X', '_X ', 'X1 ', 'XX ', 'S19', 'E19', 'F19', 'A79', 'O19', 'A59', '', '  ', null, undefined]) assert.equal(isMarket(area), false, JSON.stringify(area));

// the eleven codes found in the stored trade facts are all known
for (const code of ['S19', '_X', 'XX', 'X1', 'X2', 'E19', 'F19', 'A79', 'O19', 'A59', 'WLD']) assert.ok(code in AREA_NAMES, code);

// honest names, never a raw code that reads like a place
const names = { USA: 'United States' };
assert.equal(partnerName('USA', names), 'United States');
assert.equal(partnerName('S19', names), 'Other Asia, not elsewhere specified');
assert.equal(partnerName('_X ', names), 'Areas, not elsewhere specified');
assert.equal(partnerName('QQQ', names), 'Unrecognised area (QQQ)');
assert.equal(partnerName(null, names), 'Unspecified');
assert.equal(areaName('S19'), 'Other Asia, not elsewhere specified');
assert.equal(areaName('USA'), null);

// a top-N over real markets is not crowded by areas
const rows = [{ iso3: 'S19', v: 230 }, { iso3: '_X ', v: 5 }, { iso3: 'JPN', v: 40 }, { iso3: 'KOR', v: 30 }];
assert.deepEqual(onlyMarkets(rows).map((r) => r.iso3), ['JPN', 'KOR']);

console.log('markets: all invariants hold');
