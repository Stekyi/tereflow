/**
 * Checks on working out a country config from its PXWeb metadata.
 *   node scripts/test-discover.mjs
 *
 * The bar is Ghana. That config was built by hand over a day, so if discovery
 * cannot reproduce it from the same endpoint's metadata, it is not doing the
 * job it exists for. Every assertion below compares against the hand-built
 * GHANA config rather than against what the code happens to return.
 *
 * The metadata here is Ghana's real response, captured verbatim. It breaks
 * three assumptions that sound reasonable in the abstract, and each one is
 * tested explicitly because each would have produced wrong numbers rather than
 * an error:
 *
 *   - No variable carries PXWeb's `time: true` flag, including Year.
 *   - The valuation dimension has four values, not two.
 *   - The flow dimension has three, and the extra one is the sum of the others.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-discover.mjs';
await build({
  entryPoints: ['scripts/entry-discover.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { analyseMetadata, discoverDimensions, matchPartner, dominanceCandidates, GHANA } =
  await import(`./../${OUT}`);

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

/** Ghana's live metadata, as returned on 13 September 2026. */
const GHANA_META = {
  title:
    'International Merchandise Trade - by Year, Month, Tradeflow, 2-digit HS code, and Partner Country',
  variables: [
    {
      code: 'Valuation_Parameter',
      text: 'Valuation_Parameter',
      values: ['a', 'b', 'c', 'd'],
      valueTexts: [
        'Value in Ghana Cedis (nominal)',
        'Value in Ghana Cedis (real)',
        'Value in US Dollars',
        'Net weight in KG',
      ],
    },
    {
      code: 'Tradeflow',
      text: 'Tradeflow',
      values: ['t', 'e', 'i'],
      valueTexts: ['Total Trade', 'Export', 'Import'],
      elimination: true,
    },
    {
      code: 'Year',
      text: 'Year',
      values: ['2021', '2022', '2023', '2024', '2025'],
      valueTexts: ['2021', '2022', '2023', '2024', '2025'],
    },
    {
      code: 'Month',
      text: 'Month',
      values: Array.from({ length: 13 }, (_, i) => String(i)),
      valueTexts: [
        'All Months', 'January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December',
      ],
      elimination: true,
    },
    {
      code: 'HS_2_digit',
      text: 'HS_2_digit',
      values: ['all', '01', '02', '03', '07', '18', '27', '71', '87'],
      valueTexts: [
        'All Products',
        '01 - Live animals',
        '02 - Meat and edible meat offal',
        '03 - Fish and crustaceans',
        '07 - Edible vegetables',
        '18 - Cocoa and cocoa preparations',
        '27 - Mineral fuels and oils',
        '71 - Pearls, precious stones and metals',
        '87 - Vehicles other than railway',
      ],
      elimination: true,
    },
    {
      code: 'Partner_Country',
      text: 'Partner_Country',
      values: Array.from({ length: 26 }, (_, i) => String(i)),
      valueTexts: [
        'All Partner Countries',
        'Afghanistan', 'Albania', 'Algeria', 'Angola', 'Argentina', 'Australia',
        'Belgium', 'Brazil', 'Canada', 'China', 'Egypt', 'France', 'Germany',
        'India', 'Italy', 'Japan', 'Netherlands', 'Nigeria', 'South Africa',
        'Spain', 'Turkey', 'United Kingdom', 'United States', 'Viet Nam',
        'Zambia',
      ],
      elimination: true,
    },
  ],
};

const result = analyseMetadata(GHANA.provider.endpoint, GHANA_META);
const byRole = (role) => result.dimensions.find((d) => d.role === role);
const pickOf = (role, key) => byRole(role)?.picked.find((p) => p.key === key)?.value ?? null;

console.log('\nDiscovery reproduces the config that was built by hand');
console.log('-----------------------------------------------------');
// Ghana's config took a day to assemble. Matching it from metadata is the
// entire point; anything less and the feature has not replaced the work.
{
  const d = GHANA.provider.dimensions;
  check('valuation dimension', byRole('valuation')?.code === d.valuation, byRole('valuation')?.code);
  check('flow dimension', byRole('flow')?.code === d.flow, byRole('flow')?.code);
  check('year dimension', byRole('year')?.code === d.year, byRole('year')?.code);
  check('month dimension', byRole('month')?.code === d.month, byRole('month')?.code);
  check('product dimension', byRole('product')?.code === d.product, byRole('product')?.code);
  check('partner dimension', byRole('partner')?.code === d.partner, byRole('partner')?.code);
}

console.log('\nAnd the individual values inside them');
console.log('------------------------------------');
{
  const v = GHANA.provider.values;
  check('value in US dollars', pickOf('valuation', 'value_usd') === v.value_usd, pickOf('valuation', 'value_usd'));
  check('net weight in KG', pickOf('valuation', 'weight_kg') === v.weight_kg, pickOf('valuation', 'weight_kg'));
  check('import', pickOf('flow', 'flow_import') === v.flow_import, pickOf('flow', 'flow_import'));
  check('export', pickOf('flow', 'flow_export') === v.flow_export, pickOf('flow', 'flow_export'));
  check('all months', pickOf('month', 'all_months') === v.all_months, pickOf('month', 'all_months'));
  check('all products', pickOf('product', 'all_products') === v.all_products, pickOf('product', 'all_products'));
  check('all partners', pickOf('partner', 'all_partners') === v.all_partners, pickOf('partner', 'all_partners'));
  check('years', JSON.stringify(result.years) === JSON.stringify(GHANA.years), result.years.join(','));
  check('classification level', result.classification_level === GHANA.classification.level, result.classification_level);
}

console.log('\nThe time flag is used when present and not relied on when absent');
console.log('---------------------------------------------------------------');
// PXWeb can mark its time variable. Ghana marks nothing, including Year, so a
// discovery that trusted the flag alone would find no year dimension on the
// endpoint it was written against.
{
  check('no variable in the real metadata sets it', GHANA_META.variables.every((v) => v.time !== true));
  check('year is still found', byRole('year') != null);
  check('and says it was read from the values', /time flag/i.test(byRole('year')?.reason ?? ''), byRole('year')?.reason);

  const flagged = analyseMetadata('x', {
    title: 't',
    variables: [
      { code: 'Period', text: 'Period', values: ['1'], valueTexts: ['2024'], time: true },
      ...GHANA_META.variables.filter((v) => v.code !== 'Year'),
    ],
  });
  const y = flagged.dimensions.find((d) => d.role === 'year');
  check('a flagged variable is taken as certain', y?.code === 'Period' && y?.certainty === 'certain', `${y?.code}/${y?.certainty}`);
  check('and says the metadata declared it', /marks this variable/i.test(y?.reason ?? ''), y?.reason);
}

console.log('\nFour valuation values, not two');
console.log('------------------------------');
// Ghana offers cedis nominal, cedis real, US dollars and net weight. A rule
// keyed on "two values, one money one weight" finds nothing here.
{
  check('the dimension has four values', byRole('valuation')?.value_count === 4);
  check('dollars are chosen over cedis', pickOf('valuation', 'value_usd') === 'Value in US Dollars');
  // A local-currency series cannot be compared across countries and nothing
  // downstream converts it, so picking cedis would produce a dataset that looks
  // fine and cannot be read alongside any other country.
  check('not a cedi series', !/cedis/i.test(pickOf('valuation', 'value_usd') ?? ''));
}

console.log('\nThe aggregate values are found so they can be avoided');
console.log('----------------------------------------------------');
// "Total Trade" is Export plus Import. Requesting it alongside them doubles
// every figure in the dataset, and the result looks plausible because it is
// exactly twice the truth.
{
  const avoid = pickOf('flow', 'aggregate_to_avoid');
  check('the flow total is identified', avoid === 'Total Trade', avoid);
  const reason = byRole('flow')?.picked.find((p) => p.key === 'aggregate_to_avoid')?.reason ?? '';
  check('and why it must not be requested is stated', /doubl/i.test(reason), reason.slice(0, 60));

  check('neither flow pick is the aggregate',
    pickOf('flow', 'flow_import') !== 'Total Trade' && pickOf('flow', 'flow_export') !== 'Total Trade');
  check('the product aggregate is not counted as a product',
    !byRole('product')?.sample_values.every((s) => /^All/.test(s)));
}

console.log('\nPartner names are matched, and the doubtful ones say so');
console.log('------------------------------------------------------');
{
  check('exact names are certain', matchPartner('Germany')?.certainty === 'certain');
  check('and resolve correctly', matchPartner('Germany')?.iso3 === 'DEU');

  // "Viet Nam" to "Vietnam" is a spacing difference; "Ivory Coast" to
  // "Cote d'Ivoire" is a different set of words for the same place. Neither is
  // reachable by string distance, so both are listed.
  check('a known alternative spelling resolves', matchPartner('Viet Nam')?.iso3 === 'VNM');
  check('and is reported as certain, not guessed', matchPartner('Viet Nam')?.certainty === 'certain');
  check('a different name for the same place resolves', matchPartner('Ivory Coast')?.iso3 === 'CIV');

  check('nonsense matches nothing', matchPartner('Free Zone Enclave') === null);
  check('and an empty name matches nothing', matchPartner('   ') === null);

  // The failure mode is attributing one country's trade to another, which is
  // invisible in every downstream number, so near-misses are never silent.
  const near = matchPartner('Guine');
  if (near) {
    check('a near miss is not called certain', near.certainty !== 'certain', `${near.app_name}/${near.certainty}`);
    check('and carries a reason to check it', near.reason.length > 10);
  } else {
    check('a near miss with no clear answer returns nothing', true);
  }
}

console.log('\nEvery matched partner carries the source spelling');
console.log('------------------------------------------------');
{
  const vn = result.partners.find((p) => p.iso3 === 'VNM');
  check('Viet Nam was matched', vn != null);
  // source_name is what the request has to send. Losing it means every request
  // for that partner returns nothing, which reads as "no trade" rather than as
  // an error.
  check('and kept the source spelling', vn?.source_name === 'Viet Nam', vn?.source_name);
  // app_name comes from the canonical list, not from whoever built the config.
  // ISO3_NAME says "Viet Nam"; Ghana's hand-built entry says "Vietnam". The
  // hand-built one is the drift, and country-names.ts exists precisely so there
  // is one list rather than two that disagree.
  check('and the display name comes from the canonical list', vn?.app_name === 'Viet Nam', vn?.app_name);
  check('every partner has a source name', result.partners.every((p) => p.source_name.length > 0));
  check('every partner has an iso3', result.partners.every((p) => /^[A-Z]{3}$/.test(p.iso3)));
}

console.log('\nUnmatched partners are named, never dropped quietly');
console.log('--------------------------------------------------');
{
  const meta = JSON.parse(JSON.stringify(GHANA_META));
  meta.variables.find((v) => v.code === 'Partner_Country').valueTexts.push('Free Zone Enclave', 'Ships Stores');
  const r = analyseMetadata('x', meta);
  check('they are listed', r.unmatched_partners.includes('Free Zone Enclave'));
  check('and counted in a warning', r.warnings.some((w) => /could not be matched/.test(w.message)));
  check('which says their trade is excluded',
    r.warnings.some((w) => /excluded until/.test(w.message)),
    r.warnings.map((w) => w.message).join(' | ').slice(0, 80));
}

console.log('\nTwo source names for one country is refused, not merged');
console.log('------------------------------------------------------');
{
  // Keeping both would count that country's trade twice, and the total would
  // still look like a total.
  const meta = JSON.parse(JSON.stringify(GHANA_META));
  meta.variables.find((v) => v.code === 'Partner_Country').valueTexts.push('United States of America');
  const r = analyseMetadata('x', meta);
  const usa = r.partners.filter((p) => p.iso3 === 'USA');
  check('only one survives', usa.length === 1, `${usa.length}`);
  check('and the clash is raised', r.warnings.some((w) => /count that country's trade twice/.test(w.message)));
}

console.log('\nA depth mix is flagged rather than averaged');
console.log('------------------------------------------');
{
  // Requesting a chapter and its own children together counts the same trade
  // twice. Picking "the finest" silently would hide that.
  const meta = JSON.parse(JSON.stringify(GHANA_META));
  meta.variables.find((v) => v.code === 'HS_2_digit').valueTexts.push('070200 - Tomatoes, fresh');
  const r = analyseMetadata('x', meta);
  const prod = r.dimensions.find((d) => d.role === 'product');
  check('the mix is noticed', prod?.certainty === 'uncertain', prod?.certainty);
  check('and explained as double counting', /twice/.test(prod?.reason ?? ''), prod?.reason);
  check('the finest level is reported', r.classification_level === 'HS6', r.classification_level);
}

console.log('\nA missing role blocks rather than proceeds');
console.log('-----------------------------------------');
{
  const meta = {
    title: 'incomplete',
    variables: GHANA_META.variables.filter((v) => v.code !== 'Partner_Country'),
  };
  const r = analyseMetadata('x', meta);
  check('not ready to confirm', r.ready_to_confirm === false);
  check('and says which role is missing',
    r.warnings.some((w) => w.severity === 'blocking' && /partner/.test(w.message)),
    r.warnings.filter((w) => w.severity === 'blocking').map((w) => w.message).join(' | '));
}

console.log('\nA complete endpoint is ready, and a clean one has nothing to check');
console.log('-----------------------------------------------------------------');
{
  check('Ghana is ready to confirm', result.ready_to_confirm === true,
    result.warnings.map((w) => `${w.severity}: ${w.message}`).join(' | '));
  check('with no blocking warnings', !result.warnings.some((w) => w.severity === 'blocking'));
}

console.log('\nDominance points at candidates without acting on them');
console.log('----------------------------------------------------');
{
  // Nothing in trade data says "traditional export". What it can say is that
  // one chapter is a fifth of everything, which is the shape Ghana's cocoa,
  // gold and oil all have.
  const totals = [
    { product_code: '71', product_description: 'Pearls and precious metals', value_usd: 20e9 },
    { product_code: '27', product_description: 'Mineral fuels', value_usd: 8e9 },
    { product_code: '87', product_description: 'Vehicles', value_usd: 3e9 },
    { product_code: '34', product_description: 'Soap', value_usd: 0.2e9 },
  ];
  const c = dominanceCandidates(totals, 12);
  check('the dominant chapters are flagged', c.map((x) => x.product_code).join(',') === '71,27', c.map((x) => x.product_code).join(','));
  check('small chapters are not', !c.some((x) => x.product_code === '34'));
  check('each carries its share', c[0].share_pct > 60, c[0].share_pct.toFixed(1));
  check('and a reason an admin can act on', /Confirm and give the reason/.test(c[0].reason));
  check('ordered largest first', c[0].share_pct >= c[1].share_pct);

  const none = dominanceCandidates(totals, 99);
  check('a high threshold flags nothing', none.length === 0);
  check('and an empty input does not divide by zero', dominanceCandidates([], 12).length === 0);
}

console.log('\nDiscovery is deterministic');
console.log('--------------------------');
{
  // Same metadata in, same proposal out. A config that varies between runs
  // cannot be reviewed, because what was confirmed is not what gets saved.
  const a = analyseMetadata('x', GHANA_META);
  const b = analyseMetadata('x', GHANA_META);
  check('repeated analysis matches exactly', JSON.stringify(a) === JSON.stringify(b));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
