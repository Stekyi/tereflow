/**
 * Checks on the social post generator.
 *   node scripts/test-social.mjs
 *
 * These posts go to strangers under Ananse News's name. Every check here is a
 * way a generated sentence could be false or embarrassing while still looking
 * like a normal post.
 *
 * The one that matters most: the stored "best market" is often the country's
 * largest partner across ALL exports, not the buyer of the product in the post.
 * Naming it as the buyer would invent a trade relationship and publish it.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-social-test.mjs';
await build({
  entryPoints: ['worker/agent/social.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { buildSocialPost, tidyProductName, isoWeek, isPublishableLink, isResidualCategory } = await import(`./../${OUT}`);

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

let n = 0;
function signal(over = {}) {
  return {
    id: `sig_${n++}`,
    hs_code: '071360',
    product_name: 'Vegetables, leguminous; pigeon peas (Cajanus cajan), shelled, whether or not skinned or split, dried',
    flow: 'export',
    cagr_3y: 137,
    momentum: 0.86,
    current_rank: 13,
    projected_rank: 1,
    horizon_years: 4,
    confidence: 0.72,
    rationale: 'test',
    value_usd: 60_884_466,
    share: 0.0074,
    year: 2024,
    best_market: 'Uganda',
    best_market_iso3: 'UGA',
    best_market_product_specific: false,
    ...over,
  };
}

function post(signals, over = {}) {
  return buildSocialPost({
    countryName: 'Kenya',
    countrySlug: 'kenya',
    signals,
    siteBase: 'https://tereflow.example',
    year: 2024,
    ...over,
  });
}

console.log('\nWhat it refuses to say');
console.log('----------------------');

{
  // The single most dangerous sentence this could produce.
  const p = post([signal({ best_market_product_specific: false })]);
  check('does not name a buyer when the market is not product specific',
    !/largest buyer/i.test(p.caption), p.caption.match(/.*buyer.*/i)?.[0] ?? 'no buyer sentence');
  check('and says why it was left out', p.omitted.some((o) => /largest export partner overall/i.test(o)),
    JSON.stringify(p.omitted));
  check('the partner name appears nowhere in the caption', !p.caption.includes('Uganda'), p.caption.slice(0, 200));
}

{
  const p = post([signal({ best_market_product_specific: true })]);
  check('names the buyer when the data really is about this product',
    /largest buyer of it is Uganda/i.test(p.caption), p.caption.match(/.*buyer.*/i)?.[0] ?? '(none)');
}

{
  // 900% growth on a tiny base is arithmetically true and says nothing.
  const p = post([signal({ value_usd: 400_000, cagr_3y: 900 })]);
  check('refuses a product too small to matter', p === null, p ? p.title : 'null');
}

{
  const p = post([signal({ confidence: 0.3 })]);
  check('refuses a projection it does not believe', p === null, p ? p.title : 'null');
}

{
  const p = post([signal({ cagr_3y: 4000 })]);
  check('refuses a growth figure that reads as an error', p === null, p ? p.title : 'null');
}

{
  const p = post([signal({ cagr_3y: null })]);
  check('refuses when growth is unknown', p === null);
}

{
  const p = post([signal({ flow: 'import' })]);
  check('does not post an import as an export story', p === null);
}

{
  check('a country with no signals produces nothing', post([]) === null);
}

{
  // Silence is a valid outcome. Filler to keep a schedule teaches people to
  // scroll past the account.
  const p = post([signal({ value_usd: 1000 }), signal({ confidence: 0.1 })]);
  check('when nothing qualifies it stays quiet rather than reaching', p === null);
}

console.log('\nWhat it does say');
console.log('----------------');

{
  const p = post([signal({ best_market_product_specific: true })]);
  check('title carries country, product and growth',
    /Kenya/.test(p.title) && /pigeon peas/i.test(p.title) && /137%/.test(p.title), p.title);
  check('caption states the value with its year', /\$61 million/.test(p.caption) && /2024/.test(p.caption),
    p.caption.split('\n')[2]);
  check('caption states the rank movement', /number 13/.test(p.caption) && /number 1/.test(p.caption));
  check('caption links to the country page', p.caption.includes('https://tereflow.example/country/kenya'));
  check('evidence lists what each claim came from', p.evidence.length >= 3, JSON.stringify(p.evidence));
}

{
  const p = post([signal({ confidence: 0.55, best_market_product_specific: true })]);
  check('low confidence is stated in the post itself',
    /treat the direction as the finding/i.test(p.caption), 'hedge present');
}

{
  const p = post([signal({ confidence: 0.95, best_market_product_specific: true })]);
  check('high confidence does not add the hedge', !/treat the direction/i.test(p.caption));
}

{
  const p = post([signal({ current_rank: 13, projected_rank: null, best_market_product_specific: true })]);
  check('no projected rank means no forecast sentence', !/On the current trend/i.test(p.caption));
  check('and the omission is recorded', p.omitted.some((o) => /projected rank/i.test(o)), JSON.stringify(p.omitted));
}

{
  const strong = signal({ momentum: 0.9, product_name: 'Coffee; not roasted', best_market_product_specific: true });
  const weak = signal({ momentum: 0.3, product_name: 'Tea; green' });
  const p = post([weak, strong]);
  check('picks the strongest signal, not the first', /Coffee/i.test(p.title), p.title);
}

console.log('\nReadability');
console.log('-----------');

check('customs description becomes something a person reads',
  tidyProductName('Vegetables, leguminous; pigeon peas (Cajanus cajan), shelled, whether or not skinned or split, dried') === 'Pigeon peas, shelled',
  tidyProductName('Vegetables, leguminous; pigeon peas (Cajanus cajan), shelled, whether or not skinned or split, dried'));

check('the semicolon inversion is unwound',
  tidyProductName('Metals; gold, semi-manufactured') === 'Gold, semi-manufactured',
  tidyProductName('Metals; gold, semi-manufactured'));

check('a plain name is left alone',
  tidyProductName('Cocoa beans') === 'Cocoa beans', tidyProductName('Cocoa beans'));

check('a qualifier tail keeps the product it qualifies',
  tidyProductName('Coffee; not roasted') === 'Coffee, not roasted',
  tidyProductName('Coffee; not roasted'));

check('so does a one-word qualifier',
  tidyProductName('Fish; live') === 'Fish, live', tidyProductName('Fish; live'));

check('a tail that names a thing still wins',
  tidyProductName('Vegetables; tomatoes, fresh') === 'Tomatoes, fresh',
  tidyProductName('Vegetables; tomatoes, fresh'));

{
  const p = post([signal({ best_market_product_specific: true })]);
  check('caption fits a social post', p.caption.length < 1200, `${p.caption.length} chars`);
  check('title fits a headline', p.title.length <= 200, `${p.title.length} chars`);
  check('hashtags are few, not a wall', (p.caption.match(/#/g) || []).length <= 5,
    `${(p.caption.match(/#/g) || []).length} tags`);
}

console.log('\nPosting the same thing twice');
console.log('----------------------------');

{
  const a = post([signal({ best_market_product_specific: true })]);
  const b = post([signal({ best_market_product_specific: true })]);
  check('the dedupe key is stable within a week', a.dedupeKey === b.dedupeKey, a.dedupeKey);
  check('it names the country, so two countries do not collide',
    a.dedupeKey.includes('kenya'), a.dedupeKey);
  const other = post([signal({ best_market_product_specific: true })], { countrySlug: 'ghana', countryName: 'Ghana' });
  check('a different country gets a different key', a.dedupeKey !== other.dedupeKey, `${a.dedupeKey} vs ${other.dedupeKey}`);
}

{
  // A retry an hour later, or a Friday job that slips past midnight, must not
  // produce a second post for the same week.
  check('ISO week is stable across a day', isoWeek(new Date('2026-09-09T02:00:00Z')) === isoWeek(new Date('2026-09-09T23:00:00Z')));
  check('ISO week rolls over between weeks',
    isoWeek(new Date('2026-09-09T00:00:00Z')) !== isoWeek(new Date('2026-09-17T00:00:00Z')));
  check('ISO week format is sortable', /^\d{4}-W\d{2}$/.test(isoWeek(new Date())), isoWeek(new Date()));
}

console.log('\nRefusing to publish a link nobody can open');
console.log('------------------------------------------');

{
  const cases = [
    ['http://127.0.0.1:8787/country/kenya', false, 'loopback'],
    ['http://localhost:5173/country/kenya', false, 'localhost'],
    ['https://192.168.1.5/country/kenya', false, 'private network'],
    ['https://10.0.0.4/x', false, 'private network'],
    ['https://tereflow.local/x', false, 'mdns name'],
    ['http://tereflow.example/x', false, 'not https'],
    ['not a url', false, 'malformed'],
    ['https://tereflow.example/country/kenya', true, 'real public https'],
  ];
  for (const [url, want, why] of cases) {
    const r = isPublishableLink(url);
    check(`${want ? 'allows' : 'refuses'} ${why}`, r.ok === want, `${url} -> ${JSON.stringify(r)}`);
  }
  check('the refusal says what to do about it',
    /PUBLIC_SITE_URL/.test(isPublishableLink('http://127.0.0.1:8787/x').reason ?? ''),
    isPublishableLink('http://127.0.0.1:8787/x').reason);
}

console.log('\nA reviewer can see what was shortened');
console.log('-------------------------------------');

{
  const p = post([signal({ best_market_product_specific: true })]);
  check('the post carries the original tariff description',
    p.productRaw.includes('Cajanus cajan'), p.productRaw.slice(0, 60));
  check('and the readable label beside it', p.productLabel === 'Pigeon peas, shelled', p.productLabel);
}

{
  // The case that produced "Light, fire-floats" from a signal about vessels.
  const raw = 'Vessels; light, fire-floats, floating cranes and other vessels, the navigability of which is subsidiary to their main function, floating docks';
  check('an adjective tail no longer eats the noun',
    tidyProductName(raw).toLowerCase().startsWith('vessels'), tidyProductName(raw));
}

console.log('\nResidual tariff lines are not products');
console.log('--------------------------------------');

{
  const residuals = [
    'Food preparations; n.e.c. in item no. 2106.10',
    'Machinery; parts, n.e.s.',
    'Other articles of plastics',
    'Chemicals not elsewhere classified',
    'Textiles; n.e.c in heading no. 6307',
  ];
  for (const r of residuals) {
    check(`refuses "${r.slice(0, 40)}"`, isResidualCategory(r) === true, String(isResidualCategory(r)));
  }
  const real = ['Cocoa beans', 'Pigeon peas, shelled', 'Gold, semi-manufactured', 'Tugs and pusher craft'];
  for (const r of real) {
    check(`allows "${r}"`, isResidualCategory(r) === false, String(isResidualCategory(r)));
  }
}

{
  // The signal that produced a headline about a tariff line number.
  const p = post([signal({ product_name: 'Food preparations; n.e.c. in item no. 2106.10' })]);
  check('a residual signal produces no post at all', p === null, p ? p.title : 'null');
}

{
  const good = signal({ product_name: 'Cocoa beans', momentum: 0.5, best_market_product_specific: true });
  const residual = signal({ product_name: 'Other articles of plastics', momentum: 0.99 });
  const p = post([residual, good]);
  check('a stronger residual does not beat a weaker real product', /Cocoa/i.test(p.title), p.title);
}

{
  // The call to action must not promise something the page cannot show.
  const without = post([signal({ best_market_product_specific: false })]);
  check('no buyer data means the post does not promise a buyer',
    !/who buys it/i.test(without.caption), without.caption.split('\n').filter((l) => l.includes('http'))[0]);
  const withIt = post([signal({ best_market_product_specific: true })]);
  check('buyer data present means it does promise one',
    /who buys it/i.test(withIt.caption), withIt.caption.split('\n').filter((l) => l.includes('http'))[0]);
  check('either way the link is there', without.caption.includes('/country/kenya'));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
