import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { currentUser, isEntitled } from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { buildGuide } from './guide';
import { buildCanvas, canvasToText, blockDefs, LANGS, type Blocks, type CanvasInput, type Lang, type Line } from '../../shared/canvas';

/**
 * Business Model Canvas. Premium. Generated from the Guide for one product in one country by rules, then editable by the
 * owner. Every canvas is stored against the user and the opportunity (country and HS code).
 */
export const canvas = new Hono<{ Bindings: Env }>();

const MAX_CANVASES = 50;
const MAX_LINES = 20;
const MAX_LINE = 600;

async function owner(c: { req: { raw: Request }; env: Env }) {
  const user = await currentUser(c.req.raw, c.env);
  return user && isEntitled(user) ? user : null;
}

const lang = (v: unknown): Lang => (LANGS.includes(v as Lang) ? (v as Lang) : 'en');

/** Keeps only known blocks, trimmed lines and the three allowed sources, so a stored canvas is always well formed. */
function clean(input: unknown): Blocks | null {
  if (!input || typeof input !== 'object') return null;
  const out: Blocks = {};
  for (const d of blockDefs('en')) {
    const raw = (input as Record<string, unknown>)[d.key];
    if (!Array.isArray(raw)) return null;
    out[d.key] = raw.slice(0, MAX_LINES).map((l) => {
      const o = l as { text?: unknown; source?: unknown };
      const text = String(o?.text ?? '').trim().slice(0, MAX_LINE);
      const source: Line['source'] = o?.source === 'data' ? 'data' : o?.source === 'typical' ? 'typical' : 'user';
      return { text, source };
    }).filter((l) => l.text);
  }
  return out;
}

canvas.get('/', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const { results } = await c.env.DB.prepare('SELECT id, title, country_slug, hs_code, role, lang, created_at, updated_at FROM canvases WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').bind(u.id, MAX_CANVASES).all();
  return json({ canvases: results ?? [] }, 200, { 'cache-control': 'private, no-store' });
});

canvas.post('/', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const b = (await c.req.json().catch(() => null)) as { country?: string; hs?: string; role?: string; lang?: string; budget?: number } | null;
  const hs = String(b?.hs ?? '').replace(/[\s.]/g, '');
  if (!b?.country || !/^\d{6}$/.test(hs)) return bad('country and a 6-digit hs are required');
  const n = await c.env.DB.prepare('SELECT COUNT(*) AS n FROM canvases WHERE user_id = ?').bind(u.id).first<{ n: number }>();
  if ((n?.n ?? 0) >= MAX_CANVASES) return bad(`You can keep ${MAX_CANVASES} canvases. Delete one first.`, 409);
  const role = b.role === 'procurement' ? 'procurement' : 'supply';
  const budget = Number.isFinite(Number(b.budget)) && Number(b.budget) > 0 ? Math.min(Number(b.budget), 1e9) : null;
  const built = await buildGuide(c.env, b.country, hs, role, budget, null);
  if ('response' in built && built.response) return built.response;
  const body = (built as { body: Record<string, unknown> & { available: boolean } }).body;
  if (!body.available) return bad('There is not enough trade data for that product to build a canvas', 422);
  const lg = lang(b.lang);
  const blocks = buildCanvas(body as unknown as CanvasInput, lg);
  const inputs = body.inputs as { country: string; product: string };
  const id = uid('cv_');
  const title = `${inputs.product} in ${inputs.country}, ${role === 'supply' ? 'supply' : 'procurement'}`;
  await c.env.DB.prepare('INSERT INTO canvases (id, user_id, country_slug, hs_code, role, lang, title, blocks_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
    .bind(id, u.id, b.country.trim().toLowerCase(), hs, role, lg, title, JSON.stringify(blocks)).run();
  return json({ id, title }, 201);
});

canvas.get('/:id', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const row = await c.env.DB.prepare('SELECT id, title, country_slug, hs_code, role, lang, blocks_json, created_at, updated_at FROM canvases WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id)
    .first<{ id: string; title: string; country_slug: string; hs_code: string; role: string; lang: string; blocks_json: string; created_at: string; updated_at: string }>();
  if (!row) return bad('Canvas not found', 404);
  const { blocks_json, ...rest } = row;
  return json({ ...rest, blocks: JSON.parse(blocks_json), defs: blockDefs(lang(row.lang)), next: { guide: `/guide?country=${row.country_slug}&hs=${row.hs_code}`, finance: `/finance/${row.country_slug}` } }, 200, { 'cache-control': 'private, no-store' });
});

canvas.put('/:id', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const b = (await c.req.json().catch(() => null)) as { blocks?: unknown; title?: string } | null;
  const blocks = clean(b?.blocks);
  if (!blocks) return bad('blocks must hold all nine canvas blocks');
  const res = await c.env.DB.prepare("UPDATE canvases SET blocks_json = ?, title = COALESCE(?, title), updated_at = datetime('now') WHERE id = ? AND user_id = ?")
    .bind(JSON.stringify(blocks), b?.title?.trim().slice(0, 300) || null, c.req.param('id'), u.id).run();
  if (!res.meta.changes) return bad('Canvas not found', 404);
  return json({ ok: true });
});

/** Switch the labels and typical lines to the other language, keeping every line the user wrote or edited. */
canvas.post('/:id/regenerate', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const b = (await c.req.json().catch(() => null)) as { lang?: string } | null;
  const row = await c.env.DB.prepare('SELECT country_slug, hs_code, role, blocks_json FROM canvases WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id)
    .first<{ country_slug: string; hs_code: string; role: 'supply' | 'procurement'; blocks_json: string }>();
  if (!row) return bad('Canvas not found', 404);
  const lg = lang(b?.lang);
  const built = await buildGuide(c.env, row.country_slug, row.hs_code, row.role, null, null);
  if ('response' in built && built.response) return built.response;
  const body = (built as { body: Record<string, unknown> & { available: boolean } }).body;
  if (!body.available) return bad('Trade data is not available to rebuild this canvas', 422);
  const fresh = buildCanvas(body as unknown as CanvasInput, lg);
  const old = JSON.parse(row.blocks_json) as Blocks;
  const merged: Blocks = {};
  for (const k of Object.keys(fresh)) merged[k] = [...(old[k] ?? []).filter((l) => l.source === 'user'), ...fresh[k]];
  await c.env.DB.prepare("UPDATE canvases SET blocks_json = ?, lang = ?, updated_at = datetime('now') WHERE id = ? AND user_id = ?").bind(JSON.stringify(merged), lg, c.req.param('id'), u.id).run();
  return json({ ok: true, lang: lg });
});

canvas.get('/:id/export', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  const row = await c.env.DB.prepare('SELECT title, lang, blocks_json, updated_at FROM canvases WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id)
    .first<{ title: string; lang: string; blocks_json: string; updated_at: string }>();
  if (!row) return bad('Canvas not found', 404);
  const text = canvasToText(row.title, JSON.parse(row.blocks_json), lang(row.lang), `Tereflow, ${row.updated_at} UTC`);
  return new Response(text, { headers: { 'content-type': 'text/plain; charset=utf-8', 'content-disposition': `attachment; filename="canvas-${c.req.param('id')}.txt"`, 'cache-control': 'private, no-store' } });
});

canvas.delete('/:id', async (c) => {
  const u = await owner(c);
  if (!u) return bad('The Business Model Canvas is a premium feature', 402);
  await c.env.DB.prepare('DELETE FROM canvases WHERE id = ? AND user_id = ?').bind(c.req.param('id'), u.id).run();
  return json({ deleted: true });
});