import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';

/**
 * Maps a typed product to a main product or to the main product it is a by-product of, using the knowledge base.
 * A residue such as a shell often has no trade code of its own, so the answer says so and points at its parent.
 * Matching is plain text over names and listed search terms; nothing is guessed. Reads only.
 */
export const resolve = new Hono<{ Bindings: Env }>();

interface Row {
  id: string;
  parent_name: string;
  parent_code: string | null;
  byproduct_name: string;
  byproduct_code: string | null;
  kind: string;
  confidence: string;
  status: string;
  evidence_note: string | null;
}

const like = (s: string) => `%${s.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;

resolve.get('/', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const q = (new URL(c.req.url).searchParams.get('q') ?? '').trim().toLowerCase().replace(/\s+/g, ' ');
  if (q.length < 3 || q.length > 60) return bad('q must be 3 to 60 characters', 400);

  const { results } = await c.env.DB.prepare(
    `SELECT id, parent_name, parent_code, byproduct_name, byproduct_code, kind, confidence, status, evidence_note
       FROM kb_relationship
      WHERE status != 'rejected'
        AND (',' || COALESCE(aliases, '') || ',' LIKE ? ESCAPE '\\' OR lower(byproduct_name) LIKE ? ESCAPE '\\' OR lower(parent_name) LIKE ? ESCAPE '\\')
      ORDER BY CASE confidence WHEN 'verified' THEN 0 WHEN 'plausible' THEN 1 ELSE 2 END, byproduct_name
      LIMIT 40`,
  ).bind(like(q), like(q), like(q)).all<Row>();

  const seen = new Set<string>();
  const matches = (results ?? []).flatMap((r) => {
    // Several parent codes can carry the same relationship; show it once per parent code.
    const key = `${r.parent_code}|${r.byproduct_code ?? r.byproduct_name}`;
    if (seen.has(key)) return [];
    seen.add(key);
    const nameHit = r.parent_name.toLowerCase().includes(q) && !r.byproduct_name.toLowerCase().includes(q);
    return [{
      id: r.id,
      kind: r.kind,
      confidence: r.confidence,
      by_name: r.byproduct_name,
      by_code: r.byproduct_code,
      parent_name: r.parent_name,
      parent_code: r.parent_code,
      // When the typed word only matched the parent, the row is a product made from it, not a by-product of what was typed.
      matched_on: nameHit ? 'parent' : 'byproduct',
      note: r.evidence_note,
    }];
  });
  return json({ q, matches }, 200, { 'cache-control': 'public, max-age=300' });
});
