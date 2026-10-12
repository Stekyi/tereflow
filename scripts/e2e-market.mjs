/**
 * End-to-end check of notifications, Market Square listings, enquiries and auctions.
 *   npx wrangler dev   (after db:migrate:local)
 *   node scripts/e2e-market.mjs
 */
import { BASE, Client, check, finish, newMember } from './e2e-lib.mjs';

const stamp = Date.now();
console.log(`\nTereflow market end-to-end  (${BASE})\n`);
const { c: ama, id: amaId } = await newMember('ama', stamp);
const { c: kwesi, id: kwesiId } = await newMember('kwesi', stamp);
const { c: efua } = await newMember('efua', stamp);
const { c: yaw } = await newMember('yaw', stamp);
const anon = new Client('anon');
let r;
const inSeconds = (s) => new Date(Date.now() + s * 1000).toISOString();

console.log('1. Messaging: unread counts and notifications');
r = await anon.get('/api/notifications/count');
check('signed-out count refused', r.status === 401);
r = await ama.post('/api/network/conversations', { to_user_id: kwesiId, body: 'Hello Kwesi, do you buy moringa?' });
const convoId = r.json?.conversation_id;
check('Ama starts a conversation', r.status === 201 && convoId, r.json?.error);
await ama.post(`/api/network/conversations/${convoId}/messages`, { body: 'Second message' });
r = await kwesi.get('/api/notifications/count');
check('Kwesi has 2 unread messages and 1 notification (folded)', r.json?.messages === 2 && r.json?.notifications === 1, JSON.stringify(r.json));
r = await ama.get('/api/notifications/count');
check('Ama (the sender) has none', r.json?.messages === 0 && r.json?.notifications === 0, JSON.stringify(r.json));
r = await efua.get('/api/notifications');
check("a third user sees none of it", r.json?.notifications?.length === 0);
r = await kwesi.get(`/api/network/conversations/${convoId}/messages`);
check('Kwesi opens the thread', r.status === 200);
r = await kwesi.get('/api/notifications/count');
check('opening the thread clears both counts', r.json?.messages === 0 && r.json?.notifications === 0, JSON.stringify(r.json));
r = await efua.get(`/api/network/conversations/${convoId}/messages`);
check('a non-participant cannot read the thread (404)', r.status === 404);
r = await efua.post(`/api/network/conversations/${convoId}/messages`, { body: 'intruder' });
check('a non-participant cannot post to the thread (404)', r.status === 404);

console.log('\n2. Listings: validation and ownership');
const fixed = { kind: 'for_sale', title: 'Dried moringa leaf, 20t', description: 'Organic, EU certified', hs_code: '1211.90', country_iso3: 'GHA', price_usd: 1800 };
r = await anon.post('/api/market/listings', fixed);
check('signed-out cannot list', r.status === 401);
for (const [label, patch] of [['bad kind', { kind: 'bogus' }], ['short title', { title: 'ab' }], ['no description', { description: '' }], ['bad hs', { hs_code: 'abc' }], ['bad country', { country_iso3: 'GHAX' }], ['negative price', { price_usd: -5 }], ['zero price', { price_usd: 0 }], ['absurd price', { price_usd: 1e12 }]]) {
  r = await ama.post('/api/market/listings', { ...fixed, ...patch });
  check(`${label} refused`, r.status === 400, r.json?.error);
}
r = await ama.post('/api/market/listings', fixed);
const fixedId = r.json?.id;
check('Ama lists a product', r.status === 201 && fixedId, r.json?.error);
r = await kwesi.patch(`/api/market/listings/${fixedId}`, { title: 'hijacked title' });
check("another user cannot edit it (404)", r.status === 404);
r = await kwesi.del(`/api/market/listings/${fixedId}`);
check("another user cannot delete it (404)", r.status === 404);
r = await ama.patch(`/api/market/listings/${fixedId}`, { price_usd: 1700 });
check('owner edits the price', r.status === 200);
r = await anon.get(`/api/market/listings/${fixedId}`);
check('signed-out reader sees it, with the owner id withheld', r.status === 200 && r.json?.listing?.price_usd === 1700 && r.json.listing.owner_id === null, JSON.stringify(r.json?.listing?.owner_id));

console.log('\n3. Search, filters and pagination');
for (let i = 1; i <= 5; i++) await ama.post('/api/market/listings', { kind: 'wanted', title: `Wanted cocoa lot ${i}`, description: 'Need fermented beans', hs_code: '1801', country_iso3: 'GHA' });
r = await anon.get('/api/market/listings?q=moringa');
check('text search finds the moringa listing', r.json?.listings?.some((l) => l.id === fixedId));
r = await anon.get('/api/market/listings?q=%25');
check('a % in the search is literal, not a wildcard', r.status === 200 && r.json?.total === 0, String(r.json?.total));
r = await anon.get('/api/market/listings?kind=wanted&limit=2&page=1');
const p1 = r.json?.listings?.map((l) => l.id) ?? [];
r = await anon.get('/api/market/listings?kind=wanted&limit=2&page=2');
const p2 = r.json?.listings?.map((l) => l.id) ?? [];
check('pagination returns distinct pages', p1.length === 2 && p2.length === 2 && !p1.some((x) => p2.includes(x)), `${p1.length}/${p2.length}`);
check('total is reported', r.json?.total >= 5 && r.json?.limit === 2);
r = await anon.get('/api/market/listings?hs=1801');
check('HS filter matches by prefix', r.json?.total >= 5 && r.json.listings.every((l) => l.hs_code.startsWith('1801')));
r = await anon.get('/api/market/listings?kind=nonsense');
check('bad filter refused', r.status === 400);

console.log('\n4. Enquiries');
r = await ama.post(`/api/market/listings/${fixedId}/enquiries`, { body: 'me' });
check('cannot enquire on your own listing', r.status === 400);
r = await kwesi.post(`/api/market/listings/${fixedId}/enquiries`, { body: '' });
check('empty enquiry refused', r.status === 400);
r = await kwesi.post(`/api/market/listings/${fixedId}/enquiries`, { body: 'Can you ship 20t to Hamburg in November?' });
check('Kwesi enquires', r.status === 201 && r.json?.conversation_id, r.json?.error);
r = await ama.get('/api/notifications');
check('Ama is notified of the enquiry', r.json?.notifications?.some((n) => n.kind === 'enquiry' && n.body.includes('Dried moringa')), JSON.stringify(r.json?.notifications?.[0]));
r = await ama.get(`/api/market/listings/${fixedId}/enquiries`);
check('owner can read enquiries', r.json?.enquiries?.length === 1);
r = await kwesi.get(`/api/market/listings/${fixedId}/enquiries`);
check('a non-owner cannot read enquiries (404)', r.status === 404);

console.log('\n5. Auctions: creation rules');
const auction = { kind: 'for_sale', mode: 'auction', title: 'Shea butter pallet', description: 'Unrefined, 500kg', hs_code: '1515', country_iso3: 'GHA', start_price: 100, min_increment: 10, ends_at: inSeconds(3600) };
for (const [label, patch] of [['missing start price', { start_price: undefined }], ['missing increment', { min_increment: undefined }], ['end in the past', { ends_at: inSeconds(-60) }], ['end too far away', { ends_at: inSeconds(90 * 86400) }], ['bad end date', { ends_at: 'soon' }], ['wanted ad as auction', { kind: 'wanted' }]]) {
  r = await ama.post('/api/market/listings', { ...auction, ...patch });
  check(`${label} refused`, r.status === 400, r.json?.error);
}
r = await ama.post('/api/market/listings', auction);
const aucId = r.json?.id;
check('Ama opens an auction', r.status === 201 && aucId, r.json?.error);

console.log('\n6. Auctions: bid validation');
r = await ama.post(`/api/market/listings/${aucId}/bids`, { amount: 150 });
check('owner cannot bid on own auction', r.status === 403);
r = await anon.post(`/api/market/listings/${aucId}/bids`, { amount: 150 });
check('signed-out cannot bid', r.status === 401);
for (const a of ['abc', -5, 0, null, 1e12]) {
  r = await kwesi.post(`/api/market/listings/${aucId}/bids`, { amount: a });
  check(`invalid amount ${JSON.stringify(a)} refused`, r.status === 400);
}
r = await kwesi.post(`/api/market/listings/${aucId}/bids`, { amount: 99 });
check('bid under the start price refused, with the minimum', r.status === 409 && r.json?.minimum === 100, r.json?.error);
r = await kwesi.post(`/api/market/listings/${aucId}/bids`, { amount: 100 });
check('Kwesi bids the start price', r.status === 201, r.json?.error);
r = await kwesi.post(`/api/market/listings/${aucId}/bids`, { amount: 200 });
check('the leader cannot bid against themselves', r.status === 409);
r = await efua.post(`/api/market/listings/${aucId}/bids`, { amount: 105 });
check('a bid below current + increment refused', r.status === 409 && r.json?.minimum === 110, r.json?.error);
r = await efua.post(`/api/market/listings/${aucId}/bids`, { amount: 110 });
check('Efua outbids with exactly the minimum', r.status === 201, r.json?.error);
r = await kwesi.get('/api/notifications');
check('Kwesi is notified he was outbid', r.json?.notifications?.some((n) => n.kind === 'outbid'));
r = await efua.get(`/api/market/listings/${aucId}`);
check('Efua sees she is winning; bidder identity not exposed', r.json?.listing?.i_am_winning === true && r.json.listing.current_bid === 110 && !('current_bidder_id' in r.json.listing));
r = await kwesi.get(`/api/market/listings/${aucId}`);
check('Kwesi sees he is not winning', r.json?.listing?.i_am_winning === false);
r = await ama.patch(`/api/market/listings/${aucId}`, { status: 'closed' });
check('an auction with bids cannot be closed early', r.status === 409);
r = await ama.del(`/api/market/listings/${aucId}`);
check('an auction with bids cannot be deleted', r.status === 404);

console.log('\n7. Auctions: simultaneous bids');
const racers = await Promise.all(Array.from({ length: 8 }, (_, i) => newMember(`racer${i}`, stamp)));
r = await ama.post('/api/market/listings', { ...auction, title: 'Race lot', ends_at: inSeconds(3600) });
const raceId = r.json?.id;
const results = await Promise.all(racers.map(({ c }) => c.post(`/api/market/listings/${raceId}/bids`, { amount: 100 })));
const wins = results.filter((x) => x.status === 201).length;
check('eight identical simultaneous bids: exactly one wins', wins === 1, `${wins} accepted`);
r = await anon.get(`/api/market/listings/${raceId}`);
check('bid_count is 1 and the price is 100', r.json?.listing?.bid_count === 1 && r.json.listing.current_bid === 100, JSON.stringify([r.json?.listing?.bid_count, r.json?.listing?.current_bid]));
const next = await Promise.all(racers.map(({ c }, i) => c.post(`/api/market/listings/${raceId}/bids`, { amount: 110 + i * 10 })));
const accepted = next.filter((x) => x.status === 201).length;
r = await anon.get(`/api/market/listings/${raceId}`);
const final = r.json?.listing;
r = await anon.get(`/api/market/listings/${raceId}/bids`);
const hist = r.json?.bids ?? [];
check('mixed simultaneous bids: highest accepted amount is the current bid and the history is consistent',
  final.current_bid === Math.max(...hist.map((b) => b.amount)) && final.bid_count === hist.length && accepted >= 1,
  `accepted ${accepted}, current ${final.current_bid}, history ${hist.length}`);
check('history is strictly increasing with no duplicate amounts', new Set(hist.map((b) => b.amount)).size === hist.length);

console.log('\n8. Auctions: ending and settlement');
r = await ama.post('/api/market/listings', { ...auction, title: 'Short auction', ends_at: inSeconds(8) });
const shortId = r.json?.id;
r = await yaw.post(`/api/market/listings/${shortId}/bids`, { amount: 150 });
check('Yaw bids on the short auction', r.status === 201, r.json?.error);
await new Promise((res) => setTimeout(res, 9500));
r = await efua.post(`/api/market/listings/${shortId}/bids`, { amount: 500 });
check('a bid after the end is refused', r.status === 409 && /ended/i.test(r.json?.error ?? ''), r.json?.error);
r = await anon.get(`/api/market/listings/${shortId}`);
check('the auction is marked ended', r.json?.listing?.status === 'ended');
r = await yaw.get('/api/notifications');
check('the winner is notified', r.json?.notifications?.filter((n) => n.kind === 'auction_won').length === 1);
r = await ama.get('/api/notifications');
check('the seller is notified of the sale, once', r.json?.notifications?.filter((n) => n.kind === 'auction_sold').length === 1);
r = await anon.get(`/api/market/listings/${shortId}`);
r = await yaw.get('/api/notifications');
check('re-reading does not notify again', r.json?.notifications?.filter((n) => n.kind === 'auction_won').length === 1);
r = await ama.post('/api/market/listings', { ...auction, title: 'No-bid auction', ends_at: inSeconds(6) });
const noBidId = r.json?.id;
await new Promise((res) => setTimeout(res, 7500));
await anon.get(`/api/market/listings/${noBidId}`);
r = await ama.get('/api/notifications');
check('a no-bid auction tells the seller it ended', r.json?.notifications?.some((n) => n.kind === 'auction_ended'));

console.log('\n9. Notifications: ownership and read state');
r = await ama.get('/api/notifications');
const mine = r.json?.notifications?.[0];
r = await kwesi.post('/api/notifications/read', { ids: [mine.id] });
r = await ama.get('/api/notifications');
check("another user cannot mark my notification read", r.json?.notifications?.find((n) => n.id === mine.id)?.read_at == null);
r = await ama.post('/api/notifications/read', { ids: [mine.id] });
r = await ama.get('/api/notifications');
check('the owner can mark it read', r.json?.notifications?.find((n) => n.id === mine.id)?.read_at != null);
r = await ama.post('/api/notifications/read', {});
r = await ama.get('/api/notifications/count');
check('mark all read zeroes the count', r.json?.notifications === 0);

finish();
