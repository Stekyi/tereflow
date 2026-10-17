/** Invariants for the by-product knowledge base reading and the gap analysis.   npm run test:byproducts */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-byproducts.mjs';
await build({ entryPoints: ['shared/byproducts.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { byproductAnalysis, relationshipsFor, clampThresholds, DEFAULT_THRESHOLDS } = await import(`../${OUT}`);
rmSync(OUT);

const kb = (o) => ({
  id: `${o.parent_code}>${o.byproduct_code}`, parent_name: 'p', parent_code: '180100', byproduct_name: 'b', byproduct_code: '180200',
  kind: 'residue', process_method: 'x', applications: 'y', detail_sourced: 0, status: 'established', confidence: 'verified',
  byproduct_hs_official: 'official', hs_codes_checked: 1, derivation_checked: 1, trade_evidence_usd: 1e8, trade_evidence_year: 2025,
  trade_evidence_note: 'n', evidence_note: 'e', source_name: 's', source_url: 'https://example.org', verified_at: '2026-10-16', ...o,
});
const rows = [
  kb({ parent_code: '180100', byproduct_code: '1802' }),
  kb({ parent_code: '180100', byproduct_code: '1803' }),
  kb({ parent_code: '180100', byproduct_code: '1804' }),
  kb({ parent_code: '180100', byproduct_code: '1805' }),
  // a heading-level parent and a line-level parent for the same heading
  kb({ parent_code: '0801', byproduct_code: '9999', byproduct_name: 'heading level' }),
  kb({ parent_code: '080131', byproduct_code: '080132', byproduct_name: 'cashew kernel' }),
  kb({ parent_code: '080131', byproduct_code: '0802', byproduct_name: 'wrong heading', status: 'rejected', confidence: 'rejected', evidence_note: 'Shelled cashew is 080132.' }),
  kb({ parent_code: '080131', byproduct_code: null, byproduct_name: 'shell liquid', confidence: 'unverified', status: 'possible' }),
];

// the most specific parent wins, so a line-level relationship is never mixed with a heading-level one
const cashew = relationshipsFor(rows, '080131');
assert.equal(cashew.parent_code, '080131');
assert.deepEqual(cashew.active.map((r) => r.byproduct_name), ['cashew kernel', 'shell liquid']);
assert.ok(!cashew.active.some((r) => r.byproduct_name === 'heading level'));
// a product that only has a heading-level parent falls back to it
assert.equal(relationshipsFor(rows, '080119').parent_code, '0801');
// a rejected relationship is never active, but is reported so it is not quietly re-added
assert.deepEqual(cashew.rejected.map((r) => r.byproduct_name), ['wrong heading']);
// an unknown product matches nothing
assert.deepEqual(relationshipsFor(rows, '999999'), { parent_code: null, active: [], rejected: [] });
// a longer code under the parent still matches it
assert.equal(relationshipsFor(rows, '18010000').parent_code, '180100');
// the same by-product listed twice for one parent appears once
const dup = relationshipsFor([...rows, kb({ parent_code: '180100', byproduct_code: '1802' })], '180100');
assert.equal(dup.active.filter((r) => r.byproduct_code === '1802').length, 1);

// import gap beats under-processed, and the evidence travels with each row
const cocoa = relationshipsFor(rows, '180100');
const a = byproductAnalysis('180100', 100_000_000, [
  { code: '1802', exports_usd: 50_000_000, imports_usd: null },
  { code: '1803', exports_usd: 1_000_000, imports_usd: 2_000_000 },
  { code: '1804', exports_usd: 2_000_000, imports_usd: 0 },
  { code: '1805', exports_usd: null, imports_usd: null },
], cocoa);
const v = Object.fromEntries(a.rows.map((r) => [r.byproduct_code, r.verdict]));
assert.deepEqual(v, { 1802: 'covered', 1803: 'import-gap', 1804: 'under-processed', 1805: 'no-data' });
assert.ok(a.rows.every((r) => r.confidence && r.source_url && r.verified_at));
assert.equal(a.main_code, '180100');
assert.equal(a.services.length, 1);

// a by-product with no code cannot be traded-checked and says so
const noCode = byproductAnalysis('080131', 100_000_000, [{ code: '080132', exports_usd: 1, imports_usd: 1 }], cashew);
const shell = noCode.rows.find((r) => r.byproduct_name === 'shell liquid');
assert.equal(shell.verdict, 'no-data');
assert.match(shell.reason, /no confirmed HS code/);
// the rejected relationship is reported, not analysed
assert.equal(noCode.unsupported.length, 1);
assert.ok(!noCode.rows.some((r) => r.byproduct_code === '0802'));

// below the main-export floor nothing is claimed and no services are suggested
const b = byproductAnalysis('180100', 1_000_000, [{ code: '1803', exports_usd: 0, imports_usd: 9_000_000 }], cocoa);
assert.equal(b.eligible, false);
assert.equal(b.rows.find((r) => r.byproduct_code === '1803').verdict, 'covered');
assert.equal(b.services.length, 0);

// thresholds are tunable and clamped
const c = byproductAnalysis('180100', 100_000_000, [{ code: '1803', exports_usd: 20_000_000, imports_usd: null }], cocoa, { under_ratio: 0.5 });
assert.equal(c.rows.find((r) => r.byproduct_code === '1803').verdict, 'under-processed');
assert.deepEqual(clampThresholds({ under_ratio: 7, min_main_usd: -1 }), DEFAULT_THRESHOLDS);

// a country that already exports plenty of a by-product is not flagged just because it also imports some
const f = byproductAnalysis('180100', 100_000_000, [{ code: '1803', exports_usd: 80_000_000, imports_usd: 9_000_000 }], cocoa);
assert.equal(f.rows.find((r) => r.byproduct_code === '1803').verdict, 'covered');

// nothing in the knowledge base: no suggestion, and it says so first
const none = byproductAnalysis('999999', 100_000_000, [], relationshipsFor(rows, '999999'));
assert.equal(none.rows.length, 0);
assert.match(none.limitations[0], /No by-products are in the knowledge base/);

// the limitations never claim the list is hardcoded or complete, and say what 'verified' means
assert.ok(a.limitations.some((l) => /verified/i.test(l) && /derivation/.test(l)));
assert.ok(a.limitations.some((l) => /not yet tied to a cited source/.test(l)));

// perishable chapters get cold-chain ideas
const e = byproductAnalysis('080410', 50_000_000, [], { parent_code: '0804', active: [], rejected: [] });
assert.ok(e.services.some((s) => s.title.includes('Cold chain')));

console.log('byproducts: all invariants hold');