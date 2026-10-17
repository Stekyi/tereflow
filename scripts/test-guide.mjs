/** Invariants for the problem-to-supply rule engine.   npm run test:guide */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const OUT = '.tmp-guide.mjs';
await build({ entryPoints: ['shared/guide.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { runGuide, estimate, unitUsdT } = await import(`../${OUT}`);
rmSync(OUT);

const ser = (vals) => vals.map(([year, value_usd, qty_kg]) => ({ year, value_usd, qty_kg }));
const base = {
  country: 'Ghana', product: 'Cocoa beans', hs: '180100', role: 'supply', budget_usd: 100000,
  exports: ser([[2021, 1000, 1000], [2022, 900, 500], [2023, 600, 200], [2024, 300, 100]]),
  imports: [], buyers: [{ name: 'Netherlands', value_usd: 700, qty_kg: 700 }, { name: 'Belgium', value_usd: 300, qty_kg: 300 }],
  suppliers: [], buyer_markets: [], related: [], fx: null,
};
const ids = (r) => r.findings.map((f) => f.id).sort();

// determinism
assert.deepEqual(runGuide(base), runGuide(base));

// dependence, price swing and decline fire from the numbers
let r = runGuide(base);
assert.ok(ids(r).includes('R1'), 'a 70% buyer is flagged');
assert.ok(ids(r).includes('R5'), 'unit price 1 to 3 per kg swing is flagged');
assert.ok(ids(r).includes('R7'), 'falling value is flagged');
assert.ok(r.problems.some((p) => p.key === 'market_dependence'));

// R1 and R2 merge into one problem, R5 and R6 into one
r = runGuide({ ...base, fx: { level: 'high', reason: 'x' }, buyer_markets: [{ name: 'Netherlands', saturation: 'dominated', top_supplier: 'Ivory Coast', top_share_pct: 60, import_unit_usd_t: null, year: 2024 }] });
assert.equal(r.problems.filter((p) => p.key === 'market_dependence').length, 1);
assert.equal(r.problems.find((p) => p.key === 'price_exposure').findings.length, 2);

// below thresholds nothing fires, and no data is never read as a finding
const calm = runGuide({ ...base, buyers: [{ name: 'A', value_usd: 30, qty_kg: 1 }, { name: 'B', value_usd: 35, qty_kg: 1 }, { name: 'C', value_usd: 35, qty_kg: 1 }], exports: ser([[2021, 1000, 1000], [2022, 1010, 1000], [2023, 1020, 1000]]) });
assert.equal(calm.findings.length, 0);
assert.equal(calm.risk.level, 'low');
assert.ok(calm.risk.reasons[0].includes('not the same as no risk'));
const empty = runGuide({ ...base, exports: [], buyers: [] });
assert.equal(empty.findings.length, 0);

// value leakage needs both the import and a small export, and never uses rejected relations
const rel = (o) => ({ name: 'Cocoa butter', code: '180400', kind: 'processed', confidence: 'verified', home_export_usd: 0, home_import_usd: 5_000_000, ...o });
assert.ok(ids(runGuide({ ...base, related: [rel({})] })).includes('R3'));
assert.ok(!ids(runGuide({ ...base, related: [rel({ home_import_usd: 500_000 })] })).includes('R3'));
assert.ok(!ids(runGuide({ ...base, related: [rel({ home_export_usd: 4_000_000 })] })).includes('R3'));
assert.ok(!ids(runGuide({ ...base, related: [rel({ confidence: 'rejected' })] })).includes('R3'));

// estimate: needs a budget and both prices; shows its assumptions; never invents
assert.equal(estimate({ ...base, budget_usd: null }).available, false);
assert.equal(estimate(base).available, false, 'no buyer price held');
const priced = { ...base, exports: ser([[2024, 1000, 1000]]), buyer_markets: [{ name: 'Netherlands', saturation: 'few-main', top_supplier: null, top_share_pct: null, import_unit_usd_t: 1500, year: 2024 }] };
const e = estimate(priced);
assert.equal(e.available, true);
// 1000/t cost, 1500/t arrival, 100000 budget = 100 t, spread 500, allowance 150..350 => 150..350 per t
assert.equal(e.low_usd, 15000);
assert.equal(e.high_usd, 35000);
assert.ok(e.caveats.some((c) => c.includes('assumption')));
const flat = estimate({ ...priced, buyer_markets: [{ ...priced.buyer_markets[0], import_unit_usd_t: 900 }] });
assert.equal(flat.high_usd, 0, 'no positive gap means no profit is indicated');

// procurement compares suppliers and needs two with volume
const proc = {
  ...base, role: 'procurement', exports: [], buyers: [], imports: ser([[2024, 10_000_000, 10_000_000]]),
  suppliers: [{ name: 'A', value_usd: 5_000_000, qty_kg: 4_000_000 }, { name: 'B', value_usd: 5_000_000, qty_kg: 6_000_000 }],
};
const pr = runGuide(proc);
assert.ok(ids(pr).includes('R8') && pr.problems.some((p) => p.key === 'supply_gap'));
assert.equal(pr.estimate.available, true);
assert.equal(runGuide({ ...proc, suppliers: [proc.suppliers[0]] }).estimate.available, false);

// unit price helper
assert.equal(unitUsdT({ value_usd: 1000, qty_kg: 1000 }), 1000);
assert.equal(unitUsdT({ value_usd: 1000, qty_kg: null }), null);

// every problem carries questions, a play with risks, and every finding carries its evidence
for (const p of [...runGuide(base).problems, ...pr.problems]) {
  assert.ok(p.research_questions.length >= 2 && p.play.risks.length >= 1 && p.play.how && p.play.when);
  for (const f of p.findings) assert.ok(f.evidence.length >= 1);
}
console.log('guide: all checks passed');
