/**
 * Checks on product family grouping.
 *   node scripts/test-families.mjs
 *
 * The tariff splits one trade into lines that differ by a detail: Ghana's motor
 * car imports are fourteen codes under 8703, separated by engine size and fuel.
 * Grouping them makes a chart readable. It also creates two ways to mislead,
 * and most of what follows is about those.
 *
 * FIRST: a family total computed from the ranked list is not a family total.
 * Only four of the fourteen vehicle lines make Ghana's top twelve. Summing
 * those gives about $1,079m and presenting it as the family hides $573m behind
 * a number that reads as complete. The grouping therefore runs over every line,
 * and these tests assert it.
 *
 * SECOND: the same table holds the same trade at three levels. A country total,
 * ninety-odd chapter rows, and the HS6 lines. Summing across them triple counts,
 * which is how a $20.17bn trade first came out of this code as $54.12bn. The
 * levels are kept apart and the gap between them is stated rather than hidden.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-families.mjs';
await build({
  entryPoints: ['worker/lib/product-families.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { loadProductFamilies } = await import(`./../${OUT}`);

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

/**
 * A database holding the same trade at all three levels, as the real one does.
 * Routes each query by what it asks for, so a test that accidentally reads the
 * wrong level fails rather than quietly summing them.
 */
function dbOf({ hs6 = [], hs2 = [], year = 2025 } = {}) {
  return {
    prepare(sql) {
      return {
        bind: () => ({
          first: async () => (/MAX\(year\)/.test(sql) ? { year } : { total: hs2.reduce((a, r) => a + r.value_usd, 0) || null }),
          all: async () => ({ results: hs6 }),
        }),
      };
    },
  };
}

const line = (hs_code, value_usd, product_name) => ({ hs_code, product_name, value_usd });

const VEHICLES = [
  line('870321', 108_600_000, 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity not over 1000cc'),
  line('870322', 299_800_000, 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 1000 but not over 1500cc'),
  line('870323', 837_000_000, 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 1500 but not over 3000cc'),
  line('870324', 214_200_000, 'Vehicles; with only spark-ignition internal combustion reciprocating piston engine, cylinder capacity over 3000cc'),
  line('870390', 193_000_000, 'Vehicles; with only electric motor for propulsion'),
];

console.log('\nA family total is the whole family');
console.log('----------------------------------');
{
  const res = await loadProductFamilies(dbOf({ hs6: VEHICLES }), 'ent_ghana', 'import');
  const f = res.families.find((x) => x.code === '8703');
  const expected = VEHICLES.reduce((a, l) => a + l.value_usd, 0);
  check('every line is counted, not just the ranked ones', f.value_usd === expected, `${f.value_usd} vs ${expected}`);
  check('and the count of lines is stated', f.line_count === 5, String(f.line_count));
  check('no member is dropped', f.members.length === 5);
  // If this ever regresses to grouping the ranked list, the total falls and
  // the line count falls with it, and both are asserted.
}

console.log('\nMembers are ordered and their shares are of the family');
console.log('-----------------------------------------------------');
{
  const res = await loadProductFamilies(dbOf({ hs6: VEHICLES }), 'ent_ghana', 'import');
  const f = res.families.find((x) => x.code === '8703');
  check('largest first', f.members[0].code === '870323', f.members[0].code);
  const sum = f.members.reduce((a, m) => a + m.share_of_family_pct, 0);
  check('member shares add to 100 of the family', Math.abs(sum - 100) < 0.01, sum.toFixed(4));
}

console.log('\nFamily share and member share have different denominators');
console.log('--------------------------------------------------------');
{
  // share_of_family_pct is named that way because 51% means "half the
  // vehicles", not "half of what the country imports". With other families
  // present the two diverge, and that divergence is the point.
  const res = await loadProductFamilies(
    dbOf({
      hs6: [...VEHICLES, line('271019', 4_000_000_000, 'Petroleum oils; not crude, not light oils')],
    }),
    'ent_ghana',
    'import',
  );
  const f = res.families.find((x) => x.code === '8703');
  check('the biggest member is most of its family', f.members[0].share_of_family_pct > 50, f.members[0].share_of_family_pct.toFixed(1));
  check('but the family is a minority of the trade', f.share_pct < 50, f.share_pct.toFixed(1));
  check('so the two are not the same number', Math.abs(f.members[0].share_of_family_pct - f.share_pct) > 10);
}

console.log('\nThe three classification levels are never summed together');
console.log('--------------------------------------------------------');
{
  // The real table holds a country total, chapter rows and HS6 rows, all
  // describing the same trade. Adding them gave $54.12bn for a $20.17bn trade.
  const res = await loadProductFamilies(
    dbOf({
      hs6: VEHICLES,
      hs2: [line('87', 3_183_000_000, 'Vehicles'), line('27', 4_040_000_000, 'Mineral fuels')],
    }),
    'ent_ghana',
    'import',
  );
  const hs6Total = VEHICLES.reduce((a, l) => a + l.value_usd, 0);
  check('the family total counts HS6 only', res.total_usd === hs6Total, `${res.total_usd} vs ${hs6Total}`);
  check('the country total comes from the chapter rows', res.country_total_usd === 7_223_000_000, String(res.country_total_usd));
  check('the two are not added to each other', res.total_usd < res.country_total_usd);
}

console.log('\nThe gap between the levels is stated, not hidden');
console.log('-----------------------------------------------');
{
  const res = await loadProductFamilies(
    dbOf({ hs6: VEHICLES, hs2: [line('87', 5_000_000_000, 'Vehicles')] }),
    'ent_ghana',
    'import',
  );
  check('a material shortfall produces a note', typeof res.coverage_note === 'string', res.coverage_note);
  check('the note gives both figures', /\$1\.65bn of the \$5\.00bn/.test(res.coverage_note ?? ''), res.coverage_note);
  check(
    'and says the shares are of the detailed portion',
    /shares here are of the detailed portion/.test(res.coverage_note ?? ''),
  );
}

console.log('\nNo note where there is nothing to explain');
console.log('----------------------------------------');
{
  // A country filing everything at HS6 needs no caveat, and printing one anyway
  // trains the reader to skip it for the countries where it matters.
  const hs6Total = VEHICLES.reduce((a, l) => a + l.value_usd, 0);
  const res = await loadProductFamilies(
    dbOf({ hs6: VEHICLES, hs2: [line('87', hs6Total, 'Vehicles')] }),
    'ent_ghana',
    'import',
  );
  check('no coverage note when the levels agree', res.coverage_note === null, res.coverage_note ?? 'null');
}

console.log('\nTwo families never share a name');
console.log('-------------------------------');
{
  // 8703 and 8704 both begin "Vehicles;" and everything separating them sits
  // after the semicolon, so both derived to "Vehicles" and the grouping
  // recreated the collision it exists to remove.
  const res = await loadProductFamilies(
    dbOf({
      hs6: [
        ...VEHICLES,
        line('870410', 400_000_000, 'Vehicles; dumpers, designed for off-highway use'),
        line('870421', 452_000_000, 'Vehicles; compression-ignition internal combustion piston engine, gvw not over 5 tonnes'),
      ],
    }),
    'ent_ghana',
    'import',
  );
  const names = res.families.map((f) => f.name);
  check('names are distinct', new Set(names).size === names.length, names.join(' | '));
  check('and none is bare "Vehicles"', !names.includes('Vehicles'), names.join(' | '));
}

console.log('\nMembers within a family are told apart too');
console.log('-----------------------------------------');
{
  const res = await loadProductFamilies(dbOf({ hs6: VEHICLES }), 'ent_ghana', 'import');
  const f = res.families.find((x) => x.code === '8703');
  const names = f.members.map((m) => m.name);
  check('every member has its own label', new Set(names).size === names.length, names.join(' | '));
  check('the engine band is what separates them', names.filter((n) => /cc\)/.test(n)).length >= 4, names[0]);
  // Members of one family are by construction the lines most likely to collide:
  // they share a heading and differ only in the tail.
}

console.log('\nA single-line heading is not dressed up as a group');
console.log('-------------------------------------------------');
{
  const res = await loadProductFamilies(
    dbOf({ hs6: [line('270900', 460_000_000, 'Petroleum oils and oils obtained from bituminous minerals; crude')] }),
    'ent_ghana',
    'import',
  );
  const f = res.families[0];
  check('line_count is 1', f.line_count === 1);
  check('and it keeps its own name', /Petroleum oils/.test(f.name), f.name);
}

console.log('\nNothing filed is null, not an empty chart');
console.log('----------------------------------------');
{
  const res = await loadProductFamilies(dbOf({ hs6: [] }), 'ent_ghana', 'import');
  check('returns null when there are no lines', res === null);

  const noYear = await loadProductFamilies(dbOf({ hs6: VEHICLES, year: null }), 'ent_ghana', 'import');
  check('and when no year has been filed', noYear === null);
}

console.log('\nCountry shares add up across the families');
console.log('----------------------------------------');
{
  const res = await loadProductFamilies(
    dbOf({
      hs6: [
        ...VEHICLES,
        line('271019', 2_678_000_000, 'Petroleum oils; not crude, not light oils'),
        line('252310', 408_000_000, 'Cement clinkers'),
      ],
    }),
    'ent_ghana',
    'import',
  );
  const sum = res.families.reduce((a, f) => a + f.share_pct, 0);
  check('shares of the detailed total add to 100', Math.abs(sum - 100) < 0.01, sum.toFixed(4));
  check('and the families are ranked by value', res.families[0].value_usd >= res.families[1].value_usd);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
