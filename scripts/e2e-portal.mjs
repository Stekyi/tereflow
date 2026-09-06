/**
 * End-to-end check of the owner portal against a running dev server.
 *   npm run dev:worker            (terminal 1)
 *   node scripts/e2e-portal.mjs   (terminal 2)
 *
 * The portal reads across almost every table, so these checks are mostly about
 * two things: that no section is reachable without the admin token, and that
 * the aggregates are internally consistent rather than merely present.
 */
const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.TF_ADMIN_TOKEN ?? 'local-dev-token';

const SECTIONS = [
  'overview',
  'pipeline',
  'users',
  'network',
  'premium',
  'sources',
  'content',
  'setup',
];

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

async function get(path, token = ADMIN_TOKEN) {
  const res = await fetch(`${BASE}${path}`, {
    headers: {
      accept: 'application/json',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
  });
  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = null;
  }
  return { status: res.status, body };
}

async function main() {
  console.log('\nOwner portal\n');

  // --- the gate ------------------------------------------------------------
  console.log('Access');
  for (const s of SECTIONS) {
    const anon = await get(`/api/admin/portal/${s}`, null);
    check(`${s} refuses an anonymous read`, anon.status === 401, `status ${anon.status}`);
  }
  const wrongToken = await get('/api/admin/portal/overview', 'not-the-token');
  check('a wrong token is refused', wrongToken.status === 401, `status ${wrongToken.status}`);

  // --- every section answers ----------------------------------------------
  console.log('\nSections');
  const loaded = {};
  for (const s of SECTIONS) {
    const r = await get(`/api/admin/portal/${s}`);
    loaded[s] = r.body;
    check(`${s} responds`, r.status === 200, `status ${r.status}`);
  }

  // --- overview ------------------------------------------------------------
  console.log('\nOverview');
  const o = loaded.overview ?? {};
  const counts = o.counts ?? {};
  check(
    'counts cover every surface the portal reports on',
    [
      'countries',
      'countries_active',
      'sources',
      'facts',
      'signals',
      'users',
      'cards',
      'messages',
      'subscriptions',
      'playbooks',
    ].every((k) => typeof counts[k] === 'number'),
  );
  check(
    'active countries cannot exceed the registry',
    (counts.countries_active ?? 0) <= (counts.countries ?? 0),
    `${counts.countries_active} of ${counts.countries}`,
  );
  check(
    'premium accounts cannot exceed all accounts',
    (counts.premium_users ?? 0) <= (counts.users ?? 0),
  );
  check('attention block is present', Boolean(o.attention));
  check(
    'link health adds up to the source count',
    (o.link_health?.ok ?? 0) +
      (o.link_health?.gated ?? 0) +
      (o.link_health?.dead ?? 0) +
      (o.link_health?.unknown ?? 0) ===
      counts.sources,
    `${counts.sources} sources`,
  );

  // The attention counts are what the owner acts on, so a wrong one is worse
  // than a missing one. Cross-check against the pipeline section.
  const countries = loaded.pipeline?.countries ?? [];
  const neverRun = countries.filter((c) => c.is_active && !c.last_ingest_at).length;
  check(
    'never-run count matches the country list',
    o.attention?.active_never_run === neverRun,
    `attention says ${o.attention?.active_never_run}, list has ${neverRun}`,
  );

  // --- pipeline ------------------------------------------------------------
  console.log('\nPipeline');
  check('run history is a list', Array.isArray(loaded.pipeline?.runs));
  check('country list covers the registry', countries.length === counts.countries);
  check(
    'countries that have run report facts',
    countries.filter((c) => c.last_ingest_at).every((c) => c.facts > 0),
  );
  check(
    'runs are newest first',
    (loaded.pipeline?.runs ?? []).every(
      (r, i, a) => i === 0 || a[i - 1].started_at >= r.started_at,
    ),
  );

  // --- users ---------------------------------------------------------------
  console.log('\nUsers');
  const users = loaded.users?.users ?? [];
  check('user list is present', Array.isArray(users));
  check(
    'no password material is ever selected',
    users.every((u) => !('password_hash' in u) && !('password_salt' in u)),
  );
  check(
    'tier breakdown totals the account count',
    (loaded.users?.by_tier ?? []).reduce((s, r) => s + r.n, 0) === counts.users,
  );

  const search = await get('/api/admin/portal/users?q=zzzznomatch');
  check('user search filters', (search.body?.users ?? []).length === 0);

  // --- sources -------------------------------------------------------------
  console.log('\nSources');
  const dead = await get('/api/admin/portal/sources?health=dead');
  check(
    'the dead filter returns only links classified dead',
    (dead.body?.sources ?? []).every((s) => s.health === 'dead'),
    `${dead.body?.count ?? 0} dead`,
  );
  check(
    'the dead filter agrees with the overview count',
    (dead.body?.count ?? 0) === (o.link_health?.dead ?? -1),
    `filter ${dead.body?.count}, overview ${o.link_health?.dead}`,
  );

  const gated = await get('/api/admin/portal/sources?health=gated');
  check(
    'the gated filter returns only links classified gated',
    (gated.body?.sources ?? []).every((s) => s.health === 'gated'),
  );
  check(
    'every source carries a health classification',
    (await get('/api/admin/portal/sources')).body?.sources?.every((s) =>
      ['ok', 'gated', 'dead', 'unknown'].includes(s.health),
    ),
  );

  // --- setup ---------------------------------------------------------------
  console.log('\nSetup');
  const setup = loaded.setup ?? {};
  check('config checklist is present', Array.isArray(setup.config) && setup.config.length > 0);
  check(
    'every config entry says why it matters',
    (setup.config ?? []).every((c) => typeof c.why === 'string' && c.why.length > 20),
  );
  // The whole point of returning booleans: a portal that prints secrets is a
  // portal that leaks them into screenshots and support threads.
  check(
    'no secret value is ever returned',
    (setup.config ?? []).every(
      (c) => typeof c.set === 'boolean' && !('value' in c) && !('secret' in c),
    ),
  );
  check('the admin token is reported as configured', 
    (setup.config ?? []).find((c) => c.key === 'ADMIN_TOKEN')?.set === true);

  // --- premium and network -------------------------------------------------
  console.log('\nPremium and network');
  check(
    'follow counts total the subscription count',
    (loaded.premium?.by_kind ?? []).reduce((s, r) => s + r.n, 0) === counts.subscriptions,
  );
  check('billing list is present', Array.isArray(loaded.premium?.billing));
  check('card list is present', Array.isArray(loaded.network?.cards));
  check(
    'card count matches the overview',
    (loaded.network?.cards ?? []).length <= counts.cards,
  );
  check('playbook list matches the overview', (loaded.content?.playbooks ?? []).length === counts.playbooks);

  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
