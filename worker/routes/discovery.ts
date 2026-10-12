import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { currentUser } from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { codeCovers, cleanCode, DISCOVERY_LIMITATIONS, DISCOVERY_SCOPE, type DiscoveryResult } from '../../shared/discovery';

/** Who on Tereflow deals in a product: published members and open listings. Reads only. */
export const discovery = new Hono<{ Bindings: Env }>();

const MAX_MEMBERS = 20;
const MAX_LISTINGS = 20;

function parseList(raw: string | null): string[] {
  try { const v = JSON.parse(raw ?? '[]'); return Array.isArray(v) ? v.map(String) : []; } catch { return []; }
}

discovery.get('/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'directory', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = cleanCode(c.req.param('hs'));
  if (!hs || hs.length < 4) return bad('hs must be 4 to 10 digits', 400);
  const viewer = await currentUser(c.req.raw, c.env);

  // Codes are stored as a JSON array of text, so the prefix filter narrows in SQL and codeCovers decides.
  const head = hs.slice(0, 4);
  const { results: cards } = await c.env.DB.prepare(
    `SELECT id, display_name, company, country_iso3, intents, hs_codes FROM business_cards
      WHERE is_published = 1 AND hs_codes LIKE ? ORDER BY is_verified DESC, rating_avg DESC LIMIT 200`,
  ).bind(`%"${head}%`).all<{ id: string; display_name: string; company: string | null; country_iso3: string; intents: string; hs_codes: string }>();
  const members = cards
    .filter((r) => parseList(r.hs_codes).some((code) => codeCovers(code, hs)))
    .slice(0, MAX_MEMBERS)
    .map((r) => ({ card_id: r.id, display_name: r.display_name, company: r.company, country_iso3: r.country_iso3, intents: parseList(r.intents), matched_on: 'hs_code' as const }));

  const { results: listings } = await c.env.DB.prepare(
    `SELECT id, title, kind, country_iso3, mode, price_usd FROM listings
      WHERE status = 'open' AND hs_code <> '' AND (hs_code LIKE ?1 OR ?2 LIKE hs_code || '%')
      ORDER BY created_at DESC LIMIT ?3`,
  ).bind(`${hs}%`, hs, MAX_LISTINGS).all<DiscoveryResult['listings'][number]>();

  const body: DiscoveryResult & { signed_in: boolean } = { hs, members, listings, scope: DISCOVERY_SCOPE, limitations: DISCOVERY_LIMITATIONS, signed_in: !!viewer };
  return json(body, 200, { 'cache-control': 'private, max-age=60' });
});
