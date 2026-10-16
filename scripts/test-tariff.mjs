/** Invariants for the tariff reading rules.   npm run test:tariff */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-tariff.mjs';
await build({ entryPoints: ['shared/tariff.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { readTariff } = await import(`../${OUT}`);
rmSync(OUT);

const row = (o) => ({
  year: 2023, tariff_type: 'MFN', hs_revision: 'H6', rate_pct: 0, rate_measure: 'SimpleAverage', no_ad_valorem: 0,
  total_lines: 1, pref_lines: 0, mfn_lines: 1, na_lines: 0, min_rate_pct: 0, max_rate_pct: 0, partner_code: '000',
  source: 'UNCTAD TRAINS via WITS', source_url: 'https://wits.worldbank.org/x', retrieved_at: '2026-10-16T19:00:00', ...o,
});

// a real zero is a zero
const zero = readTariff([row({})], 'The EU');
assert.equal(zero.status, 'verified');
assert.equal(zero.rate_pct, 0);
assert.match(zero.headline, /0%/);
assert.equal(zero.mixed, false);

// a mixed heading shows the average, the line count and the range, never one bare number
const oils = readTariff([row({ rate_pct: 5.99, total_lines: 11, mfn_lines: 11, max_rate_pct: 12.8 })], 'The EU');
assert.equal(oils.mixed, true);
assert.match(oils.headline, /averages 6% across 11 tariff lines/);
assert.match(oils.headline, /0% to 12\.8%/);

// specific duties have no percentage and must not read as 0%
const rice = readTariff([row({ rate_pct: null, no_ad_valorem: 1, total_lines: 16, mfn_lines: 0, na_lines: 16, min_rate_pct: null, max_rate_pct: null })], 'The EU');
assert.equal(rice.status, 'specific-duty');
assert.equal(rice.rate_pct, null);
assert.doesNotMatch(rice.headline, /0%/);

// nothing stored is unavailable, with no rate at all
const none = readTariff([], 'Ghana');
assert.equal(none.status, 'unavailable');
assert.equal(none.rate_pct, null);
assert.match(none.headline, /No verified tariff/);

// preferential rows are never presented as the MFN rate
const pref = readTariff([row({ tariff_type: 'PRF', rate_pct: 3 })], 'The EU');
assert.equal(pref.status, 'unavailable');

// the latest year wins and the history keeps every year
const multi = readTariff([row({ year: 2021, rate_pct: 4, max_rate_pct: 4, min_rate_pct: 4 }), row({ year: 2023, rate_pct: 6, max_rate_pct: 6, min_rate_pct: 6 })], 'China');
assert.equal(multi.year, 2023);
assert.deepEqual(multi.history.map((h) => h.year), [2021, 2023]);

// every verified read says it is MFN and not necessarily the rate the goods pay
assert.ok(oils.limitations.some((l) => /Most Favoured Nation/.test(l) && /not necessarily/.test(l)));
assert.ok(oils.limitations.some((l) => /Preferential/.test(l)));
assert.equal(oils.source_url, 'https://wits.worldbank.org/x');
assert.equal(oils.hs_revision, 'H6');

console.log('tariff: all invariants hold');
