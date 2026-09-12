/**
 * Checks on the three things the product modal now claims for itself.
 *   node scripts/test-insight-parts.mjs
 *
 * Written after an update flagged three complaints that each turned out to be
 * a different problem from the one reported:
 *
 *   - "Export value and unit value not reported." Both were present. What was
 *     missing was any explanation of the cases where a filer sends a value and
 *     no weight, which is over half of all rows.
 *   - "Buyer and seller focus is broken." The API had partner data the whole
 *     time; the modal was showing world totals and apologising for it.
 *   - "Near-identical products clutter the groupings." They were not
 *     duplicates. Four vehicle lines differ only by engine size, and every
 *     label was clipped before the part that said which was which.
 *
 * So the checks below are about a number reconciling with its own explanation,
 * and about a label keeping the part that distinguishes it.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-insight-parts.mjs';
await build({
  entryPoints: ['scripts/_insight-parts-entry.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { explainScore, opportunityScore, disambiguateProductNames, shortProductName } = await import(
  `./../${OUT}`
);

let passed = 0;
let failed = 0;
function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`);
  }
}

console.log('\nThe breakdown adds up to the number beside it');
console.log('---------------------------------------------');
// A breakdown that does not reconcile teaches the reader to distrust both the
// parts and the total, which is worse than showing no breakdown at all.
{
  const cases = [
    { label: 'an ordinary line', s: { cagr_3y: 32, momentum: 0.6, confidence: 0.7, value_usd: 4.2e8 } },
    { label: 'everything missing', s: { cagr_3y: null, momentum: null, confidence: null, value_usd: null } },
    { label: 'a near-zero base year', s: { cagr_3y: 347.3, momentum: 0.86, confidence: 0.72, value_usd: 1.65e8 } },
    { label: 'a tiny trade', s: { cagr_3y: 5, momentum: 0.1, confidence: 0.2, value_usd: 1000 } },
    { label: 'a shrinking trade', s: { cagr_3y: -40, momentum: 0.2, confidence: 0.9, value_usd: 9e9 } },
  ];
  for (const { label, s } of cases) {
    const direct = opportunityScore(s);
    const explained = explainScore(s);
    check(`${label}: headline matches`, direct === explained.score, `${direct} vs ${explained.score}`);
    const summed = Math.round(explained.components.reduce((a, c) => a + c.points, 0));
    check(`${label}: parts sum to the headline`, summed === explained.score, `${summed} vs ${explained.score}`);
    check(
      `${label}: no term can exceed its own weight`,
      explained.components.every((c) => c.points <= c.weight + 1e-9),
    );
  }
}

console.log('\nAn absent input is reported as absent, not as zero');
console.log('-------------------------------------------------');
{
  const e = explainScore({ cagr_3y: null, momentum: null, confidence: null, value_usd: null });
  check('every term still appears', e.components.length === 4, `${e.components.length}`);
  check(
    'nothing claims a figure it does not have',
    e.components.every((c) => c.input !== '0' && c.input !== '$0'),
    e.components.map((c) => c.input).join(' | '),
  );
}

console.log('\nRunaway growth is credited, not believed');
console.log('----------------------------------------');
// A line going from five thousand dollars to four hundred million is not
// compounding at four thousand percent a year, it is a base of nothing.
{
  const wild = explainScore({ cagr_3y: 347.3, momentum: 0.86, confidence: 0.72, value_usd: 1.65e8 });
  const growth = wild.components.find((c) => c.label === 'Growth');
  check('it does not take the full growth weight', growth.points < growth.weight, `${growth.points} of ${growth.weight}`);
  check('and it says why in the open', Boolean(growth.note) && /near-zero|starting point/i.test(growth.note));

  // cagr_3y is a percentage, not a ratio: 120 means 120% a year. Anything over
  // 300 is treated as a near-zero base instead, so 120 is the case of growth
  // that is genuinely fast and genuinely measured.
  const steady = explainScore({ cagr_3y: 120, momentum: 0.86, confidence: 0.72, value_usd: 1.65e8 });
  const steadyGrowth = steady.components.find((c) => c.label === 'Growth');
  check('genuine strong growth still takes full marks', steadyGrowth.points === steadyGrowth.weight);
  check('and carries no caveat', steadyGrowth.note == null);
}

console.log('\nNear-identical labels keep what tells them apart');
console.log('-----------------------------------------------');
{
  const vehicles = [
    ['870321', 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity not over 1000cc'],
    ['870322', 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 1000 but not over 1500cc'],
    ['870323', 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 1500 but not over 3000cc'],
    ['870324', 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 3000cc'],
  ].map(([code, description]) => ({ code, description }));

  const before = new Set(vehicles.map((v) => shortProductName(v.description)));
  check('the shortener alone collapses all four to one label', before.size === 1, `${before.size} distinct`);

  const labels = disambiguateProductNames(vehicles);
  const after = new Set(labels.values());
  check('disambiguation gives each its own', after.size === 4, `${after.size} distinct`);
  check('no line is dropped', labels.size === 4);
  check('the engine size is what carries the difference', [...after].every((l) => /cc\)?$/.test(l)), [...after][0]);

  // Merging these would hide that a market for engines under 1000cc is a
  // different business from one over 3000cc.
  check('1000cc and 3000cc do not end up saying the same thing', labels.get('870321') !== labels.get('870324'));

  // The filer's own wording is kept. "not over 1000cc" is their phrase;
  // rewriting it as "up to 1000cc" would be this codebase speaking, not them.
  check('the filer\'s wording survives', labels.get('870321').includes('not over 1000cc'), labels.get('870321'));

  // A tail must not begin part-way through a comparison. Where only the upper
  // bands are in view the shared prefix reaches "cylinder capacity over ", and
  // keeping that word on the shared side leaves a tail reading "1500 but not
  // over 3000cc", which says the band starts at 1500 rather than above it.
  const upper = disambiguateProductNames(vehicles.slice(1));
  check(
    'no tail starts mid-comparison',
    [...upper.values()].every((l) => !/\(\s*\d/.test(l)),
    [...upper.values()].join(' | '),
  );
  check(
    'each band still says where it starts',
    [...upper.values()].every((l) => /\((not )?over /.test(l)),
    upper.get('870323'),
  );
}

console.log('\nProducts that were never ambiguous are left alone');
console.log('-------------------------------------------------');
{
  const items = [
    { code: '180100', description: 'Cocoa beans, whole or broken, raw or roasted' },
    { code: '710812', description: 'Metals; gold, unwrought, non-monetary' },
  ];
  const labels = disambiguateProductNames(items);
  for (const i of items) {
    check(
      `${i.code} keeps its plain short name`,
      labels.get(i.code) === shortProductName(i.description),
      labels.get(i.code),
    );
  }
  check('no bracket is invented', [...labels.values()].every((l) => !/\(HS /.test(l)));
}

console.log('\nA missing description is not a missing product');
console.log('----------------------------------------------');
{
  const labels = disambiguateProductNames([
    { code: '999999', description: null },
    { code: '888888', description: '' },
    { code: '180100', description: 'Cocoa beans, whole or broken, raw or roasted' },
  ]);
  check('every code still gets a label', labels.size === 3, `${labels.size}`);
  check('and the empty ones say so rather than going blank', labels.get('999999') === 'Unclassified');
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
