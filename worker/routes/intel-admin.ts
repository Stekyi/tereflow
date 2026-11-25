import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { requireAdmin } from '../lib/auth';

/**
 * OECD ICIO upload. The table is far too big for the Worker to read, so it only streams the file into storage.
 * The pipeline (`pipeline.cmd intel-io --icio`, also nightly) opens it, checks that it balances, and either
 * loads it or refuses it with the reasons, which show up here.
 */
export const intelAdmin = new Hono<{ Bindings: Env }>();

intelAdmin.use('*', async (c, next) => {
  const denied = requireAdmin(c.req.raw, c.env);
  if (denied) return denied;
  await next();
});

const NAME = /^[A-Za-z0-9][A-Za-z0-9._ -]{1,90}\.(zip|csv)$/i;
const MAX = 95 * 1024 * 1024;
const P = 'icio-inbox/';

intelAdmin.get('/icio', async (c) => {
  const list = async (prefix: string) => (await c.env.MEDIA.list({ prefix, limit: 100 })).objects.filter((o) => !o.key.endsWith('.reason.txt')).map((o) => ({ name: o.key.slice(prefix.length), bytes: o.size, uploaded: o.uploaded.toISOString() }));
  const [pending, done, rejected] = await Promise.all([list(`${P}pending/`), list(`${P}done/`), list(`${P}rejected/`)]);
  const reasons = await Promise.all(rejected.slice(0, 8).map(async (r) => ({ ...r, reason: (await (await c.env.MEDIA.get(`${P}rejected/${r.name}.reason.txt`))?.text())?.slice(0, 2000) ?? null })));
  done.sort((a, b) => b.uploaded.localeCompare(a.uploaded));
  const meta = await c.env.DB.prepare("SELECT k, v, updated_at FROM pi_io_meta WHERE k LIKE 'OECD_ICIO:%' ORDER BY k DESC").all<{ k: string; v: string; updated_at: string }>();
  const loaded = (meta.results ?? []).map((m) => {
    try {
      const v = JSON.parse(m.v) as Record<string, unknown>;
      return { key: m.k, updated_at: m.updated_at, year: v.year, file: v.file, countries: (v.countries as string[] | undefined)?.length ?? 0, balance: v.balance_check, licence_state: v.licence_state };
    } catch { return { key: m.k, updated_at: m.updated_at }; }
  });
  return json({ pending, done: done.slice(0, 20), rejected: reasons.sort((a, b) => b.uploaded.localeCompare(a.uploaded)), loaded, max_bytes: MAX });
});

intelAdmin.put('/icio/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!NAME.test(name)) return bad('Use the file as downloaded from OECD: a .zip or .csv with a simple name that contains the year, for example 2020_SML.csv.zip or ICIO2023_2020.zip');
  if (!/(?:^|[^0-9])(?:19|20)\d{2}(?:[^0-9]|$)/.test(name)) return bad('The file name must contain the year (for example 2020).');
  const len = Number(c.req.header('content-length') ?? 0);
  if (!len) return bad('Empty file');
  if (len > MAX) return bad(`The file is ${(len / 1048576).toFixed(0)} MB. The website accepts up to ${MAX / 1048576} MB per upload: upload one year, zipped. For anything larger run the pipeline on a PC: pipeline.cmd intel-io --icio-file FILE`);
  const body = c.req.raw.body;
  if (!body) return bad('Empty file');
  await c.env.MEDIA.put(`${P}pending/${name}`, body, { httpMetadata: { contentType: 'application/octet-stream' } });
  const head = await c.env.MEDIA.get(`${P}pending/${name}`, { range: { offset: 0, length: 4 } });
  const bytes = new Uint8Array((await head?.arrayBuffer()) ?? new ArrayBuffer(0));
  const zip = bytes[0] === 0x50 && bytes[1] === 0x4b;
  const text = bytes.length > 0 && bytes.every((b) => b === 0x0a || b === 0x0d || b === 0x09 || b === 0x2c || b === 0x3b || b === 0x22 || (b >= 0x20 && b < 0x7f));
  if (!zip && !text) {
    await c.env.MEDIA.delete(`${P}pending/${name}`);
    return bad('That does not look like a zip or CSV file');
  }
  return json({ ok: true, name, bytes: len, note: 'Queued. The pipeline checks that the table balances and loads it at its next run (nightly, or `pipeline.cmd intel-io --icio` on any PC with the Oracle wallet). If the file is wrong the whole file is refused and the reasons appear here.' }, 201);
});

intelAdmin.delete('/icio/:name', async (c) => {
  const name = decodeURIComponent(c.req.param('name'));
  if (!NAME.test(name)) return bad('Bad file name');
  await c.env.MEDIA.delete(`${P}pending/${name}`);
  return json({ ok: true });
});
