/**
 * What the score bands actually catch.
 *
 * Bands are only useful if they separate. "Strong case" on sixty percent of a
 * list tells a reader nothing, and neither would it on three percent. This
 * pulls every scored opening and reports the real distribution, so a cut-off
 * is chosen against the data rather than picked because it is a round number.
 *
 *   node scripts/score-bands.mjs
 */
const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return r.json();
}

// Signals are capped per country, so asking country by country is what gets
// past the page limit without raising it for everybody.
const { entities } = await get('/api/entities?active=1');
const seen = new Map();

for (const e of entities ?? []) {
  const r = await get(`/api/products?country=${encodeURIComponent(e.slug)}&limit=120&all=1`);
  for (const p of r.products ?? []) {
    seen.set(`${p.flow}:${p.hs_code}:${p.iso3}`, p);
  }
}

const all = [...seen.values()];
const scores = all.map((p) => p.score).sort((a, b) => a - b);

if (!scores.length) {
  console.log('\nNo scored openings. Run the pipeline first.\n');
  process.exit(1);
}

const pct = (p) => scores[Math.min(scores.length - 1, Math.floor((p / 100) * scores.length))];
const countAtOrAbove = (n) => scores.filter((s) => s >= n).length;

console.log(`\n${scores.length} scored openings\n`);
console.log(`  lowest   ${scores[0]}`);
console.log(`  10th     ${pct(10)}`);
console.log(`  25th     ${pct(25)}`);
console.log(`  median   ${pct(50)}`);
console.log(`  75th     ${pct(75)}`);
console.log(`  90th     ${pct(90)}`);
console.log(`  highest  ${scores[scores.length - 1]}`);

console.log('\n  DISTRIBUTION');
const lo = Math.floor(scores[0] / 5) * 5;
const hi = Math.ceil(scores[scores.length - 1] / 5) * 5;
for (let b = lo; b < hi; b += 5) {
  const n = scores.filter((s) => s >= b && s < b + 5).length;
  if (!n) continue;
  const bar = '#'.repeat(Math.max(1, Math.round((n / scores.length) * 120)));
  console.log(`    ${String(b).padStart(3)}-${String(b + 4).padStart(3)}  ${String(n).padStart(4)}  ${bar}`);
}

console.log('\n  WHAT A CUT-OFF WOULD CATCH');
for (const n of [55, 60, 65, 70, 75, 80, 85]) {
  const c = countAtOrAbove(n);
  const share = ((c / scores.length) * 100).toFixed(0);
  console.log(`    at ${n}:  ${String(c).padStart(4)} of ${scores.length}  (${String(share).padStart(3)}%)`);
}

// A band worth having puts a minority above it, or the label is decoration.
const target = (share) => {
  for (let n = 100; n >= 0; n--) if (countAtOrAbove(n) / scores.length >= share) return n;
  return 0;
};
console.log('\n  TO CATCH A GIVEN SHARE');
console.log(`    top 10 percent starts at  ${target(0.1)}`);
console.log(`    top 20 percent starts at  ${target(0.2)}`);
console.log(`    top 40 percent starts at  ${target(0.4)}`);

const current = await get('/api/products?limit=1');
console.log(
  `\n  Currently strong catches ${current.summary.strong} of ${current.summary.total}`
    + ` (${((current.summary.strong / current.summary.total) * 100).toFixed(0)} percent)\n`,
);
