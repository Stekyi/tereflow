/** Invariants for the Business Model Canvas generator and the national year-to-date maths.   npm run test:canvas */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';
import assert from 'node:assert/strict';

const out = ['.tmp-canvas.mjs', '.tmp-nat.mjs'];
await build({ entryPoints: ['shared/canvas.ts'], outfile: out[0], bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
await build({ entryPoints: ['shared/national-series.ts'], outfile: out[1], bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { buildCanvas, canvasToText, blockDefs, LANGS } = await import(`../${out[0]}`);
const { ytdGrowth } = await import(`../${out[1]}`);
out.forEach((f) => rmSync(f));

const g = {
  inputs: { country: 'Ghana', product: 'Cocoa beans', hs: '180100', role: 'supply', budget_usd: 50000, iso3: 'GHA' },
  buyers: [{ name: 'Netherlands', value_usd: 9e8 }, { name: 'Malaysia', value_usd: 5e8 }], suppliers: [],
  chain: [{ stage: 'Export', actors: ['Cocobod'], from_data: true }, { stage: 'Guess', actors: ['x'], from_data: false }],
  problems: [{ title: 'Market dependence', research_questions: ['Who else buys?'], play: { title: 'Diversify', how: 'Approach three importers', when: 'now', risks: ['Slow payment'], reward: 'Better price' } }],
  estimate: { available: true, low_usd: 4000, high_usd: 9000 }, risk: { level: 'moderate', reasons: [] }, fx: { level: 'high', reason: 'Cedi fell' },
};
const KEYS = ['customer_segments', 'value_propositions', 'channels', 'customer_relationships', 'revenue_streams', 'key_resources', 'key_activities', 'key_partnerships', 'cost_structure'];

for (const lang of LANGS) {
  const b = buildCanvas(g, lang);
  assert.deepEqual(Object.keys(b).sort(), [...KEYS].sort(), `${lang}: exactly the nine blocks`);
  assert.deepEqual(blockDefs(lang).map((d) => d.key).sort(), [...KEYS].sort());
  assert.ok(blockDefs(lang).every((d) => d.label && d.help), `${lang}: every block has a label and helper text`);
  for (const k of KEYS) assert.ok(b[k].length > 0, `${lang}: ${k} is not empty`);
  assert.ok(Object.values(b).flat().every((l) => ['data', 'typical'].includes(l.source) && l.text.length > 0), 'every line is tagged and non-empty');
  assert.ok(!Object.values(b).flat().some((l) => /\{\w+\}/.test(l.text)), `${lang}: no unfilled placeholder`);
  assert.deepEqual(buildCanvas(g, lang), b, 'deterministic');
}
// data lines only from real data, and nothing from a chain step the data did not support
const en = buildCanvas(g, 'en');
assert.ok(en.customer_segments[0].text.includes('Netherlands'));
assert.ok(!JSON.stringify(en).includes('Guess'), 'a chain stage not from data is left out');
assert.ok(en.key_partnerships.some((l) => l.text.includes('/finance/GHA')), 'links Finance for the right country');
// no estimate, no invented range
const none = buildCanvas({ ...g, estimate: { available: false, low_usd: null, high_usd: null } }, 'en');
assert.ok(none.revenue_streams[0].text.includes('No return range'), 'no range is invented');
// procurement uses suppliers, not buyers
const proc = buildCanvas({ ...g, inputs: { ...g.inputs, role: 'procurement' }, suppliers: [{ name: 'Vietnam', value_usd: 1 }] }, 'en');
assert.ok(proc.customer_segments[0].text.includes('Vietnam') && !proc.customer_segments[0].text.includes('Netherlands'));
// text export marks the template lines for checking, in both languages
assert.ok(canvasToText('T', en, 'en', 'now').includes('[typical]'));
assert.ok(canvasToText('T', buildCanvas(g, 'de'), 'de', 'now').includes('[\u00fcblich]'));

// finance lines appear only when finance figures exist, are tagged as data, and are never invented
const fin = buildCanvas({ ...g, finance: { lending: { value: 15.94, period: '2026-08' }, policy: { value: 14, period: '2026-09' }, lcFee: { bank: 'Fidelity Bank Ghana Limited', value: 1 } } }, 'en');
assert.ok(fin.cost_structure.some((l) => l.source === 'data' && l.text.includes('15.94') && l.text.includes('14')), 'borrowing cost line from finance data');
assert.ok(fin.cost_structure.some((l) => l.source === 'data' && l.text.includes('Fidelity') && l.text.includes('1%')), 'published trade finance fee line');
const finDe = buildCanvas({ ...g, finance: { lending: { value: 15.94, period: '2026-08' } } }, 'de');
assert.ok(finDe.cost_structure.some((l) => l.text.includes('Kreditkosten') && l.text.includes('15.94')), 'German line, and no policy rate when none is held');
assert.ok(!finDe.cost_structure.some((l) => /\{\w+\}/.test(l.text)), 'no placeholder left over');
assert.equal(buildCanvas({ ...g, finance: null }, 'en').cost_structure.length, buildCanvas(g, 'en').cost_structure.length, 'no finance figures, no extra lines');
// ---- year to date ----
const m = (p, v) => ({ period: p, value_usd: v });
assert.deepEqual(ytdGrowth([m('2025-01', 100), m('2025-02', 100), m('2026-01', 150), m('2026-02', 150)]), { pct: 50, through: '2026-02', periods: 2 });
assert.equal(ytdGrowth([m('2025-01', 100), m('2026-01', 150), m('2026-02', 150)]), null, 'different periods are not comparable');
assert.equal(ytdGrowth([m('2026-01', 150)]), null, 'no earlier year, no growth');
assert.equal(ytdGrowth([]), null);
assert.equal(ytdGrowth([m('2025-01', 0), m('2026-01', 5)]), null, 'a zero base gives no percentage');
assert.deepEqual(ytdGrowth([m('2025-Q1', 200), m('2026-Q1', 100)]), { pct: -50, through: '2026-Q1', periods: 1 }, 'quarters work and can fall');
assert.deepEqual(ytdGrowth([m('2024', 100), m('2025', 110)]), { pct: 10, through: '2025', periods: 1 }, 'annual works');
console.log('canvas and national series: all checks passed');