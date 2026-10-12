import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { currentUser } from '../lib/session';
import { rateLimit, tooMany } from '../lib/ratelimit';
import { notify } from '../lib/notify';

/**
 * Market Square. Everything that changes money-adjacent state is decided in
 * SQL, not in JavaScript: a bid is one conditional UPDATE that only succeeds
 * if the auction is open, unexpired, not the bidder's own, and the amount beats
 * the current bid by the increment. Two bids landing together cannot both win,
 * because the second one's WHERE clause is evaluated against the first one's result.
 */
export const market = new Hono<{ Bindings: Env }>();

export const KINDS = ['for_sale', 'wanted', 'supplier_request', 'buyer_request', 'export_opportunity', 'partnership', 'service'] as const;
const HS = /^\d{2,10}$/;
const ISO3 = /^[A-Z]{3}$/;
const MAX_MONEY = 1_000_000_000;
const MIN_AUCTION_SECONDS = 5;
const MAX_AUCTION_DAYS = 30;
const PAGE_MAX = 50;

const money = (v: unknown): number | null => {
  const n = typeof v === 'number' ? v : typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN;
  if (!Number.isFinite(n) || n <= 0 || n > MAX_MONEY) return null;
  return Math.round(n * 100) / 100;
};
const stamp = (d: Date) => d.toISOString().slice(0, 19).replace('T', ' ');

interface ListingRow {
  id: string; owner_id: string; kind: string; title: string; description: string; hs_code: string; country_iso3: string;
  price_usd: number | null; mode: string; status: string; start_price: number | null; min_increment: number | null;
  ends_at: string | null; current_bid: number | null; current_bidder_id: string | null; bid_count: number;
  created_at: string; updated_at: string; owner_name?: string | null; owner_company?: string | null;
}

const SELECT_LISTING = `SELECT l.*, COALESCE(bc.display_name, u.full_name) AS owner_name, bc.company AS owner_company
  FROM listings l JOIN users u ON u.id = l.owner_id LEFT JOIN business_cards bc ON bc.user_id = l.owner_id`;

function toListing(r: ListingRow, viewerId: string | null) {
  const { current_bidder_id, owner_id, ...rest } = r;
  return {
    ...rest,
    owner_id: viewerId ? owner_id : null,
    is_owner: viewerId === owner_id,
    // Who is winning is private; a bidder is only told whether it is them.
    i_am_winning: viewerId != null && current_bidder_id === viewerId,
  };
}

/** Ends an expired auction exactly once and tells the people involved. Safe to call repeatedly. */
async function settle(env: Env, id: string): Promise<void> {
  const res = await env.DB.prepare(
    `UPDATE listings SET status = 'ended', updated_at = datetime('now')
      WHERE id = ? AND mode = 'auction' AND status = 'open' AND ends_at <= datetime('now')`,
  ).bind(id).run();
  if (!res.meta.changes) return;
  const l = await env.DB.prepare('SELECT owner_id, title, current_bid, current_bidder_id FROM listings WHERE id = ?')
    .bind(id).first<{ owner_id: string; title: string; current_bid: number | null; current_bidder_id: string | null }>();
  if (!l) return;
  if (l.current_bidder_id && l.current_bid != null) {
    await notify(env, l.current_bidder_id, 'auction_won', id, `You won "${l.title}" at $${l.current_bid.toFixed(2)}`);
    await notify(env, l.owner_id, 'auction_sold', id, `"${l.title}" sold for $${l.current_bid.toFixed(2)}`);
  } else {
    await notify(env, l.owner_id, 'auction_ended', id, `"${l.title}" ended with no bids`);
  }
}

async function settleDue(env: Env): Promise<void> {
  const { results } = await env.DB.prepare(
    `SELECT id FROM listings WHERE mode = 'auction' AND status = 'open' AND ends_at <= datetime('now') LIMIT 25`,
  ).all<{ id: string }>();
  for (const r of results) await settle(env, r.id);
}

// --- listings ---------------------------------------------------------------

market.post('/listings', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);
  const card = await c.env.DB.prepare('SELECT 1 AS ok FROM business_cards WHERE user_id = ? AND is_published = 1')
    .bind(user.id).first();
  if (!card) return bad('Publish your business card before listing', 403);

  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return bad('Send a JSON body');
  const kind = String(b.kind ?? '');
  if (!KINDS.includes(kind as (typeof KINDS)[number])) return bad('kind is not valid');
  const title = String(b.title ?? '').trim();
  if (title.length < 3 || title.length > 140) return bad('title must be 3 to 140 characters');
  const description = String(b.description ?? '').trim();
  if (!description || description.length > 4000) return bad('description is required, up to 4000 characters');
  const hs = String(b.hs_code ?? '').replace(/[\s.]/g, '');
  if (hs && !HS.test(hs)) return bad('hs_code must be 2 to 10 digits');
  const country = String(b.country_iso3 ?? '').trim().toUpperCase();
  if (country && !ISO3.test(country)) return bad('country_iso3 is not valid');
  const mode = b.mode === 'auction' ? 'auction' : 'fixed';

  let price: number | null = null;
  if (b.price_usd != null && b.price_usd !== '') {
    price = money(b.price_usd);
    if (price == null) return bad('price_usd must be a positive amount');
  }

  let start: number | null = null, inc: number | null = null, endsAt: string | null = null;
  if (mode === 'auction') {
    if (kind !== 'for_sale') return bad('Only items for sale can be auctioned');
    start = money(b.start_price);
    inc = money(b.min_increment);
    if (start == null || inc == null) return bad('An auction needs a start_price and min_increment');
    const end = new Date(String(b.ends_at ?? ''));
    if (Number.isNaN(end.getTime())) return bad('ends_at must be a date and time');
    const secs = (end.getTime() - Date.now()) / 1000;
    if (secs < MIN_AUCTION_SECONDS) return bad('The auction must end in the future');
    if (secs > MAX_AUCTION_DAYS * 86400) return bad(`An auction can run for at most ${MAX_AUCTION_DAYS} days`);
    endsAt = stamp(end);
  }

  const id = uid('lst_');
  await c.env.DB.prepare(
    `INSERT INTO listings (id, owner_id, kind, title, description, hs_code, country_iso3, price_usd, mode, start_price, min_increment, ends_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).bind(id, user.id, kind, title, description, hs, country, price, mode, start, inc, endsAt).run();
  return json({ id }, 201);
});

market.get('/listings', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  await settleDue(c.env);
  const q = (c.req.query('q') ?? '').trim().slice(0, 80);
  const kind = c.req.query('kind') ?? '';
  const hs = (c.req.query('hs') ?? '').replace(/[\s.]/g, '');
  const country = (c.req.query('country') ?? '').toUpperCase();
  const mode = c.req.query('mode') ?? '';
  const status = c.req.query('status') === 'ended' ? 'ended' : 'open';
  const page = Math.max(1, Math.floor(Number(c.req.query('page')) || 1));
  const limit = Math.min(PAGE_MAX, Math.max(1, Math.floor(Number(c.req.query('limit')) || 20)));

  const where: string[] = ['l.status = ?'];
  const vals: unknown[] = [status];
  if (kind) { if (!KINDS.includes(kind as (typeof KINDS)[number])) return bad('kind is not valid'); where.push('l.kind = ?'); vals.push(kind); }
  if (hs) { if (!HS.test(hs)) return bad('hs must be 2 to 10 digits'); where.push('l.hs_code LIKE ?'); vals.push(`${hs}%`); }
  if (country) { if (!ISO3.test(country)) return bad('country is not valid'); where.push('l.country_iso3 = ?'); vals.push(country); }
  if (mode === 'auction' || mode === 'fixed') { where.push('l.mode = ?'); vals.push(mode); }
  if (q) {
    const like = `%${q.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    where.push(`(l.title LIKE ? ESCAPE '\\' OR l.description LIKE ? ESCAPE '\\')`);
    vals.push(like, like);
  }
  const clause = where.join(' AND ');
  const total = await c.env.DB.prepare(`SELECT COUNT(*) AS n FROM listings l WHERE ${clause}`).bind(...vals).first<{ n: number }>();
  const { results } = await c.env.DB.prepare(`${SELECT_LISTING} WHERE ${clause} ORDER BY l.created_at DESC, l.id DESC LIMIT ? OFFSET ?`)
    .bind(...vals, limit, (page - 1) * limit).all<ListingRow>();
  return json({ listings: results.map((r) => toListing(r, user?.id ?? null)), total: total?.n ?? 0, page, limit });
});

market.get('/listings/mine', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  await settleDue(c.env);
  const { results } = await c.env.DB.prepare(`${SELECT_LISTING} WHERE l.owner_id = ? ORDER BY l.created_at DESC LIMIT 100`)
    .bind(user.id).all<ListingRow>();
  return json({ listings: results.map((r) => toListing(r, user.id)) });
});

market.get('/listings/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  await settle(c.env, c.req.param('id'));
  const r = await c.env.DB.prepare(`${SELECT_LISTING} WHERE l.id = ?`).bind(c.req.param('id')).first<ListingRow>();
  if (!r) return bad('Listing not found', 404);
  return json({ listing: toListing(r, user?.id ?? null) });
});

market.patch('/listings/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const id = c.req.param('id');
  const cur = await c.env.DB.prepare('SELECT owner_id, mode, status, bid_count FROM listings WHERE id = ?')
    .bind(id).first<{ owner_id: string; mode: string; status: string; bid_count: number }>();
  if (!cur || cur.owner_id !== user.id) return bad('Listing not found', 404);
  const b = (await c.req.json().catch(() => null)) as Record<string, unknown> | null;
  if (!b) return bad('Send a JSON body');
  const sets: string[] = []; const vals: unknown[] = [];
  if ('title' in b) { const t = String(b.title ?? '').trim(); if (t.length < 3 || t.length > 140) return bad('title must be 3 to 140 characters'); sets.push('title = ?'); vals.push(t); }
  if ('description' in b) { const d = String(b.description ?? '').trim(); if (!d || d.length > 4000) return bad('description is required, up to 4000 characters'); sets.push('description = ?'); vals.push(d); }
  if ('price_usd' in b) {
    if (cur.mode === 'auction') return bad('An auction has no fixed price');
    const p = b.price_usd == null ? null : money(b.price_usd);
    if (b.price_usd != null && p == null) return bad('price_usd must be a positive amount');
    sets.push('price_usd = ?'); vals.push(p);
  }
  if ('status' in b) {
    if (b.status !== 'closed') return bad('status can only be set to closed');
    if (cur.mode === 'auction' && cur.bid_count > 0) return bad('An auction with bids cannot be closed early', 409);
    sets.push("status = 'closed'");
  }
  if (!sets.length) return bad('Nothing to update');
  if (cur.mode === 'auction' && cur.bid_count > 0 && ('title' in b || 'description' in b)) return bad('An auction with bids cannot be edited', 409);
  await c.env.DB.prepare(`UPDATE listings SET ${sets.join(', ')}, updated_at = datetime('now') WHERE id = ? AND owner_id = ?`)
    .bind(...vals, id, user.id).run();
  return json({ updated: true });
});

market.delete('/listings/:id', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const res = await c.env.DB.prepare('DELETE FROM listings WHERE id = ? AND owner_id = ? AND bid_count = 0')
    .bind(c.req.param('id'), user.id).run();
  if (!res.meta.changes) return bad('Listing not found, or it already has bids', 404);
  return json({ deleted: true });
});

// --- enquiries ---------------------------------------------------------------

market.post('/listings/:id/enquiries', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);
  const l = await c.env.DB.prepare('SELECT id, owner_id, title, status FROM listings WHERE id = ?')
    .bind(c.req.param('id')).first<{ id: string; owner_id: string; title: string; status: string }>();
  if (!l) return bad('Listing not found', 404);
  if (l.owner_id === user.id) return bad('You cannot enquire about your own listing');
  if (l.status !== 'open') return bad('This listing is no longer open', 409);
  const b = (await c.req.json().catch(() => null)) as { body?: string } | null;
  const text = String(b?.body ?? '').trim();
  if (!text) return bad('Write your enquiry first');
  if (text.length > 4000) return bad('Enquiries are limited to 4000 characters');

  const [a, z] = user.id < l.owner_id ? [user.id, l.owner_id] : [l.owner_id, user.id];
  let convo = await c.env.DB.prepare('SELECT id FROM conversations WHERE a_user_id = ? AND b_user_id = ?').bind(a, z).first<{ id: string }>();
  if (!convo) {
    const cid = uid('con_');
    await c.env.DB.prepare('INSERT INTO conversations (id, a_user_id, b_user_id, subject) VALUES (?, ?, ?, ?)').bind(cid, a, z, l.title.slice(0, 140)).run();
    convo = { id: cid };
  }
  const mid = uid('msg_'); const eid = uid('enq_');
  await c.env.DB.batch([
    c.env.DB.prepare('INSERT INTO messages (id, conversation_id, sender_id, body) VALUES (?, ?, ?, ?)').bind(mid, convo.id, user.id, `Re: ${l.title}\n\n${text}`),
    c.env.DB.prepare("UPDATE conversations SET last_message_at = datetime('now') WHERE id = ?").bind(convo.id),
    c.env.DB.prepare('INSERT INTO enquiries (id, listing_id, from_user_id, conversation_id, body) VALUES (?, ?, ?, ?, ?)').bind(eid, l.id, user.id, convo.id, text),
  ]);
  await notify(c.env, l.owner_id, 'enquiry', convo.id, `Enquiry about "${l.title}"`);
  return json({ id: eid, conversation_id: convo.id }, 201);
});

market.get('/listings/:id/enquiries', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const own = await c.env.DB.prepare('SELECT 1 AS ok FROM listings WHERE id = ? AND owner_id = ?').bind(c.req.param('id'), user.id).first();
  if (!own) return bad('Listing not found', 404);
  const { results } = await c.env.DB.prepare(
    `SELECT e.id, e.body, e.created_at, e.conversation_id, COALESCE(bc.display_name, u.full_name) AS from_name
       FROM enquiries e JOIN users u ON u.id = e.from_user_id LEFT JOIN business_cards bc ON bc.user_id = u.id
      WHERE e.listing_id = ? ORDER BY e.created_at DESC LIMIT 100`,
  ).bind(c.req.param('id')).all();
  return json({ enquiries: results });
});

// --- auctions ---------------------------------------------------------------

market.post('/listings/:id/bids', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user) return bad('Sign in first', 401);
  const limited = await rateLimit(c.env, 'message', user.id);
  if (!limited.ok) return tooMany(limited);
  const id = c.req.param('id');
  const b = (await c.req.json().catch(() => null)) as { amount?: unknown } | null;
  const amount = money(b?.amount);
  if (amount == null) return bad('amount must be a positive number');

  await settle(c.env, id);
  const before = await c.env.DB.prepare('SELECT current_bidder_id, title FROM listings WHERE id = ?')
    .bind(id).first<{ current_bidder_id: string | null; title: string }>();

  // One statement decides everything. If any condition fails, nothing changes.
  const res = await c.env.DB.prepare(
    `UPDATE listings
        SET current_bid = ?1, current_bidder_id = ?2, bid_count = bid_count + 1, updated_at = datetime('now')
      WHERE id = ?3 AND mode = 'auction' AND status = 'open' AND ends_at > datetime('now')
        AND owner_id <> ?2
        AND (current_bidder_id IS NULL OR current_bidder_id <> ?2)
        AND ((current_bid IS NULL AND ?1 >= start_price) OR (current_bid IS NOT NULL AND ?1 >= current_bid + min_increment))`,
  ).bind(amount, user.id, id).run();

  if (!res.meta.changes) {
    const l = await c.env.DB.prepare('SELECT owner_id, mode, status, ends_at, start_price, min_increment, current_bid, current_bidder_id FROM listings WHERE id = ?')
      .bind(id).first<{ owner_id: string; mode: string; status: string; ends_at: string | null; start_price: number; min_increment: number; current_bid: number | null; current_bidder_id: string | null }>();
    if (!l) return bad('Listing not found', 404);
    if (l.mode !== 'auction') return bad('This listing is not an auction', 409);
    if (l.owner_id === user.id) return bad('You cannot bid on your own auction', 403);
    if (l.status !== 'open' || (l.ends_at && l.ends_at <= stamp(new Date()))) return bad('This auction has ended', 409);
    if (l.current_bidder_id === user.id) return bad('You are already the highest bidder', 409);
    const min = l.current_bid == null ? l.start_price : l.current_bid + l.min_increment;
    return json({ error: `Bid at least $${min.toFixed(2)}`, minimum: Math.round(min * 100) / 100 }, 409);
  }

  await c.env.DB.prepare('INSERT OR IGNORE INTO bids (id, listing_id, bidder_id, amount) VALUES (?, ?, ?, ?)')
    .bind(uid('bid_'), id, user.id, amount).run();
  if (before?.current_bidder_id && before.current_bidder_id !== user.id) {
    await notify(c.env, before.current_bidder_id, 'outbid', id, `You were outbid on "${before.title}"`);
  }
  return json({ ok: true, current_bid: amount }, 201);
});

/** Bid history with bidders anonymised; each caller only sees which bids were theirs. */
market.get('/listings/:id/bids', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  const { results } = await c.env.DB.prepare('SELECT bidder_id, amount, created_at FROM bids WHERE listing_id = ? ORDER BY amount DESC LIMIT 50')
    .bind(c.req.param('id')).all<{ bidder_id: string; amount: number; created_at: string }>();
  return json({ bids: results.map((r) => ({ amount: r.amount, created_at: r.created_at, mine: !!user && r.bidder_id === user.id })) });
});
