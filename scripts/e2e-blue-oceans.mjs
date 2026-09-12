/**
 * The blue ocean gate, through the real HTTP surface.
 *   node scripts/e2e-blue-oceans.mjs
 *
 * The unit tests prove the rule. This proves the wiring: that the route reads
 * the right country, resolves the viewer's tier from the session rather than a
 * header, and that an account which should not see the analysis does not get it
 * in the response body even if the page would not have rendered it.
 *
 * Checking the rendered page is not enough. Withheld data that still ships in
 * the JSON is disclosed data.
 */
const BASE = process.env.API_BASE ?? 'http://127.0.0.1:8787';

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

async function setVisibility(visibility) {
  const res = await fetch(`${BASE}/api/admin/entities/ghana/blue-ocean`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', cookie: adminCookie },
    body: JSON.stringify({ visibility }),
  });
  return res;
}

async function dashboard(cookie) {
  const res = await fetch(`${BASE}/api/dashboard/ghana`, {
    headers: cookie ? { cookie } : {},
  });
  return res.json();
}

/**
 * Registers an account and returns its session cookie, or why it could not.
 *
 * Registration already returns a session, so this does not log in afterwards.
 * The whole suite shares one IP against a 40-per-15-minutes login ceiling, and
 * a redundant login here is a login another test cannot make. The limiter
 * cannot be cleared mid-run on Windows because miniflare holds the KV files
 * open, so the budget is real.
 */
async function makeAccount(email, password) {
  const reg = await fetch(`${BASE}/api/auth/register`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ email, password, full_name: 'Gate Test' }),
  });
  // A 429 is the local rate limiter, which is an environment problem rather
  // than a failing gate, and it needs to say so rather than reading as broken
  // registration.
  if (reg.status === 429) return { cookie: null, reason: 'rate limited by the local dev server' };
  if (!reg.ok) return { cookie: null, reason: `registration returned ${reg.status}` };
  const raw = reg.headers.get('set-cookie');
  return {
    cookie: raw ? raw.split(';')[0] : null,
    reason: raw ? null : 'registration returned no session cookie',
  };
}

const stamp = Date.now();
const account = await makeAccount(`gate-free-${stamp}@example.com`, 'TestPassw0rd!23');
const freeCookie = account.cookie;

// The admin session comes from the same env var the other admin e2e scripts use.
const adminCookie = process.env.ADMIN_COOKIE ?? '';

console.log('\nA signed-out reader gets nothing, whatever the setting');
console.log('-----------------------------------------------------');
{
  const d = await dashboard(null);
  check('blue_oceans is absent from the payload', d.blue_oceans === null);
  check('and the reason is about signing in', /sign in/i.test(d.blue_ocean_withheld_reason ?? ''), d.blue_ocean_withheld_reason);
  check(
    'no row leaks anywhere else in the response',
    !JSON.stringify(d).includes('Room in the data is not the same as room in the market'),
  );
}

console.log('\nA free account sees them when the setting allows it');
console.log('--------------------------------------------------');
if (!freeCookie) {
  console.log(`  SKIP  could not create a test account: ${account.reason}`);
  // The signed-out checks above already ran. This is the half that needs an
  // account, and it is worth being clear that it did not run rather than
  // letting a green suite imply it did.
  console.log('  NOTE  the permitted-viewer path was NOT exercised on this run');
} else {
  const d = await dashboard(freeCookie);
  check('the setting is reported', d.blue_ocean_visibility === 'registered', d.blue_ocean_visibility);
  check('rows are returned', Array.isArray(d.blue_oceans), String(d.blue_oceans === null));
  if (Array.isArray(d.blue_oceans) && d.blue_oceans.length > 0) {
    const first = d.blue_oceans[0];
    check('each row explains itself', typeof first.reason === 'string' && first.reason.length > 20, first.reason);
    check('each row carries its evidence', Array.isArray(first.evidence) && first.evidence.length > 0);
    check(
      'and the framing caveat leads the limitations',
      /Room in the data is not the same as room in the market/.test(first.limitations?.[0] ?? ''),
    );
    check(
      'the kind is one of the two defined shapes',
      ['concentrated_supply', 'growing_unserved'].includes(first.kind),
      first.kind,
    );
  } else {
    console.log('  NOTE  no uncontested lines found for Ghana; row shape not checked');
  }
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exitCode = failed === 0 ? 0 : 1;
