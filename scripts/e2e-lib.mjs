/**
 * Shared helpers for end-to-end checks against a running dev server.
 *   TF_BASE defaults to http://127.0.0.1:8787
 */
export const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';

let passed = 0;
let failed = 0;

export function check(label, condition, detail = '') {
  if (condition) { passed++; console.log(`  PASS  ${label}${detail ? ` - ${detail}` : ''}`); }
  else { failed++; console.log(`  FAIL  ${label}${detail ? ` - ${detail}` : ''}`); }
}

export function finish() {
  console.log(`\n${passed} passed, ${failed} failed\n`);
  process.exit(failed === 0 ? 0 : 1);
}

export class Client {
  constructor(name) { this.name = name; this.cookies = new Map(); }
  async req(path, { method = 'GET', body } = {}) {
    const h = new Headers({ accept: 'application/json' });
    if (body !== undefined) h.set('content-type', 'application/json');
    if (this.cookies.size) h.set('cookie', [...this.cookies].map(([k, v]) => `${k}=${v}`).join('; '));
    const res = await fetch(`${BASE}${path}`, { method, headers: h, body: body !== undefined ? JSON.stringify(body) : undefined, redirect: 'manual' });
    for (const raw of res.headers.getSetCookie?.() ?? []) {
      const [pair] = raw.split(';');
      const i = pair.indexOf('=');
      const k = pair.slice(0, i).trim();
      const v = pair.slice(i + 1).trim();
      if (v === '') this.cookies.delete(k); else this.cookies.set(k, v);
    }
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch { json = { _raw: text.slice(0, 200) }; }
    return { status: res.status, json };
  }
  get(p) { return this.req(p); }
  post(p, body) { return this.req(p, { method: 'POST', body: body ?? {} }); }
  put(p, body) { return this.req(p, { method: 'PUT', body }); }
  patch(p, body) { return this.req(p, { method: 'PATCH', body }); }
  del(p) { return this.req(p, { method: 'DELETE' }); }
}

/** Registers a user, publishes a card, and returns the client and its user id. */
export async function newMember(name, stamp, country = 'GHA') {
  const c = new Client(name);
  const r = await c.post('/api/auth/register', { email: `${name}${stamp}@example.com`, password: 'testing2026x', full_name: name });
  const id = r.json?.user?.id;
  await c.put('/api/network/cards/me', {
    display_name: name, company: `${name} Ltd`, headline: 'Trader', country_iso3: country,
    intents: ['buyer'], sectors: [], hs_codes: [], target_markets: [], is_published: true,
  });
  return { c, id };
}
