/**
 * End-to-end check of follows, posts, the feed and saved opportunities.
 *   npx wrangler dev   (another terminal, after db:migrate:local)
 *   node scripts/e2e-social.mjs
 */
import { BASE, Client, check, finish, newMember } from './e2e-lib.mjs';

const stamp = Date.now();
console.log(`\nTereflow social end-to-end  (${BASE})\n`);

const { c: ama, id: amaId } = await newMember('ama', stamp);
const { c: kwesi, id: kwesiId } = await newMember('kwesi', stamp);
const anon = new Client('anon');
const { c: lurker } = await newMember('lurker', stamp);
let r;

console.log('1. Signed-out access is refused');
for (const [m, p] of [['post', `/api/social/follow/${kwesiId}`], ['get', '/api/social/feed'], ['get', '/api/social/saved'], ['post', '/api/social/posts'], ['post', '/api/social/saved']]) {
  r = await anon[m](p, m === 'post' ? {} : undefined);
  check(`${m.toUpperCase()} ${p.split('/').slice(0, 4).join('/')} -> 401`, r.status === 401, String(r.status));
}

console.log('\n2. Following');
r = await ama.post(`/api/social/follow/${amaId}`);
check('cannot follow yourself', r.status === 400, r.json?.error);
r = await ama.post('/api/social/follow/usr_does_not_exist');
check('cannot follow a missing profile', r.status === 404);
r = await ama.post(`/api/social/follow/${kwesiId}`);
check('Ama follows Kwesi', r.status === 200 && r.json?.following === true);
r = await ama.post(`/api/social/follow/${kwesiId}`);
check('following twice is harmless', r.status === 200);
r = await ama.get(`/api/social/profile/${kwesiId}/stats`);
check('stats show one follower and am_following', r.json?.followers === 1 && r.json?.am_following === true, JSON.stringify(r.json));
r = await ama.get('/api/social/following');
check('following list has Kwesi', r.json?.following?.length === 1 && r.json.following[0].display_name === 'kwesi');

console.log('\n3. Posts and the feed');
r = await kwesi.post('/api/social/posts', { body: '' });
check('empty post refused', r.status === 400);
r = await kwesi.post('/api/social/posts', { body: 'x'.repeat(2001) });
check('over-long post refused', r.status === 400);
r = await kwesi.post('/api/social/posts', { body: 'Looking for moringa', hs_code: 'abc' });
check('bad hs_code refused', r.status === 400);
r = await kwesi.post('/api/social/posts', { body: 'Looking for moringa powder, two containers a month', hs_code: '1211.90' });
const postId = r.json?.id;
check('Kwesi posts', r.status === 201 && postId, r.json?.error);
r = await ama.get('/api/social/feed');
check('follower sees the post in the feed', r.json?.posts?.some((p) => p.id === postId));
r = await lurker.get('/api/social/feed');
check('a non-follower does not see it', !r.json?.posts?.some((p) => p.id === postId));
r = await ama.del(`/api/social/posts/${postId}`);
check('only the author can delete a post', r.status === 404);
r = await kwesi.del(`/api/social/posts/${postId}`);
check('author deletes the post', r.status === 200);
r = await ama.del(`/api/social/follow/${kwesiId}`);
check('unfollow works', r.json?.following === false);

console.log('\n4. Saved opportunities: validation');
const good = { country_slug: 'ghana', partner_iso3: 'nld', hs_code: '1801.00', flow: 'export', title: 'Cocoa beans to the Netherlands' };
for (const [label, patch] of [['bad slug', { country_slug: '../x' }], ['bad partner', { partner_iso3: 'NLDX' }], ['bad hs', { hs_code: 'abc' }], ['bad flow', { flow: 'sideways' }], ['no title', { title: '' }]]) {
  r = await ama.post('/api/social/saved', { ...good, ...patch });
  check(`${label} refused`, r.status === 400, r.json?.error);
}
r = await ama.post('/api/social/saved', good);
const savedId = r.json?.id;
check('saves an opportunity', r.status === 201 && savedId, r.json?.error);
r = await ama.post('/api/social/saved', good);
check('duplicate refused', r.status === 409);

console.log('\n5. Saved opportunities: privacy and ownership');
r = await ama.patch(`/api/social/saved/${savedId}`, { status: 'researching', notes: 'Call importer on Tuesday', research_links: ['https://example.com/report'] });
check('owner updates status, notes and links', r.status === 200, r.json?.error);
r = await ama.patch(`/api/social/saved/${savedId}`, { status: 'bogus' });
check('bad status refused', r.status === 400);
r = await ama.patch(`/api/social/saved/${savedId}`, { research_links: ['javascript:alert(1)'] });
check('non-http link refused', r.status === 400);
r = await ama.patch(`/api/social/saved/${savedId}`, {});
check('empty update refused', r.status === 400);
r = await kwesi.get('/api/social/saved');
check("another user's list does not include it", (r.json?.saved ?? []).length === 0);
r = await kwesi.patch(`/api/social/saved/${savedId}`, { notes: 'hijack' });
check("another user cannot edit it (404)", r.status === 404);
r = await kwesi.del(`/api/social/saved/${savedId}`);
check("another user cannot delete it (404)", r.status === 404);
r = await ama.get('/api/social/saved');
const row = r.json?.saved?.[0];
check('owner still has notes, status and normalised fields', row?.notes === 'Call importer on Tuesday' && row?.status === 'researching' && row?.partner_iso3 === 'NLD' && row?.hs_code === '180100', JSON.stringify(row ?? {}).slice(0, 120));
check('links persisted as an array', Array.isArray(row?.research_links) && row.research_links[0].startsWith('https://example.com'));
r = await ama.del(`/api/social/saved/${savedId}`);
check('owner deletes it', r.status === 200);

finish();
