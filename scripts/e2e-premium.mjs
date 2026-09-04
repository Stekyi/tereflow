/**
 * End-to-end check of the premium layer against a running dev server.
 *   npx wrangler dev              (terminal 1)
 *   node scripts/e2e-premium.mjs  (terminal 2)
 */
const BASE = process.env.TA_BASE ?? 'http://127.0.0.1:8787';
const ADMIN_TOKEN = process.env.TA_ADMIN_TOKEN ?? 'local-dev-token';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    passed++;
    console.log(`  PASS  ${label}${detail ? ` — ${detail}` : ''}`);
  } else {
    failed++;
    console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`);
  }
}

class Client {
  constructor() {
    this.cookies = new Map();
  }
  async req(path, { method = 'GET', body, headers = {} } = {}) {
    const h = new Headers(headers);
    h.set('accept', 'application/json');
    if (body) h.set('content-type', 'application/json');
    if (this.cookies.size) {
      h.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    }
    const res = await fetch(`${BASE}${path}`, {
      method,
      headers: h,
      body: body ? JSON.stringify(body) : undefined,
      redirect: 'manual',
    });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '') this.cookies.delete(k);
      else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { _raw: text.slice(0, 200) };
    }
    return { status: res.status, json };
  }
  get(p) { return this.req(p); }
  post(p, b) { return this.req(p, { method: 'POST', body: b }); }
  del(p) { return this.req(p, { method: 'DELETE' }); }
}

const stamp = Date.now();
const kojo = new Client();
const anon = new Client();

console.log(`\nTradeAtlas premium end-to-end  (${BASE})\n`);

// 1. subscriptions -----------------------------------------------------------
console.log('1. Following things');
let r = await kojo.post('/api/auth/register', {
  email: `kojo${stamp}@example.com`,
  password: 'cocoafutures2026',
  full_name: 'Kojo Asare',
});
check('registers', r.status === 201, r.json?.error ?? 'ok');
check('starts on free tier', r.json?.user?.tier === 'free');

r = await kojo.post('/api/premium/subscriptions', {
  kind: 'hs_code',
  value: '18',
  label: 'Cocoa & cocoa preparations',
});
check('follows an HS chapter', r.status === 201, r.json?.error ?? 'ok');

r = await kojo.post('/api/premium/subscriptions', {
  kind: 'country',
  value: 'ghana',
  label: 'Ghana',
});
check('follows a country', r.status === 201, r.json?.error ?? 'ok');

r = await kojo.post('/api/premium/subscriptions', { kind: 'hs_code', value: '18', label: 'dupe' });
check('re-following does not duplicate', r.status === 201);

r = await kojo.get('/api/premium/subscriptions');
check('subscription list is correct', r.json?.subscriptions?.length === 2,
  `${r.json?.subscriptions?.length} subscription(s)`);

r = await kojo.post('/api/premium/subscriptions', { kind: 'nonsense', value: 'x' });
check('rejects an unknown kind', r.status === 400, r.json?.error);

r = await anon.get('/api/premium/subscriptions');
check('anonymous cannot list subscriptions', r.status === 401);

// 2. feed fan-out ------------------------------------------------------------
console.log('\n2. Weekly fan-out');
r = await fetch(`${BASE}/api/admin/runs?slug=ghana`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
});
const run = await r.json();
check('analysis run completes', run?.status === 'ok', `${run?.facts_written} facts`);
check('fan-out reports subscribers', (run?.feed?.subscribers ?? 0) >= 1,
  `${run?.feed?.subscribers} subscriber(s), ${run?.feed?.items_written} item(s)`);

r = await kojo.get('/api/premium/feed');
const items = r.json?.items ?? [];
check('feed has items', items.length > 0, `${items.length} item(s)`);
check('feed contains a premium signal', items.some((i) => i.kind === 'signal' && i.premium_only));
check('feed contains free context', items.some((i) => !i.premium_only));
check('free user sees signals locked', items.filter((i) => i.premium_only).every((i) => i.locked));
check('locked items withhold the body', items.filter((i) => i.locked).every((i) => i.body === null));
check('locked items keep their title', items.filter((i) => i.locked).every((i) => i.title?.length > 0));
check('free items are readable', items.filter((i) => !i.premium_only).every((i) => i.body !== null));

const beforeCount = items.length;
r = await fetch(`${BASE}/api/admin/runs?slug=ghana`, {
  method: 'POST',
  headers: { authorization: `Bearer ${ADMIN_TOKEN}` },
});
const rerun = await r.json();
r = await kojo.get('/api/premium/feed');
check('re-running the same week does not duplicate the feed',
  (r.json?.items?.length ?? 0) === beforeCount,
  `${beforeCount} then ${r.json?.items?.length}, fan-out wrote ${rerun?.feed?.items_written}`);

// 3. read state --------------------------------------------------------------
console.log('\n3. Read state');
r = await kojo.get('/api/auth/me');
const unreadBefore = r.json?.feed_unread ?? 0;
check('unread count is surfaced', unreadBefore > 0, `${unreadBefore} unread`);

await kojo.post('/api/premium/feed/read', {});
r = await kojo.get('/api/auth/me');
check('mark-all-read clears the count', (r.json?.feed_unread ?? -1) === 0);

// 4. premium gate ------------------------------------------------------------
console.log('\n4. Premium gate');
r = await kojo.get('/api/premium/playbooks');
const books = r.json?.playbooks ?? [];
check('playbook library loads', books.length > 0, `${books.length} playbook(s)`);
check('some playbooks are free', books.some((b) => !b.locked));
check('some playbooks are premium', books.some((b) => b.locked));

const lockedBook = books.find((b) => b.locked);
const freeBook = books.find((b) => !b.locked);

r = await kojo.get(`/api/premium/playbooks/${freeBook.slug}`);
const freeLen = r.json?.playbook?.body_md?.length ?? 0;
check('free playbook returns in full', r.json?.playbook?.locked === false && freeLen > 500,
  `${freeLen} chars`);
check('free playbook cites sources', (r.json?.playbook?.sources?.length ?? 0) > 0,
  `${r.json?.playbook?.sources?.length} source(s)`);

r = await kojo.get(`/api/premium/playbooks/${lockedBook.slug}`);
const previewLen = r.json?.playbook?.body_md?.length ?? 0;
check('premium playbook is truncated for free users', r.json?.playbook?.locked === true);
check('preview is a real preview, not empty', previewLen > 100, `${previewLen} chars`);

// 5. billing -----------------------------------------------------------------
console.log('\n5. Billing');
r = await kojo.get('/api/premium/billing/plans');
check('plans are listed', (r.json?.plans?.length ?? 0) === 2, `provider=${r.json?.provider}`);

r = await anon.post('/api/premium/billing/checkout', { plan: 'monthly' });
check('anonymous cannot check out', r.status === 401);

r = await kojo.post('/api/premium/billing/checkout', { plan: 'monthly' });
check('checkout succeeds', r.status === 200, r.json?.note ? 'stub provider' : r.json?.provider);
check('entitlement has an expiry date', Boolean(r.json?.period_end), r.json?.period_end?.slice(0, 10));

r = await kojo.get('/api/auth/me');
check('user is now entitled', r.json?.entitled === true);
check('tier_expires_at is set', Boolean(r.json?.user?.tier_expires_at));

r = await kojo.get('/api/premium/billing/history');
check('billing events are recorded', (r.json?.events?.length ?? 0) >= 2,
  (r.json?.events ?? []).map((e) => e.kind).join(', '));

// 6. unlocked ----------------------------------------------------------------
console.log('\n6. After upgrading');
r = await kojo.get('/api/premium/feed');
check('signals now readable', r.json?.items?.filter((i) => i.premium_only).every((i) => !i.locked));
check('signal bodies are present',
  r.json?.items?.filter((i) => i.premium_only).every((i) => i.body !== null));
check('locked_count drops to zero', r.json?.locked_count === 0);

r = await kojo.get(`/api/premium/playbooks/${lockedBook.slug}`);
const fullLen = r.json?.playbook?.body_md?.length ?? 0;
check('premium playbook returns in full', r.json?.playbook?.locked === false && fullLen > previewLen,
  `${previewLen} -> ${fullLen} chars`);

r = await kojo.get('/api/dashboard/ghana');
check('country dashboard signals unlock too', Array.isArray(r.json?.opportunities),
  `${r.json?.opportunities?.length} signal(s)`);

// 7. expiry ------------------------------------------------------------------
console.log('\n7. Expiry and cancellation');
r = await kojo.post('/api/premium/billing/cancel');
check('cancellation works', r.status === 200);
r = await kojo.get('/api/auth/me');
check('entitlement ends on cancel', r.json?.entitled === false);
r = await kojo.get('/api/dashboard/ghana');
check('signals re-lock after cancelling', r.json?.opportunities === null);

// 8. webhook -----------------------------------------------------------------
console.log('\n8. Webhook');
r = await anon.post('/api/premium/billing/webhook', { type: 'checkout.session.completed' });
check('webhook refuses without configuration', r.status === 503, r.json?.error);

// 9. rate limiting -----------------------------------------------------------
console.log('\n9. Rate limiting');
// Keyed on the account under attack, not the source IP, so this test is
// deterministic and does not depend on what earlier runs did from this address.
const victim = `victim${stamp}@example.com`;
const spam = new Client();
let limitHit = false;
let attempts = 0;
for (let i = 0; i < 14; i++) {
  attempts++;
  const res = await spam.post('/api/auth/login', { email: victim, password: 'wrongpassword' });
  if (res.status === 429) {
    limitHit = true;
    break;
  }
}
check('repeated failed logins lock the targeted account', limitHit,
  `blocked after ${attempts} attempts`);

// A different account from the same address must still work, otherwise one
// attacker could lock out everyone behind a shared connection.
const bystander = new Client();
r = await bystander.post('/api/auth/register', {
  email: `bystander${stamp}@example.com`,
  password: 'legitimate2026',
  full_name: 'Bystander',
});
check('a different account from the same IP is unaffected', r.status === 201,
  r.json?.error ?? 'registered fine');

// 10. unfollow ---------------------------------------------------------------
console.log('\n10. Unfollow');
r = await kojo.get('/api/premium/subscriptions');
const subId = r.json?.subscriptions?.[0]?.id;
r = await kojo.del(`/api/premium/subscriptions/${subId}`);
check('unfollow works', r.status === 200);
r = await kojo.get('/api/premium/subscriptions');
check('subscription removed', r.json?.subscriptions?.length === 1);
r = await kojo.del(`/api/premium/subscriptions/${subId}`);
check('unfollowing twice is a clean 404', r.status === 404);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
