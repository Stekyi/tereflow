/**
 * Checks on reporting a run's progress.
 *   node scripts/e2e-run-progress.mjs
 *
 * A full ingest is about fourteen minutes. Before these endpoints existed the
 * run row was created after every chapter had already been fetched, so for the
 * whole time the work was happening there was nothing to poll and the admin
 * screen could only show a spinner. A spinner cannot tell a run on chapter 84
 * of 96 from one that died on chapter 3.
 *
 * Most of what follows is about a bar that would otherwise lie: going
 * backwards, sitting at zero when there is nothing to count, or filling in
 * after a run has already failed.
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

/** Runs opened here are closed at the end, so none is left showing as running. */
const opened = [];
async function openRun(body) {
  const r = await post('/api/ghana/runs/open', { country: 'GH', provider: 'e2e-test', ...body });
  if (r.json?.run_id) opened.push(r.json.run_id);
  return r;
}

console.log('\nA run exists before the work starts');
console.log('-----------------------------------');
{
  const r = await openRun({ chapters_total: 96 });
  check('opening a run is accepted', r.status === 200, `${r.status}`);
  check('and it starts as running', r.json?.status === 'running', r.json?.status);

  const p = await get(`/api/ghana/runs/${r.json.run_id}`);
  check('it can be polled immediately', p.status === 200);
  check('with nothing done yet', p.json?.chapters_done === 0, `${p.json?.chapters_done}`);
  check('and the total already known', p.json?.chapters_total === 96, `${p.json?.chapters_total}`);
  check('so the percentage is real from the first poll', p.json?.percent === 0, `${p.json?.percent}`);
}

console.log('\nProgress moves, and the percentage is computed once');
console.log('--------------------------------------------------');
{
  // Worked out server-side so every caller shows the same number. A percentage
  // computed in two places is one that eventually disagrees with itself.
  const r = await openRun({ chapters_total: 96 });
  const id = r.json.run_id;

  await post(`/api/ghana/runs/${id}/progress`, {
    chapters_done: 24,
    records_received: 10320,
    records_processed: 10000,
    records_rejected: 320,
    current_step: 'Chapter 24',
  });

  const p = await get(`/api/ghana/runs/${id}`);
  check('chapters advance', p.json?.chapters_done === 24, `${p.json?.chapters_done}`);
  check('the percentage follows', p.json?.percent === 25, `${p.json?.percent}`);
  check('the step is reported', p.json?.current_step === 'Chapter 24', p.json?.current_step);
  check('counts are carried', p.json?.records_processed === 10000 && p.json?.records_rejected === 320);
  check('and it is not finished', p.json?.is_finished === false);
}

console.log('\nA partial update leaves the rest alone');
console.log('--------------------------------------');
{
  // A caller that knows its chapter count but not its record count should not
  // have to invent one, and sending nothing for a field must not blank it.
  const r = await openRun({ chapters_total: 10 });
  const id = r.json.run_id;

  await post(`/api/ghana/runs/${id}/progress`, { chapters_done: 5, records_processed: 500 });
  await post(`/api/ghana/runs/${id}/progress`, { current_step: 'Still going' });

  const p = await get(`/api/ghana/runs/${id}`);
  check('the earlier count survives', p.json?.records_processed === 500, `${p.json?.records_processed}`);
  check('and so does the chapter count', p.json?.chapters_done === 5, `${p.json?.chapters_done}`);
  check('while the new field is applied', p.json?.current_step === 'Still going');

  const empty = await post(`/api/ghana/runs/${id}/progress`, {});
  check('an update with nothing in it is refused', empty.status === 400, `${empty.status}`);
}

console.log('\nCounts are absolute, so a retry cannot double them');
console.log('-------------------------------------------------');
{
  // Incrementing would count a retried chapter twice, and the total would be
  // wrong in a way that still looks like a total.
  const r = await openRun({ chapters_total: 10 });
  const id = r.json.run_id;

  await post(`/api/ghana/runs/${id}/progress`, { chapters_done: 3, records_processed: 300 });
  await post(`/api/ghana/runs/${id}/progress`, { chapters_done: 3, records_processed: 300 });

  const p = await get(`/api/ghana/runs/${id}`);
  check('the same update twice leaves the same numbers', p.json?.records_processed === 300, `${p.json?.records_processed}`);
  check('and the same chapter count', p.json?.chapters_done === 3, `${p.json?.chapters_done}`);
}

console.log('\nNo chapters to count is an absence, not zero progress');
console.log('----------------------------------------------------');
{
  // A single PDF has no chapters. Zero-of-zero would render as a bar stuck at
  // the start, which reads as stalled rather than as "nothing to measure".
  const r = await openRun({ provider: 'pdf' });
  const p = await get(`/api/ghana/runs/${r.json.run_id}`);
  check('the total is null', p.json?.chapters_total === null, `${p.json?.chapters_total}`);
  check('and so is the percentage', p.json?.percent === null, `${p.json?.percent}`);
  check('rather than reading as 0%', p.json?.percent !== 0);
}

console.log('\nA finished run cannot be edged forward');
console.log('--------------------------------------');
{
  // Otherwise a failed run quietly acquires a full progress bar, and the
  // failure becomes invisible.
  const r = await openRun({ chapters_total: 10 });
  const id = r.json.run_id;

  await post(`/api/ghana/runs/${id}/fail`, { error: 'Stopped for the test.' });

  const p = await get(`/api/ghana/runs/${id}`);
  check('the run is marked failed', p.json?.status === 'failed', p.json?.status);
  check('it reports as finished', p.json?.is_finished === true);
  check('the reason is kept', /Stopped for the test/.test(p.json?.error_message ?? ''), p.json?.error_message);
  check('and the step is cleared', p.json?.current_step === null, p.json?.current_step);

  const late = await post(`/api/ghana/runs/${id}/progress`, { chapters_done: 10 });
  check('a later progress update is refused', late.status === 404, `${late.status}`);

  const after = await get(`/api/ghana/runs/${id}`);
  check('and the run did not move', after.json?.chapters_done === 0, `${after.json?.chapters_done}`);

  const twice = await post(`/api/ghana/runs/${id}/fail`, { error: 'again' });
  check('failing an already-failed run is refused', twice.status === 404, `${twice.status}`);
}

console.log('\nA failure with no reason still says something');
console.log('---------------------------------------------');
{
  const r = await openRun({ chapters_total: 4 });
  await post(`/api/ghana/runs/${r.json.run_id}/fail`, {});
  const p = await get(`/api/ghana/runs/${r.json.run_id}`);
  check('a reason is always recorded', (p.json?.error_message ?? '').length > 10, p.json?.error_message);
}

console.log('\nAn unknown run is a 404, not an empty bar');
console.log('-----------------------------------------');
{
  const p = await get('/api/ghana/runs/run_does_not_exist');
  check('polling an unknown run fails', p.status === 404, `${p.status}`);
  const up = await post('/api/ghana/runs/run_does_not_exist/progress', { chapters_done: 1 });
  check('and so does updating one', up.status === 404, `${up.status}`);
}

console.log('\nProgress reporting is not open');
console.log('------------------------------');
{
  const r = await openRun({ chapters_total: 4 });
  const noAuth = await fetch(`${BASE}/api/ghana/runs/${r.json.run_id}/progress`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ chapters_done: 99 }),
  });
  check('an unauthenticated update is refused', noAuth.status === 401 || noAuth.status === 403, `${noAuth.status}`);

  const openNoAuth = await fetch(`${BASE}/api/ghana/runs/open`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ country: 'GH' }),
  });
  check('and so is opening a run', openNoAuth.status === 401 || openNoAuth.status === 403, `${openNoAuth.status}`);
}

console.log('\nThe run list describes a run the same way the poll does');
console.log('------------------------------------------------------');
{
  // Two endpoints returning the same row have to agree about it. The list
  // originally left out is_finished, so a caller reading a finished run from
  // there saw undefined, treated it as still going, and never showed the
  // result summary.
  const list = await get('/api/ghana/runs?country=GH');
  check('the list loads', list.status === 200);
  const runs = list.json?.runs ?? [];
  check('every run reports its progress fields',
    runs.every((r) => 'chapters_done' in r && 'chapters_total' in r && 'current_step' in r));
  check('and whether it has finished',
    runs.every((r) => typeof r.is_finished === 'boolean'),
    JSON.stringify(runs[0] ?? {}).slice(0, 120));
  check('and a percentage computed the same way',
    runs.every((r) => r.percent === null || typeof r.percent === 'number'));

  const finished = runs.find((r) => r.status !== 'running');
  if (finished) {
    const one = await get(`/api/ghana/runs/${finished.id}`);
    check('the two endpoints agree on finished',
      one.json?.is_finished === finished.is_finished,
      `${one.json?.is_finished} vs ${finished.is_finished}`);
    check('and on the percentage',
      one.json?.percent === finished.percent,
      `${one.json?.percent} vs ${finished.percent}`);
  }
}

// Close anything still open, so the admin screen is not left showing runs in
// progress that nothing is working on.
for (const id of opened) {
  await post(`/api/ghana/runs/${id}/fail`, { error: 'Test run, cleaned up.' }).catch(() => undefined);
}

console.log('\nCleanup left nothing running');
console.log('----------------------------');
{
  const list = await get('/api/ghana/runs?country=GH');
  const stillRunning = (list.json?.runs ?? []).filter(
    (r) => r.status === 'running' && r.provider === 'e2e-test',
  );
  check('no test run is left as running', stillRunning.length === 0, `${stillRunning.length}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
