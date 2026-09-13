/**
 * Checks on asking for a run from the admin screen.
 *   node scripts/e2e-run-queue.mjs
 *
 * The admin wanted one button. The work behind it is about fourteen minutes of
 * sequential calls to a government API, measured at roughly eight and a half
 * seconds per chapter against Ghana's endpoint, so the button cannot do the
 * work inside the request. It queues, and an agent on the operator's machine
 * claims it.
 *
 * That design has one failure mode worth more attention than the happy path: a
 * queued run with no agent listening looks exactly like one about to start. The
 * difference matters because the first will begin in seconds and the second
 * never will, and showing a progress bar for the second is how somebody waits
 * twenty minutes for nothing.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';
const TOKEN = process.env.TEREFLOW_ADMIN_TOKEN ?? 'local-dev-token';
const H = { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` };

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

const post = async (path, body) => {
  const r = await fetch(`${BASE}${path}`, { method: 'POST', headers: H, body: JSON.stringify(body) });
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};
const get = async (path) => {
  const r = await fetch(`${BASE}${path}`);
  const t = await r.text();
  return { status: r.status, json: t ? JSON.parse(t) : null };
};

const created = [];
async function close(id) {
  if (id) await post(`/api/ghana/runs/${id}/fail`, { error: 'Test run, cleaned up.' }).catch(() => undefined);
}

// Anything already pending would make "request returns queued" fail for a
// reason that has nothing to do with the code. Cleared first.
{
  const list = await get('/api/ghana/runs?country=GH');
  for (const r of list.json?.runs ?? []) {
    if (r.status === 'queued' || r.status === 'running') await close(r.id);
  }
}

console.log('\nThe button queues rather than pretending to run');
console.log('----------------------------------------------');
{
  const r = await post('/api/ghana/runs/request', { country: 'GH', flow: 'import' });
  created.push(r.json?.run_id);
  check('the request is accepted', r.status === 200, `${r.status}`);
  check('and comes back queued, not running', r.json?.status === 'queued', r.json?.status);
  check('with a run id to poll', /^run_/.test(r.json?.run_id ?? ''), r.json?.run_id);

  const p = await get(`/api/ghana/runs/${r.json.run_id}`);
  check('the run can be polled immediately', p.status === 200);
  check('it is not finished', p.json?.is_finished === false);
  // Queued at request time, before anything knows how many chapters there are.
  check('and has no chapter total yet', p.json?.chapters_total === null, `${p.json?.chapters_total}`);
}

console.log('\nAsking twice does not queue twice');
console.log('---------------------------------');
{
  // Two agents fetching the same chapters would double the load on somebody
  // else's API, and the loser of the race would have its rows silently
  // replaced by the winner's.
  const again = await post('/api/ghana/runs/request', { country: 'GH', flow: 'import' });
  check('the second request is accepted', again.status === 200);
  check('and says it is already pending', again.json?.already_pending === true);
  check('returning the same run', again.json?.run_id === created[0], `${again.json?.run_id}`);
  check('with an explanation', (again.json?.message ?? '').length > 20, again.json?.message);
}

console.log('\nThe other flow is a separate job');
console.log('--------------------------------');
{
  // Imports and exports are different requests against the same endpoint, and
  // wanting one does not mean wanting the other.
  const exp = await post('/api/ghana/runs/request', { country: 'GH', flow: 'export' });
  created.push(exp.json?.run_id);
  check('exports queue independently', exp.json?.already_pending === false, `${exp.json?.already_pending}`);
  check('as their own run', exp.json?.run_id !== created[0]);
}

console.log('\nThe queue reports whether anything is listening');
console.log('----------------------------------------------');
{
  const a = await get('/api/ghana/runs/agent?country=GH');
  check('the status loads', a.status === 200);
  check('queued runs are counted', a.json?.queued >= 1, `${a.json?.queued}`);
  // This is the field that separates "starting shortly" from "will never
  // start", and the UI shows a warning rather than a progress bar when it is
  // false.
  check('and whether an agent claimed work recently is reported',
    typeof a.json?.agent_recently_active === 'boolean',
    `${a.json?.agent_recently_active}`);
}

console.log('\nClaiming takes one run and marks it running');
console.log('-------------------------------------------');
{
  const c = await post('/api/ghana/runs/claim', { agent: 'test-agent' });
  check('a queued run is handed over', c.json?.claimed != null, JSON.stringify(c.json));
  check('with what to fetch', Boolean(c.json?.claimed?.country && c.json?.claimed?.flow),
    JSON.stringify(c.json?.claimed));

  const p = await get(`/api/ghana/runs/${c.json.claimed.run_id}`);
  check('the run is now running', p.json?.status === 'running', p.json?.status);

  // Oldest first, so a request does not sit behind one made after it.
  check('the oldest queued run was taken', c.json.claimed.run_id === created[0], c.json.claimed.run_id);
}

console.log('\nA claimed run cannot be claimed again');
console.log('-------------------------------------');
{
  // The claim is conditional on the row still being queued, so two agents
  // racing produce one winner rather than two runs doing the same work.
  const first = await post('/api/ghana/runs/claim', { agent: 'test-agent' });
  const firstId = first.json?.claimed?.run_id ?? null;
  const second = await post('/api/ghana/runs/claim', { agent: 'other-agent' });
  check('the second agent gets nothing', second.json?.claimed === null, JSON.stringify(second.json));
  if (firstId) check('and the first still holds its run', firstId !== second.json?.claimed?.run_id);
}

console.log('\nAn empty queue is an empty answer, not an error');
console.log('----------------------------------------------');
{
  const c = await post('/api/ghana/runs/claim', { agent: 'test-agent' });
  check('claiming from an empty queue succeeds', c.status === 200, `${c.status}`);
  check('and returns nothing to do', c.json?.claimed === null);
}

console.log('\nBad requests are refused');
console.log('------------------------');
{
  const noCountry = await post('/api/ghana/runs/request', { flow: 'import' });
  check('a request with no country is refused', noCountry.status === 400, `${noCountry.status}`);

  const badFlow = await post('/api/ghana/runs/request', { country: 'GH', flow: 'sideways' });
  check('an unknown flow is refused', badFlow.status === 400, `${badFlow.status}`);

  const unknown = await post('/api/ghana/runs/request', { country: 'ZZ', flow: 'import' });
  check('a country with no config is refused', unknown.status === 404, `${unknown.status}`);
}

console.log('\nNeither requesting nor claiming is open');
console.log('--------------------------------------');
{
  // Requesting queues work on somebody else's API; claiming hands over what to
  // fetch. Neither belongs to an anonymous caller.
  const r = await fetch(`${BASE}/api/ghana/runs/request`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ country: 'GH', flow: 'import' }),
  });
  check('requesting needs auth', r.status === 401 || r.status === 403, `${r.status}`);

  const c = await fetch(`${BASE}/api/ghana/runs/claim`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({}),
  });
  check('claiming needs auth', c.status === 401 || c.status === 403, `${c.status}`);
}

for (const id of created) await close(id);

console.log('\nCleanup left nothing pending');
console.log('----------------------------');
{
  const list = await get('/api/ghana/runs?country=GH');
  const pending = (list.json?.runs ?? []).filter((r) => r.status === 'queued');
  check('no test run is left queued', pending.length === 0, `${pending.length}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
