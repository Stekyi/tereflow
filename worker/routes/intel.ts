import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';

export const intel = new Hono<{ Bindings: Env }>();

const HS6 = /^\d{6}$/;
const CHUNK = 3000;

/** The SQL gateway returns the first 32000 characters of a CLOB. A longer payload fails to parse, so it is read back in slices. */
async function fullPayload(db: Env['DB'], table: string, keyCol: string, key: string, first: unknown): Promise<unknown> {
  const direct = parse(first);
  if (direct !== null) return direct;
  const lenRow = await db.prepare(`SELECT LENGTH(payload) AS n FROM ${table} WHERE ${keyCol} = ?`).bind(key).first<{ n: number }>();
  const n = Number(lenRow?.n ?? 0);
  if (!n || n > 400_000) return null;
  const stmts = [];
  for (let at = 1; at <= n; at += CHUNK) stmts.push(db.prepare(`SELECT SUBSTR(payload, ${at}, ${CHUNK}) AS s FROM ${table} WHERE ${keyCol} = ?`).bind(key));
  const parts = await db.batch(stmts);
  return parse(parts.map((p) => ((p.results ?? [])[0] as { s?: string } | undefined)?.s ?? '').join(''));
}

function parse(payload: unknown): unknown {
  if (typeof payload !== 'string') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

/** Products by name or code: the largest by reported imports, or those matching a word (in the name) or the start of an HS code. */
intel.get('/', async (c) => {
  const raw = (c.req.query('q') ?? c.req.query('hs') ?? '').trim().slice(0, 60);
  const digits = raw.replace(/\D/g, '');
  const isCode = raw !== '' && /^[\d\s.]+$/.test(raw);
  const words = raw.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/).filter((w) => w.length > 1).slice(0, 4);
  const cols = 'hs6, name, demand_usd, latest_year';
  let stmt;
  if (!raw) stmt = c.env.DB.prepare(`SELECT ${cols} FROM pi_product ORDER BY demand_usd DESC NULLS LAST FETCH FIRST 100 ROWS ONLY`);
  else if (isCode) stmt = c.env.DB.prepare(`SELECT ${cols} FROM pi_product WHERE hs6 LIKE ? ORDER BY demand_usd DESC NULLS LAST FETCH FIRST 100 ROWS ONLY`).bind(`${digits}%`);
  else if (words.length === 0) stmt = c.env.DB.prepare(`SELECT ${cols} FROM pi_product ORDER BY demand_usd DESC NULLS LAST FETCH FIRST 100 ROWS ONLY`);
  else stmt = c.env.DB.prepare(`SELECT ${cols} FROM pi_product WHERE ${words.map(() => 'LOWER(name) LIKE ?').join(' AND ')} ORDER BY demand_usd DESC NULLS LAST FETCH FIRST 100 ROWS ONLY`).bind(...words.map((w) => `%${w}%`));
  const meta = c.env.DB.prepare("SELECT k, v, updated_at FROM pi_meta WHERE k = 'run'");
  const [rows, m] = await c.env.DB.batch([stmt, meta]);
  const run = parse(((m.results ?? [])[0] as { v?: string } | undefined)?.v);
  return json({ products: rows.results ?? [], run }, 200, { 'cache-control': 'public, max-age=600' });
});
/** One product's calculated intelligence, plus the methods and coverage it rests on. */
intel.get('/io/regions', async (c) => {
  const [r, m] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT code, iso3, name, note FROM pi_region ORDER BY code'),
    c.env.DB.prepare("SELECT k, v FROM pi_io_meta WHERE k = 'latest'"),
  ]);
  return json({ regions: r.results ?? [], latest: parse(((m.results ?? [])[0] as { v?: string } | undefined)?.v) }, 200, { 'cache-control': 'public, max-age=3600' });
});

/** Direct and total upstream requirements of one country-industry in the input-output table. */
intel.get('/io/:country/:industry', async (c) => {
  const country = c.req.param('country').toUpperCase();
  const industry = c.req.param('industry');
  if (!/^[A-Z_]{2,8}$/.test(country) || !/^[A-Z0-9_-]{1,10}$/.test(industry)) return bad('Give a region code and an industry code');
  const [row, meta] = await c.env.DB.batch([
    c.env.DB.prepare("SELECT payload, year FROM pi_io WHERE source = 'ESTAT_FIGARO_II' AND country = ? AND industry = ? ORDER BY year DESC FETCH FIRST 1 ROWS ONLY").bind(country, industry),
    c.env.DB.prepare("SELECT k, v FROM pi_io_meta WHERE k LIKE 'ESTAT%' ORDER BY k DESC FETCH FIRST 1 ROWS ONLY"),
  ]);
  const r = (row.results ?? [])[0] as { payload: string; year: number } | undefined;
  if (!r) return bad('No input-output result for this region and industry', 404);
  const m = parse(((meta.results ?? [])[0] as { v?: string } | undefined)?.v) as Record<string, unknown> | null;
  return json({
    io: parse(r.payload),
    source: m ? {
      dataset: m.dataset, year: m.year, last_update: m.last_update, licence: m.licence, modification_note: m.modification_note, coverage_note: m.coverage_note,
      limitations: m.limitations, validation: m.validation, balance_check: m.balance_check, unit: m.unit, price_basis: m.price_basis, blockers: m.blockers,
    } : null,
  }, 200, { 'cache-control': 'public, max-age=3600' });
});

/** The HS to industry bridge result for one product, with the sources it came from. */
intel.get('/:hs6/mapping', async (c) => {
  const hs6 = c.req.param('hs6');
  if (!HS6.test(hs6)) return bad('Give a six-digit HS code');
  const [row, inds, src] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT category, payload, version, computed_at FROM pi_map WHERE hs6 = ?').bind(hs6),
    c.env.DB.prepare('SELECT code, name FROM pi_industry'),
    c.env.DB.prepare('SELECT k, name, url, version, direction, retrieved_at, licence_note FROM pi_sources'),
  ]);
  const r = (row.results ?? [])[0] as { category: string; payload: string; version: string; computed_at: string } | undefined;
  if (!r) return bad('This product has not been through the concordance yet', 404);
  return json({
    category: r.category, map: await fullPayload(c.env.DB, 'pi_map', 'hs6', hs6, r.payload), version: r.version, computed_at: r.computed_at,
    industries: Object.fromEntries(((inds.results ?? []) as { code: string; name: string }[]).map((i) => [i.code, i.name])),
    sources: src.results ?? [],
  }, 200, { 'cache-control': 'public, max-age=3600' });
});

/** Gravity model result for the product's HS chapter: estimate of expected trade, kept apart from observed imports. */
intel.get('/:hs6/gravity', async (c) => {
  const hs6 = c.req.param('hs6');
  if (!HS6.test(hs6)) return bad('Give a six-digit HS code');
  const [row, meta] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT payload, year, version, computed_at FROM pi_gravity WHERE chapter = ?').bind(hs6.slice(0, 2)),
    c.env.DB.prepare("SELECT v FROM pi_meta WHERE k = 'gravity'"),
  ]);
  const r = (row.results ?? [])[0] as { payload: string; year: number; version: string; computed_at: string } | undefined;
  const m = parse(((meta.results ?? [])[0] as { v?: string } | undefined)?.v);
  if (!r) return json({ chapter: hs6.slice(0, 2), model: null, meta: m }, 200);
  return json({ chapter: hs6.slice(0, 2), model: parse(r.payload), year: r.year, computed_at: r.computed_at, meta: m }, 200, { 'cache-control': 'public, max-age=3600' });
});

/** One product's calculated intelligence, plus the methods and coverage it rests on. */
intel.get('/:hs6', async (c) => {
  const hs6 = c.req.param('hs6');
  if (!HS6.test(hs6)) return bad('Give a six-digit HS code');
  const [prod, methods, run] = await c.env.DB.batch([
    c.env.DB.prepare('SELECT payload, computed_at, method_version FROM pi_product WHERE hs6 = ?').bind(hs6),
    c.env.DB.prepare("SELECT v FROM pi_meta WHERE k = 'methods'"),
    c.env.DB.prepare("SELECT v FROM pi_meta WHERE k = 'run'"),
  ]);
  const row = (prod.results ?? [])[0] as { payload: string; computed_at: string; method_version: string } | undefined;
  if (!row) return bad('No intelligence has been calculated for this product yet. Either it has no reported imports in the data, or the pipeline has not been run for it.', 404);
  return json({
    product: await fullPayload(c.env.DB, 'pi_product', 'hs6', hs6, row.payload),
    computed_at: row.computed_at,
    methods: parse(((methods.results ?? [])[0] as { v?: string } | undefined)?.v),
    run: parse(((run.results ?? [])[0] as { v?: string } | undefined)?.v),
  }, 200, { 'cache-control': 'public, max-age=600' });
});
