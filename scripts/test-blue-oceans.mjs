/**
 * Checks on who can see a country's blue oceans.
 *   node scripts/test-blue-oceans.mjs
 *
 * This is an access control, so the tests are about the cases where it should
 * say no. A permissions bug does not announce itself: the page still renders,
 * the data still looks right, and the only sign is that somebody saw something
 * they had not paid for or signed up for.
 *
 * The three states are deliberately distinguished throughout:
 *   null   the viewer may not see this
 *   []     they may, and there is nothing uncontested to show
 *   rows   they may, and here it is
 * Collapsing the middle case into the first would tell a paying reader their
 * subscription is not working when in fact the country simply has no openings.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-blue-oceans.mjs';
await build({
  entryPoints: ['worker/lib/blue-oceans.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { canView, loadBlueOceans } = await import(`./../${OUT}`);

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

const VISIBILITIES = ['hidden', 'premium', 'registered'];
const VIEWERS = ['anonymous', 'registered', 'premium'];

console.log('\nSigned-out visitors never see them');
console.log('----------------------------------');
// This is the one rule stated without exception in the request, so it is
// checked against every setting rather than the one that seems relevant.
for (const v of VISIBILITIES) {
  check(`visibility "${v}" is closed to anonymous`, canView(v, 'anonymous') === false);
}

console.log('\nUnpublished means unpublished, including for premium');
console.log('---------------------------------------------------');
// Paying does not grant access to an analysis nobody has reviewed yet.
for (const viewer of VIEWERS) {
  check(`hidden stays hidden from ${viewer}`, canView('hidden', viewer) === false);
}

console.log('\nThe two published settings differ only where they should');
console.log('-------------------------------------------------------');
check('premium-only excludes a free account', canView('premium', 'registered') === false);
check('premium-only admits a premium account', canView('premium', 'premium') === true);
check('registered admits a free account', canView('registered', 'registered') === true);
check('registered admits a premium account', canView('registered', 'premium') === true);

console.log('\nNo combination is accidentally permitted');
console.log('---------------------------------------');
{
  // Enumerated rather than spot-checked: a gate with nine states needs all nine
  // asserted, or the untested one is where the mistake will live.
  const allowed = [];
  for (const v of VISIBILITIES) {
    for (const viewer of VIEWERS) {
      if (canView(v, viewer)) allowed.push(`${v}/${viewer}`);
    }
  }
  const expected = ['premium/premium', 'registered/registered', 'registered/premium'].sort();
  check(
    'exactly three of the nine combinations are open',
    JSON.stringify(allowed.sort()) === JSON.stringify(expected),
    allowed.join(', '),
  );
}

console.log('\nWithheld is not the same as empty');
console.log('---------------------------------');
{
  // A database that would throw if touched. Denial must happen before any read,
  // both because it is cheaper and because a gate that queries first is one
  // query away from returning what it meant to withhold.
  const forbiddenDb = {
    prepare() {
      throw new Error('the gate read the database before deciding');
    },
  };

  const denied = await loadBlueOceans(forbiddenDb, 'GH', 'premium', 'registered');
  check('a denied read returns null, not an empty list', denied.blue_oceans === null);
  check('and says which rule applied', typeof denied.withheld_reason === 'string' && denied.withheld_reason.length > 0, denied.withheld_reason);
  check('and reports the setting it applied', denied.visibility === 'premium');

  const anon = await loadBlueOceans(forbiddenDb, 'GH', 'registered', 'anonymous');
  check('an anonymous reader is told to sign in', /sign in/i.test(anon.withheld_reason ?? ''), anon.withheld_reason);

  const unpublished = await loadBlueOceans(forbiddenDb, 'GH', 'hidden', 'premium');
  check(
    'an unpublished country does not blame the subscription',
    /not been published/i.test(unpublished.withheld_reason ?? ''),
    unpublished.withheld_reason,
  );
}

console.log('\nA permitted read that finds nothing says so plainly');
console.log('--------------------------------------------------');
{
  const emptyDb = {
    prepare: () => ({ bind: () => ({ all: async () => ({ results: [] }) }) }),
  };
  const res = await loadBlueOceans(emptyDb, 'GH', 'registered', 'registered');
  check('returns an empty list, not null', Array.isArray(res.blue_oceans) && res.blue_oceans.length === 0);
  check('and gives no withheld reason', res.withheld_reason === null);
}

console.log('\nOnly genuinely uncontested lines qualify');
console.log('---------------------------------------');
{
  const rows = [
    {
      // Concentrated supply: one partner holds most of it.
      product_code: '87',
      product_name: 'Vehicles',
      trade_flow: 'import',
      opportunity_score: 64,
      signal_type: 'import_substitution',
      score_breakdown_json: '{"import_dependency":0.67}',
      evidence_json: JSON.stringify([
        '2025 value: $3.18 billion (3183935877 USD)',
        '3 year CAGR: 26.9%',
        'top partner: United States at 27.5%',
        'supplier concentration (HHI): 0.16',
      ]),
      limitations_json: '["chapter level only"]',
      data_confidence: 0.8,
    },
    {
      // Same signal, but supply is spread thin across many partners and no one
      // holds a dominant share. Crowded, so not a blue ocean.
      product_code: '10',
      product_name: 'Cereals',
      trade_flow: 'import',
      opportunity_score: 70,
      signal_type: 'import_substitution',
      score_breakdown_json: '{"import_dependency":0.7}',
      evidence_json: JSON.stringify([
        '2025 value: $900 million (900000000 USD)',
        'top partner: India at 12.0%',
        'supplier concentration (HHI): 0.04',
      ]),
      limitations_json: '[]',
      data_confidence: 0.8,
    },
    {
      // Growing, and the country is not the one meeting the demand.
      product_code: '18',
      product_name: 'Cocoa',
      trade_flow: 'export',
      opportunity_score: 80,
      signal_type: 'export_growth',
      score_breakdown_json: '{"import_dependency":0.1}',
      evidence_json: JSON.stringify(['3 year CAGR: 40.0%', '2025 value: $50 million (50000000 USD)']),
      limitations_json: '[]',
      data_confidence: 0.9,
    },
  ];
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
  const res = await loadBlueOceans(db, 'GH', 'registered', 'premium');
  const codes = res.blue_oceans.map((o) => o.product_code);

  check('a concentrated import qualifies', codes.includes('87'));
  check('a growing unserved export qualifies', codes.includes('18'));
  check('a widely supplied import does not', !codes.includes('10'), codes.join(', '));

  const vehicles = res.blue_oceans.find((o) => o.product_code === '87');
  check('the dominant partner is named', vehicles.top_partner === 'United States', vehicles.top_partner);
  check('its share is carried through', vehicles.top_partner_share_pct === 27.5);
  check('concentration is carried through', vehicles.supplier_hhi === 0.16);
  check('the reason names the partner', /United States/.test(vehicles.reason), vehicles.reason);

  // The framing caveat has to travel with the row. A caller that renders only
  // the reason would otherwise present "there is room here" with nothing
  // qualifying it.
  check('every row carries the framing caveat first', res.blue_oceans.every((o) => /Room in the data is not the same as room in the market/.test(o.limitations[0])));
  check('and keeps the analysis\'s own caveats after it', vehicles.limitations.includes('chapter level only'));
}

console.log('\nThe concentration threshold holds on both sides');
console.log('----------------------------------------------');
{
  // 0.15 is the recognised boundary between an unconcentrated and a moderately
  // concentrated market. A threshold with no test either side of it is one
  // nobody is holding to, and this one decides what gets called an opening.
  const at = (hhi) => [
    {
      product_code: '87',
      product_name: 'Vehicles',
      trade_flow: 'import',
      opportunity_score: 64,
      signal_type: 'import_substitution',
      score_breakdown_json: '{}',
      evidence_json: JSON.stringify([
        'top partner: United States at 27.5%',
        `supplier concentration (HHI): ${hhi}`,
      ]),
      limitations_json: '[]',
      data_confidence: 0.8,
    },
  ];
  const run = async (hhi) => {
    const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: at(hhi) }) }) }) };
    const r = await loadBlueOceans(db, 'GH', 'registered', 'premium');
    return r.blue_oceans.length;
  };
  check('just below the boundary does not qualify', (await run(0.149)) === 0);
  check('exactly at the boundary qualifies', (await run(0.15)) === 1);
  check('well above the boundary qualifies', (await run(0.4)) === 1);
}

console.log('\nA concentrated market with no nameable lead is not claimed');
console.log('---------------------------------------------------------');
{
  // Without a partner to point at there is no finding to state, only a number.
  const rows = [
    {
      product_code: '87',
      product_name: 'Vehicles',
      trade_flow: 'import',
      opportunity_score: 64,
      signal_type: 'import_substitution',
      score_breakdown_json: '{}',
      evidence_json: JSON.stringify(['supplier concentration (HHI): 0.3']),
      limitations_json: '[]',
      data_confidence: 0.8,
    },
  ];
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
  const res = await loadBlueOceans(db, 'GH', 'registered', 'premium');
  check('no partner recorded means no claim made', res.blue_oceans.length === 0);
}

console.log('\nAn unknown figure stays unknown');
console.log('-------------------------------');
{
  // Missing concentration must not read as zero. Zero HHI means perfectly open
  // supply, which is the opposite of "we do not know".
  const rows = [
    {
      product_code: '99',
      product_name: 'Unknown',
      trade_flow: 'export',
      opportunity_score: 70,
      signal_type: 'export_growth',
      score_breakdown_json: '{"import_dependency":0.1}',
      evidence_json: JSON.stringify(['3 year CAGR: 12.0%']),
      limitations_json: '[]',
      data_confidence: null,
    },
  ];
  const db = { prepare: () => ({ bind: () => ({ all: async () => ({ results: rows }) }) }) };
  const res = await loadBlueOceans(db, 'GH', 'registered', 'registered');
  const row = res.blue_oceans[0];
  check('an absent HHI is null, not 0', row.supplier_hhi === null, String(row.supplier_hhi));
  check('an absent partner is null, not empty string', row.top_partner === null);
  check('an absent value is null, not 0', row.value_usd === null, String(row.value_usd));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
