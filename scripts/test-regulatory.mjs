/** Parser checks against real, trimmed UK Trade Tariff responses.   npm run test:regulatory */
import { build } from 'esbuild';
import { rmSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-regulatory.mjs';
await build({ entryPoints: ['shared/regulatory.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { parseCommodity, pickCommodity } = await import(`../${OUT}`);
rmSync(OUT);
const fx = (code) => JSON.parse(readFileSync(`scripts/fixtures/tariff-${code}.json`, 'utf8'));

// cars: percentage duty, VAT, a suspension and controls that apply to everyone
let r = parseCommodity(fx('8703101100'));
assert.equal(r.commodity_code, '8703101100');
assert.deepEqual(r.third_country_duty, ['4.00 %']);
assert.equal(r.vat, '20.00 %');
assert.equal(r.duty_suspended, true);
assert.ok(r.controls.includes('Import control of fluorinated greenhouse gases'));
assert.ok(r.controls.includes('Import control - waste'));
assert.ok(r.preference_areas > 10, `preference areas ${r.preference_areas}`);

// champagne: a duty per hectolitre, not a percentage, and the organic-products control
r = parseCommodity(fx('2204101100'));
assert.deepEqual(r.third_country_duty, ['26.00 GBP / hl']);
assert.ok(r.controls.includes('Import control of organic products'));
assert.ok(r.country_restrictions.some((x) => x.area === 'North Korea'));

// cocoa: parsed, and never invents a control that the tariff does not list
r = parseCommodity(fx('1801000000'));
assert.ok(r.commodity_code === '1801000000' && r.description.toLowerCase().includes('cocoa'));
assert.equal(r.vat === null || /%/.test(r.vat), true);
assert.ok(r.controls.every((c) => /control|licen|prohib|quota|restriction|ban/i.test(c)));
assert.ok(r.country_restrictions.length <= 12);

// a measure for one country never becomes an "everyone" control
const gen = parseCommodity(fx('8703101100'));
assert.ok(!gen.controls.some((c) => /Restriction on entry into free circulation/.test(c)));
assert.ok(gen.country_restrictions.every((x) => x.area && x.measure));

// bad input is null, not a crash
assert.equal(parseCommodity(null), null);
assert.equal(parseCommodity({}), null);
assert.equal(parseCommodity({ data: { attributes: {} } }), null);

// picking a tariff line from a heading
const heading = { included: [
  { type: 'commodity', attributes: { goods_nomenclature_item_id: '8703231910', declarable: true } },
  { type: 'commodity', attributes: { goods_nomenclature_item_id: '8703230000', declarable: false } },
  { type: 'commodity', attributes: { goods_nomenclature_item_id: '8703231100', declarable: true } },
  { type: 'commodity', attributes: { goods_nomenclature_item_id: '8703310000', declarable: true } },
  { type: 'chapter', attributes: {} },
] };
assert.deepEqual(pickCommodity(heading, '870323'), { code: '8703231100', lines: 2 });
assert.equal(pickCommodity(heading, '870399'), null);
assert.equal(pickCommodity(null, '870323'), null);

console.log('regulatory: all checks passed');
