/**
 * End-to-end check of company discovery against a running dev server.
 *   npx wrangler dev   (after db:migrate:local)
 *   node scripts/e2e-discovery.mjs
 */
import { BASE, Client, check, finish } from './e2e-lib.mjs';

const stamp = Date.now();
console.log(`\nTereflow discovery end-to-end  (${BASE})\n`);
const anon = new Client('anon');
async function member(name, hsCodes, published = true) {
  const c = new Client(name);
  await c.post('/api/auth/register', { email: `${name}${stamp}@example.com`, password: 'testing2026x', full_name: name });
  await c.put('/api/network/cards/me', { display_name: name, company: `${name} Ltd`, country_iso3: 'GHA', intents: ['seller'], hs_codes: hsCodes, sectors: [], target_markets: [], is_published: published });
  return c;
}
let r;

const heading = await member('heading', ['1801']);
const finer = await member('finer', ['18010010']);
const other = await member('other', ['2204']);
const words = await member('words', ['cocoa', 'moringa']);
const hidden = await member('hidden', ['1801'], false);
const seller = await member('seller', ['1801']);

r = await seller.post('/api/market/listings', { kind: 'for_sale', title: 'Cocoa beans 10t', description: 'Fermented', hs_code: '1801.00', country_iso3: 'GHA', price_usd: 9000 });
const listingId = r.json?.id;
r = await seller.post('/api/market/listings', { kind: 'for_sale', title: 'Red wine pallet', description: 'Case lots', hs_code: '2204', price_usd: 500 });
r = await seller.post('/api/market/listings', { kind: 'wanted', title: 'No code listing', description: 'Anything' });

console.log('1. Matching');
r = await anon.get('/api/discovery/180100');
const names = (r.json?.members ?? []).map((m) => m.display_name);
check('a member listing the heading matches', names.includes('heading'), names.join(','));
check('a member listing a finer line matches', names.includes('finer'));
check('a member listing a different product does not', !names.includes('other'));
check('words are not treated as codes', !names.includes('words'));
check('an unpublished card never appears', !names.includes('hidden'));
check('the scope and limits are always returned', r.json?.scope?.includes('not a register') && r.json?.limitations?.length >= 2);
const lt = (r.json?.listings ?? []).map((l) => l.title);
check('an open listing on the code matches (code typed with a dot)', lt.includes('Cocoa beans 10t'), lt.join(','));
check('a listing for another product does not', !lt.includes('Red wine pallet'));
check('a listing with no code does not', !lt.includes('No code listing'));

console.log('\n2. Privacy');
const m = r.json?.members?.[0];
check('no internal user id is exposed on members', m && !('user_id' in m) && !('email' in m), Object.keys(m ?? {}).join(','));
const l = r.json?.listings?.[0];
check('no owner id is exposed on listings', l && !('owner_id' in l), Object.keys(l ?? {}).join(','));

console.log('\n3. Edge cases');
r = await anon.get('/api/discovery/18');
check('a 2-digit code is refused', r.status === 400);
r = await anon.get('/api/discovery/abcd');
check('a non-numeric code is refused', r.status === 400);
r = await anon.get('/api/discovery/9999');
check('no match is an honest empty answer, not an error', r.status === 200 && r.json?.members?.length === 0 && r.json?.listings?.length === 0);
await seller.patch(`/api/market/listings/${listingId}`, { status: 'closed' });
r = await anon.get('/api/discovery/180100');
check('a closed listing disappears', !(r.json?.listings ?? []).some((x) => x.id === listingId));

finish();
