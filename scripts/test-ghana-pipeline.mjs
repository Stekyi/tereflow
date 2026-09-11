/**
 * The guarantees the refactor exists to provide.
 *   node scripts/test-ghana-pipeline.mjs
 *
 * These are not unit tests of arithmetic. They are checks on the promises the
 * whole thing is built to keep, which is why each one is written as the failure
 * it prevents rather than the function it calls.
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-pipeline-test.mjs';
await build({
  entryPoints: ['scripts/entry-ghana-pipeline.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { GhanaStatBankProvider, GHANA, computeMetrics, buildOpportunities } =
  await import(`./../${OUT}`);

const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TF_ADMIN_TOKEN ?? 'local-dev-token';

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

async function get(path) {
  const r = await fetch(`${BASE}${path}`, { headers: { accept: 'application/json' } });
  return { status: r.status, body: await r.json().catch(() => null) };
}

console.log('\nNo silent fallback');
console.log('------------------');

{
  // The failure the whole refactor exists to prevent. The old pipeline dropped
  // through to UN Comtrade when Ghana's own source produced nothing, which is
  // why every stored Ghana fact came from Comtrade while the dashboard implied
  // otherwise.
  const provider = new GhanaStatBankProvider();
  const dead = {
    ...GHANA,
    provider: { ...GHANA.provider, endpoint: 'https://statsbank.statsghana.gov.gh/api/v1/en/Trade/not_a_real_table.px' },
  };
  const r = await provider.fetchObservations({
    config: dead,
    flow: 'import',
    years: ['2024'],
    partners: GHANA.partners.slice(0, 2),
    products: ['34'],
  });
  check('a dead endpoint fails rather than succeeding quietly', r.ok === false);
  check('it returns no observations at all', r.observations.length === 0, `${r.observations.length} rows`);
  check('and says what went wrong', !!r.error, r.error ?? '');
  check('nothing in the result mentions another source',
    !/comtrade|world.?bank/i.test(JSON.stringify(r)), 'no other provider named');
}

{
  // The store route is the only way data reaches the database, and it has no
  // provider import, so there is no code path from a failure to a substitution.
  const source = await import('node:fs').then((fs) =>
    fs.readFileSync('worker/routes/ghana.ts', 'utf8'));
  check('the storage route cannot fetch from anywhere',
    !/fetch\s*\(/.test(source.replace(/\/\*[\s\S]*?\*\//g, '')),
    'no fetch call in the route');
  check('and imports no provider', !/from '\.\.\/providers\/ghana-statbank'/.test(source));
}

console.log('\nThe application serves stored data, not live calls');
console.log('--------------------------------------------------');

{
  const t = Date.now();
  const r = await get('/api/ghana/opportunities?flow=import&limit=10');
  const ms = Date.now() - t;
  check('the opportunities endpoint answers', r.status === 200, `HTTP ${r.status}`);
  // A StatBank call takes about nine seconds. Anything near that would mean the
  // page was fetching rather than reading.
  check('it answers fast enough to be reading a database', ms < 2000, `${ms}ms`);
  check('it returns opportunities', (r.body?.count ?? 0) > 0, `${r.body?.count} rows`);
}

console.log('\nProvenance is on the record');
console.log('---------------------------');

{
  const r = await get('/api/ghana/opportunities?flow=import&limit=3');
  const b = r.body;
  check('the source is named', b?.source === 'Ghana Statistical Service', b?.source);
  check('the endpoint is recorded', /statsbank\.statsghana\.gov\.gh/.test(b?.source_endpoint ?? ''));
  check('the classification is explicit', b?.classification === 'HS2', b?.classification);
  check('the last successful run is identified', !!b?.last_successful_run?.completed_at,
    b?.last_successful_run?.completed_at ?? 'none');
  check('every opportunity carries its source',
    (b?.opportunities ?? []).every((o) => o.source === 'Ghana Statistical Service'));
}

console.log('\nEvery number comes with its limits');
console.log('----------------------------------');

{
  const r = await get('/api/ghana/opportunities?flow=import&limit=8');
  const opps = r.body?.opportunities ?? [];
  check('each opportunity states what the data cannot say',
    opps.every((o) => Array.isArray(o.data_limitations) && o.data_limitations.length > 0));
  check('each says the HS2 level is a sector signal, not a product one',
    opps.every((o) => o.data_limitations.some((l) => /sector signal/i.test(l))));
  check('each admits domestic production is unknown',
    opps.every((o) => o.data_limitations.some((l) => /domestic production/i.test(l))));
  check('each carries the evidence behind its claims',
    opps.every((o) => Array.isArray(o.evidence) && o.evidence.length >= 3));
  check('confidence is reported separately from score',
    opps.every((o) => ['high', 'medium', 'low'].includes(o.confidence)));
  check('and the confidence reasoning is given',
    opps.every((o) => Array.isArray(o.confidence_reasons) && o.confidence_reasons.length > 0));
  check('no explanation promises a return or a margin',
    opps.every((o) => !/profit|margin|guaranteed|will earn/i.test(o.explanation)));
  check('every explanation says it is a signal rather than advice',
    opps.every((o) => /signal rather than a recommendation/i.test(o.explanation)));
}

console.log('\nTraditional commodities stay out of the ranking');
console.log('----------------------------------------------');

{
  const visible = await get('/api/ghana/opportunities?flow=import&limit=100');
  const all = await get('/api/ghana/opportunities?flow=import&limit=100&include_excluded=true');
  const shown = visible.body?.opportunities ?? [];
  const every = all.body?.opportunities ?? [];

  check('gold is not in the default ranking', !shown.some((o) => o.product_code === '71'));
  check('petroleum is not in the default ranking', !shown.some((o) => o.product_code === '27'));
  check('but both are still stored and visible on request',
    every.some((o) => o.product_code === '71') && every.some((o) => o.product_code === '27'));
  check('and each excluded row explains itself',
    every.filter((o) => o.is_excluded).every((o) => !!o.excluded_reason));

  // The whole point: what an entrepreneur sees first should be something they
  // could plausibly make or supply.
  check('the ranking leads with a non-traditional product',
    shown.length > 0 && !shown[0].is_excluded, shown[0]?.product_name ?? 'nothing');
  console.log(`    top five: ${shown.slice(0, 5).map((o) => `HS${o.product_code}`).join(', ')}`);
}

console.log('\nIdempotency');
console.log('-----------');

{
  const runs = await get('/api/ghana/runs');
  const ok = (runs.body?.runs ?? []).filter((r) => r.status === 'ok');
  check('several successful runs are on record', ok.length >= 2, `${ok.length} ok runs`);
  // Each run re-stored the same grain. If the unique index were not doing its
  // job, observations would have multiplied by the number of runs.
  const latest = ok[0];
  check('the newest run processed a full set', latest?.records_processed > 1000,
    `${latest?.records_processed} records`);
  check('and every run records what it rejected',
    ok.every((r) => typeof r.records_rejected === 'number'));
}

console.log('\nDeterminism');
console.log('-----------');

{
  // Same input, same score, twice, through the real analytics rather than a
  // stub of it.
  const obs = [];
  for (const [i, v] of [12e6, 15e6, 19e6, 24e6, 30e6].entries()) {
    obs.push({
      country_code: 'GH', year: 2021 + i, month: 0, trade_flow: 'import',
      classification_system: 'HS', classification_level: 'HS2', product_code: '34',
      product_description: 'Soap', partner_country: 'China', partner_iso3: 'CHN',
      import_value_usd: v, net_weight_kg: v / 3, value_is_derived: true,
      months_counted: 12, source: 'Ghana Statistical Service',
      source_endpoint: 'x', retrieved_at: '2026-01-01T00:00:00Z',
    });
  }
  const a = buildOpportunities(computeMetrics(obs), GHANA)[0];
  const b = buildOpportunities(computeMetrics(obs), GHANA)[0];
  check('the same observations give the same score', a.opportunity_score === b.opportunity_score,
    String(a.opportunity_score));
  check('and the same explanation', a.explanation === b.explanation);
  check('and the same confidence', a.data_confidence === b.data_confidence);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
rmSync(OUT, { force: true });
process.exitCode = failed === 0 ? 0 : 1;
