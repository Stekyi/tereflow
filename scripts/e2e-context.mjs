/**
 * Checks on publishing market context over the admin API.
 *   node scripts/e2e-context.mjs
 *
 * The endpoint replaces by source rather than appending, which is the right
 * behaviour and also the dangerous one: it issues a DELETE before it writes. So
 * these tests are mostly about what happens when a publish goes wrong, because
 * that is when replace-by-source can destroy data it was meant to refresh.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TEREFLOW_ADMIN_TOKEN ?? 'local-dev-token';

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

async function post(body) {
  const res = await fetch(`${BASE}/api/admin/ingest/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  return { status: res.status, json: text ? JSON.parse(text) : null };
}

async function contextFor(slug) {
  const res = await fetch(`${BASE}/api/dashboard/${slug}`);
  const j = await res.json();
  return j.market_context;
}

// A source ref of its own, so nothing here can disturb the real World Bank rows
// this instance is serving. A test that can damage live data is a test nobody
// will run twice.
const TEST_SOURCE = `e2e-context-${Date.now()}`;

const row = (code, year, value) => ({
  indicator_code: code,
  category: 'macro',
  year,
  value,
  unit: 'percent',
  source_name: 'Test',
  source_url: 'https://example.com/series',
  confidence: 0.5,
});

console.log('\nA publish writes what it was given');
console.log('----------------------------------');
{
  const res = await post({
    slug: 'ghana',
    source_ref: TEST_SOURCE,
    indicators: [row('GDP_GROWTH', 2023, 2.9), row('GDP_GROWTH', 2024, 5.7)],
    sectors: [
      {
        sector_code: 'manufacturing',
        sector_name: 'Manufacturing',
        year: 2024,
        share_of_gdp: 11.2,
        unit: 'percent',
        source_name: 'Test',
        source_url: 'https://example.com/series',
      },
    ],
  });
  check('accepted', res.status === 200, `${res.status}`);
  check('counts what it wrote', res.json?.indicators === 2 && res.json?.sectors === 1, JSON.stringify(res.json));
}

console.log('\nRe-publishing corrects rather than accumulates');
console.log('---------------------------------------------');
{
  // The failure this prevents: two runs leaving 2024 in twice, so a chart shows
  // the same year at two different values and neither is wrong on its own.
  const again = await post({
    slug: 'ghana',
    source_ref: TEST_SOURCE,
    indicators: [row('GDP_GROWTH', 2023, 2.9), row('GDP_GROWTH', 2024, 5.7)],
    sectors: [],
  });
  check('a second identical publish is accepted', again.status === 200);
  check('and writes the same count, not double', again.json?.indicators === 2, JSON.stringify(again.json));

  const corrected = await post({
    slug: 'ghana',
    source_ref: TEST_SOURCE,
    indicators: [row('GDP_GROWTH', 2024, 6.1)],
    sectors: [],
  });
  check('a corrected figure replaces the old one', corrected.json?.indicators === 1);
}

console.log('\nOne source cannot clear another');
console.log('-------------------------------');
{
  // The DELETE is scoped by source_ref. If it were not, a World Bank refresh
  // would wipe every figure an admin had uploaded by hand, and the run would
  // report success.
  const other = `${TEST_SOURCE}-other`;
  await post({ slug: 'ghana', source_ref: other, indicators: [row('INFLATION', 2024, 22.5)], sectors: [] });
  await post({ slug: 'ghana', source_ref: TEST_SOURCE, indicators: [row('GDP_GROWTH', 2024, 6.1)], sectors: [] });

  const ctx = await contextFor('ghana');
  const all = (ctx?.groups ?? []).flatMap((g) => g.figures);
  check('the other source survived the publish', all.some((f) => f.code === 'INFLATION'), all.map((f) => f.code).join(','));
}

console.log('\nThe real World Bank rows are untouched by all of this');
console.log('----------------------------------------------------');
{
  const ctx = await contextFor('ghana');
  const all = (ctx?.groups ?? []).flatMap((f) => f.figures);
  check('population is still there', all.some((f) => f.code === 'POP_TOTAL'));
  check('and so is household spending', all.some((f) => f.code === 'HH_CONSUMPTION_PC'));
  // If the scoping were wrong these would be gone, and the panel would look
  // fine because it renders whatever it is given.
}

console.log('\nA bad request is refused before anything is deleted');
console.log('--------------------------------------------------');
{
  const noSource = await post({ slug: 'ghana', indicators: [row('GDP_GROWTH', 2024, 5.7)] });
  check('a publish with no source_ref is rejected', noSource.status === 400, `${noSource.status}`);

  const unknown = await post({ slug: 'not-a-country', source_ref: TEST_SOURCE, indicators: [] });
  check('an unknown country is rejected', unknown.status === 404, `${unknown.status}`);

  const ctx = await contextFor('ghana');
  const all = (ctx?.groups ?? []).flatMap((g) => g.figures);
  check('and neither refusal removed anything', all.some((f) => f.code === 'POP_TOTAL'));
}

console.log('\nAn oversized body is refused rather than attempted');
console.log('-------------------------------------------------');
{
  const huge = Array.from({ length: 2100 }, (_, i) => row('GDP_GROWTH', 1900 + i, i));
  const res = await post({ slug: 'ghana', source_ref: TEST_SOURCE, indicators: huge });
  check('over the row ceiling is rejected', res.status === 400, `${res.status}`);
  check('and says what the limit is', /2000 rows/.test(res.json?.error ?? ''), res.json?.error);
}

console.log('\nThe endpoint is not open');
console.log('------------------------');
{
  const res = await fetch(`${BASE}/api/admin/ingest/context`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ slug: 'ghana', source_ref: TEST_SOURCE, indicators: [] }),
  });
  check('an unauthenticated publish is refused', res.status === 401 || res.status === 403, `${res.status}`);
}

// Clean up the test sources, so a later run of anything does not find them.
for (const src of [TEST_SOURCE, `${TEST_SOURCE}-other`]) {
  await post({ slug: 'ghana', source_ref: src, indicators: [], sectors: [] });
}

console.log('\nCleanup left the real data in place');
console.log('----------------------------------');
{
  const ctx = await contextFor('ghana');
  const all = (ctx?.groups ?? []).flatMap((g) => g.figures);
  check('World Bank figures remain', all.length > 20, `${all.length} figures`);
  check('and the test sources are gone', !all.some((f) => f.code === 'INFLATION' && f.year === 2024 && f.value === 22.5));
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
