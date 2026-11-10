import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json, uid } from '../lib/db';
import { requireAdmin } from '../lib/auth';
import { currentUser } from '../lib/session';

/**
 * Operator-managed photographs. Real images only: uploaded by a person in the admin, never generated.
 * Categories live in the media_categories table, so a new kind of image needs no code change.
 * SVG is refused on purpose (it can carry script); only JPEG, PNG and WebP, checked by their first bytes.
 */
export const media = new Hono<{ Bindings: Env }>();
export const mediaAdmin = new Hono<{ Bindings: Env }>();

const MAX_BYTES = 5 * 1024 * 1024;

function sniff(b: Uint8Array): { type: string; ext: string } | null {
  if (b.length > 12 && b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return { type: 'image/jpeg', ext: 'jpg' };
  if (b.length > 12 && b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return { type: 'image/png', ext: 'png' };
  if (b.length > 12 && b[0] === 0x52 && b[1] === 0x49 && b[2] === 0x46 && b[3] === 0x46 && b[8] === 0x57 && b[9] === 0x45 && b[10] === 0x42 && b[11] === 0x50)
    return { type: 'image/webp', ext: 'webp' };
  return null;
}

// ---- public -----------------------------------------------------------------

media.get('/', async (c) => {
  const category = c.req.query('category');
  const subject = c.req.query('subject');
  const clauses = ['is_active = 1'];
  const binds: unknown[] = [];
  if (category) { clauses.push('category = ?'); binds.push(category); }
  if (subject) { clauses.push('subject = ?'); binds.push(subject.toUpperCase()); }
  const { results } = await c.env.DB.prepare(
    `SELECT id, category, subject, title, alt_text FROM media_assets WHERE ${clauses.join(' AND ')} ORDER BY sort_order, uploaded_at DESC LIMIT 60`,
  ).bind(...binds).all();
  return json({ images: (results ?? []).map((r) => ({ ...r, url: `/api/media/${(r as { id: string }).id}/file` })) });
});

media.get('/:id/file', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key, content_type FROM media_assets WHERE id = ? AND is_active = 1').bind(c.req.param('id')).first<{ r2_key: string; content_type: string }>();
  if (!row) return bad('Not found', 404);
  const obj = await c.env.MEDIA.get(row.r2_key);
  if (!obj) return bad('Not found', 404);
  return new Response(obj.body, {
    headers: {
      'content-type': row.content_type,
      'cache-control': 'public, max-age=86400',
      'x-content-type-options': 'nosniff',
      'content-security-policy': "default-src 'none'",
    },
  });
});

// ---- admin ------------------------------------------------------------------

mediaAdmin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

mediaAdmin.get('/', async (c) => {
  const cats = await c.env.DB.prepare('SELECT code, label, help FROM media_categories WHERE is_active = 1 ORDER BY sort_order').all();
  const { results } = await c.env.DB.prepare(
    'SELECT id, category, subject, title, alt_text, content_type, bytes, uploaded_by, uploaded_at, is_active FROM media_assets ORDER BY category, subject, uploaded_at DESC LIMIT 300',
  ).all();
  return json({ categories: cats.results ?? [], images: (results ?? []).map((r) => ({ ...r, url: `/api/media/${(r as { id: string }).id}/file` })), max_bytes: MAX_BYTES });
});

mediaAdmin.post('/', async (c) => {
  let form: FormData;
  try { form = await c.req.formData(); } catch { return bad('Send the image as a form upload'); }
  const file = form.get('file');
  const category = String(form.get('category') ?? '').trim();
  const subject = String(form.get('subject') ?? '').trim().toUpperCase().slice(0, 120) || null;
  const title = String(form.get('title') ?? '').trim().slice(0, 200) || null;
  const alt = String(form.get('alt_text') ?? '').trim().slice(0, 400);
  if (!(file instanceof File)) return bad('Choose an image file');
  if (!alt) return bad('Describe the photo in the alt text field (for screen readers)');
  const cat = await c.env.DB.prepare('SELECT code FROM media_categories WHERE code = ? AND is_active = 1').bind(category).first();
  if (!cat) return bad('Unknown category');
  if (file.size > MAX_BYTES) return bad(`Image is over ${MAX_BYTES / 1024 / 1024} MB`);
  const bytes = new Uint8Array(await file.arrayBuffer());
  const kind = sniff(bytes);
  if (!kind) return bad('Only JPEG, PNG or WebP photographs are accepted');
  const id = uid('img_');
  const key = `${category}/${id}.${kind.ext}`;
  await c.env.MEDIA.put(key, bytes, { httpMetadata: { contentType: kind.type } });
  const actor = await currentUser(c.req.raw, c.env);
  await c.env.DB.prepare(
    'INSERT INTO media_assets (id, category, subject, title, alt_text, r2_key, content_type, bytes, uploaded_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
  ).bind(id, category, subject, title, alt, key, kind.type, bytes.length, actor?.email ?? 'admin').run();
  return json({ id, url: `/api/media/${id}/file` }, 201);
});

mediaAdmin.patch('/:id', async (c) => {
  const body = (await c.req.json()) as { is_active?: boolean; title?: string; alt_text?: string; subject?: string; sort_order?: number };
  const sets: string[] = [];
  const binds: unknown[] = [];
  if (body.is_active !== undefined) { sets.push('is_active = ?'); binds.push(body.is_active ? 1 : 0); }
  if (body.title !== undefined) { sets.push('title = ?'); binds.push(body.title.slice(0, 200)); }
  if (body.alt_text !== undefined) { if (!body.alt_text.trim()) return bad('Alt text cannot be empty'); sets.push('alt_text = ?'); binds.push(body.alt_text.slice(0, 400)); }
  if (body.subject !== undefined) { sets.push('subject = ?'); binds.push(body.subject.toUpperCase().slice(0, 120)); }
  if (body.sort_order !== undefined) { sets.push('sort_order = ?'); binds.push(Math.trunc(body.sort_order)); }
  if (!sets.length) return bad('Nothing to change');
  const res = await c.env.DB.prepare(`UPDATE media_assets SET ${sets.join(', ')} WHERE id = ?`).bind(...binds, c.req.param('id')).run();
  if (!res.meta.changes) return bad('Not found', 404);
  return json({ ok: true });
});

mediaAdmin.delete('/:id', async (c) => {
  const row = await c.env.DB.prepare('SELECT r2_key FROM media_assets WHERE id = ?').bind(c.req.param('id')).first<{ r2_key: string }>();
  if (!row) return bad('Not found', 404);
  await c.env.MEDIA.delete(row.r2_key);
  await c.env.DB.prepare('DELETE FROM media_assets WHERE id = ?').bind(c.req.param('id')).run();
  return json({ ok: true });
});