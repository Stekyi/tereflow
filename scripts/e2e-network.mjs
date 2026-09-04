/**
 * End-to-end check of the network layer against a running dev server.
 *   npx wrangler dev      (in one terminal)
 *   node scripts/e2e-network.mjs
 */
const BASE = process.env.TA_BASE ?? 'http://127.0.0.1:8787';

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

/** Minimal cookie jar so two users can hold separate sessions. */
class Client {
  constructor(name) {
    this.name = name;
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
      const idx = pair.indexOf('=');
      const k = pair.slice(0, idx).trim();
      const v = pair.slice(idx + 1).trim();
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
  get(p) {
    return this.req(p);
  }
  post(p, body) {
    return this.req(p, { method: 'POST', body });
  }
  put(p, body) {
    return this.req(p, { method: 'PUT', body });
  }
}

const stamp = Date.now();
const ama = new Client('ama');
const kwesi = new Client('kwesi');

console.log(`\nTradeAtlas network end-to-end  (${BASE})\n`);

// 1. registration ------------------------------------------------------------
console.log('1. Registration');
let r = await ama.post('/api/auth/register', {
  email: `ama${stamp}@example.com`,
  password: 'moringa2026',
  full_name: 'Ama Boateng',
});
check('Ama registers', r.status === 201 && r.json?.user?.id, r.json?.error ?? r.json?.user?.full_name);
check('session cookie issued', ama.cookies.has('ta_session'));
check('new users start free', r.json?.user?.tier === 'free');

r = await kwesi.post('/api/auth/register', {
  email: `kwesi${stamp}@example.com`,
  password: 'importer2026',
  full_name: 'Kwesi Mensah',
});
const kwesiUserId = r.json?.user?.id;
check('Kwesi registers', r.status === 201, r.json?.error ?? 'ok');

// 2. business cards ----------------------------------------------------------
console.log('\n2. Business cards');
r = await ama.put('/api/network/cards/me', {
  display_name: 'Ama Boateng',
  company: 'Boateng Agro Ltd',
  headline: 'Moringa and shea butter grower, Northern Ghana',
  bio: 'Two containers a month, EU organic certified.',
  country_iso3: 'GHA',
  city: 'Tamale',
  intents: ['seller', 'supplier'],
  sectors: ['Agriculture & food'],
  hs_codes: ['moringa', 'shea butter', '12'],
  target_markets: ['DEU', 'NLD', 'USA'],
  is_published: true,
});
const amaCard = r.json?.card;
check('Ama publishes a card', r.status === 200 && amaCard?.is_published === 1, r.json?.error ?? amaCard?.id);
check('intents round-trip as an array', Array.isArray(amaCard?.intents) && amaCard.intents.length === 2);
check('hs codes round-trip', amaCard?.hs_codes?.includes('moringa'));

r = await kwesi.put('/api/network/cards/me', {
  display_name: 'Kwesi Mensah',
  company: 'Rhein Naturals GmbH',
  headline: 'Sourcing West African botanicals for EU retail',
  country_iso3: 'DEU',
  city: 'Hamburg',
  intents: ['buyer', 'distributor'],
  sectors: ['Agriculture & food', 'Consumer goods'],
  hs_codes: ['moringa', 'cocoa'],
  target_markets: ['GHA', 'CIV', 'NGA'],
  is_published: true,
});
check('Kwesi publishes a card', r.status === 200, r.json?.error ?? 'ok');

r = await ama.put('/api/network/cards/me', {
  display_name: 'Ama Boateng',
  country_iso3: 'GHA',
  intents: [],
});
check('card requires at least one intent', r.status === 400, r.json?.error);

// restore Ama's card after the rejected save
await ama.put('/api/network/cards/me', {
  display_name: 'Ama Boateng',
  company: 'Boateng Agro Ltd',
  headline: 'Moringa and shea butter grower, Northern Ghana',
  bio: 'Two containers a month, EU organic certified.',
  country_iso3: 'GHA',
  city: 'Tamale',
  intents: ['seller', 'supplier'],
  sectors: ['Agriculture & food'],
  hs_codes: ['moringa', 'shea butter', '12'],
  target_markets: ['DEU', 'NLD', 'USA'],
  is_published: true,
});

// 3. discovery ---------------------------------------------------------------
console.log('\n3. Discovery');
r = await kwesi.get('/api/network/cards?q=moringa');
check(
  'full-text search finds Ama',
  r.json?.cards?.some((c) => c.display_name === 'Ama Boateng'),
  `${r.json?.count} result(s)`,
);

r = await kwesi.get('/api/network/cards?intent=seller');
check(
  'intent filter returns sellers only',
  r.json?.cards?.length > 0 && r.json.cards.every((c) => c.intents.includes('seller')),
  `${r.json?.count} seller(s)`,
);

r = await kwesi.get('/api/network/cards?intent=buyer');
check(
  'intent filter excludes non-buyers',
  r.json?.cards?.every((c) => c.intents.includes('buyer')),
  `${r.json?.count} buyer(s)`,
);

r = await kwesi.get('/api/network/cards?country=GHA');
check('country filter works', r.json?.cards?.every((c) => c.country_iso3 === 'GHA'));

r = await kwesi.get('/api/network/cards?q=shea+butter');
check('multi-word search works', r.json?.count > 0, `${r.json?.count} result(s)`);

r = await kwesi.get('/api/network/cards?q=' + encodeURIComponent('"))nonsense*('));
check('malformed search does not 500', r.status === 200, `status ${r.status}`);

const amaUserId = amaCard.user_id;

// 4. messaging ---------------------------------------------------------------
console.log('\n4. Messaging');
r = await kwesi.post('/api/network/conversations', {
  to_user_id: amaUserId,
  body: 'Hi Ama — we buy moringa leaf powder for EU retail. What monthly volume can you do?',
});
const convId = r.json?.conversation_id;
check('Kwesi opens a conversation', r.status === 201 && convId, r.json?.error ?? convId);

r = await kwesi.post('/api/network/conversations', { to_user_id: amaUserId });
check('re-contacting reuses the same thread', r.json?.conversation_id === convId);

r = await ama.get('/api/auth/me');
check('Ama has 1 unread', r.json?.unread === 1, `unread=${r.json?.unread}`);

r = await ama.get('/api/network/conversations');
check('thread appears in Ama inbox', r.json?.conversations?.[0]?.other_name === 'Kwesi Mensah');
check('inbox shows unread count', r.json?.conversations?.[0]?.unread === 1);
check(
  'inbox shows last message preview',
  (r.json?.conversations?.[0]?.last_message ?? '').startsWith('Hi Ama'),
);

r = await ama.get(`/api/network/conversations/${convId}/messages`);
check('Ama can read the thread', r.json?.messages?.length === 1, `${r.json?.messages?.length} message(s)`);
check('sender attribution is correct', r.json?.messages?.[0]?.mine === false);

r = await ama.get('/api/auth/me');
check('opening the thread clears unread', r.json?.unread === 0, `unread=${r.json?.unread}`);

r = await ama.post(`/api/network/conversations/${convId}/messages`, {
  body: 'Hi Kwesi. Two 20ft containers a month, EU organic certified. Sample pack this week.',
});
check('Ama replies', r.status === 201, r.json?.error ?? 'ok');

r = await kwesi.get('/api/auth/me');
check('Kwesi now has 1 unread', r.json?.unread === 1, `unread=${r.json?.unread}`);

// 5. ratings -----------------------------------------------------------------
console.log('\n5. Ratings');
r = await kwesi.post('/api/network/ratings', {
  subject_id: amaUserId,
  score: 5,
  dealt_in: 'Moringa leaf powder',
  comment: 'Fast replies, sent certification without being chased.',
});
check('Kwesi rates Ama', r.status === 201, r.json?.error ?? 'ok');

r = await kwesi.get(`/api/network/cards/${amaCard.id}`);
check('rating average updates', r.json?.card?.rating_avg === 5 && r.json?.card?.rating_count === 1,
  `avg=${r.json?.card?.rating_avg} n=${r.json?.card?.rating_count}`);
check('rating appears on the card', r.json?.ratings?.[0]?.dealt_in === 'Moringa leaf powder');

r = await kwesi.post('/api/network/ratings', { subject_id: amaUserId, score: 3 });
check('re-rating updates rather than duplicates', r.status === 201);
r = await kwesi.get(`/api/network/cards/${amaCard.id}`);
check('count stays at 1 after re-rating', r.json?.card?.rating_count === 1,
  `avg=${r.json?.card?.rating_avg} n=${r.json?.card?.rating_count}`);

// 6. guardrails --------------------------------------------------------------
console.log('\n6. Guardrails');

// A real third party who has never spoken to Kwesi, so the "must have dealt"
// rule is actually exercised rather than tripping the "no such user" check.
const yaw = new Client('yaw');
r = await yaw.post('/api/auth/register', {
  email: `yaw${stamp}@example.com`,
  password: 'logistics2026',
  full_name: 'Yaw Owusu',
});
const yawUserId = r.json?.user?.id;
r = await kwesi.post('/api/network/ratings', { subject_id: yawUserId, score: 5 });
check('cannot rate someone you never messaged', r.status === 403, r.json?.error);

r = await kwesi.post('/api/network/ratings', { subject_id: kwesiUserId, score: 5 });
check('cannot rate yourself', r.status === 400, r.json?.error);

r = await ama.post('/api/network/conversations', { to_user_id: amaUserId });
check('cannot message yourself', r.status === 400, r.json?.error);

r = await yaw.get(`/api/network/conversations/${convId}/messages`);
check('third party cannot read a thread they are not in', r.status === 404, `status ${r.status}`);

const anon = new Client('anon');
r = await anon.put('/api/network/cards/me', {
  display_name: 'Nobody',
  country_iso3: 'GHA',
  intents: ['buyer'],
});
check('anonymous cannot save a card', r.status === 401, r.json?.error);

r = await anon.get('/api/network/conversations');
check('anonymous cannot read conversations', r.status === 401);

r = await anon.get(`/api/network/conversations/${convId}/messages`);
check('outsider cannot read someone else thread', r.status >= 400, `status ${r.status}`);

r = await anon.post('/api/auth/register', {
  email: `weak${stamp}@example.com`,
  password: '1234',
  full_name: 'Weak',
});
check('weak password rejected', r.status === 400, r.json?.error);

r = await anon.post('/api/auth/register', {
  email: `ama${stamp}@example.com`,
  password: 'moringa2026',
  full_name: 'Impostor',
});
check('duplicate email rejected', r.status === 409, r.json?.error);

r = await anon.post('/api/auth/login', {
  email: `ama${stamp}@example.com`,
  password: 'definitelywrong',
});
check('bad password rejected', r.status === 401, r.json?.error);
check('login error does not leak account existence', r.json?.error === 'Email or password is not right');

// 7. premium gate ------------------------------------------------------------
console.log('\n7. Premium gate');
r = await kwesi.req('/api/dashboard/ghana', { headers: { 'x-ta-tier': 'premium' } });
check(
  'spoofed header cannot unlock premium',
  r.json?.opportunities === null,
  `locked_count=${r.json?.opportunities_locked}`,
);

await kwesi.post('/api/auth/tier', { tier: 'premium' });
r = await kwesi.get('/api/dashboard/ghana');
check(
  'real upgrade unlocks signals',
  Array.isArray(r.json?.opportunities) && r.json.opportunities.length > 0,
  `${r.json?.opportunities?.length} signal(s)`,
);

r = await anon.get('/api/dashboard/ghana');
check('signed-out users see the locked state', r.json?.opportunities === null);
check('public trade data stays public', r.json?.overview?.export_usd > 0,
  `exports=$${((r.json?.overview?.export_usd ?? 0) / 1e9).toFixed(1)}bn`);

// 8. sign out ----------------------------------------------------------------
console.log('\n8. Sign out');
await kwesi.post('/api/auth/logout');
r = await kwesi.get('/api/auth/me');
check('logout ends the session', r.json?.user === null);

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
