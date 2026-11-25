import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';

export const intel = new Hono<{ Bindings: Env }>();

const HS6 = /^\d{6}$/;

function parse(payload: unknown): unknown {
  if (typeof payload !== 'string') return null;
  try { return JSON.parse(payload); } catch { return null; }
}

/** The products with the largest reported imports, or those under an HS prefix. */
intel.get('/', async (c) => {
  const prefix = (c.req.query('hs') ?? '').replace(/\D/g, '').slice(0, 6);
  const stmt = prefix
    ? c.env.DB.prepare('SELECT hs6, demand_usd, latest_year FROM pi_product WHERE hs6 LIKE ? ORDER BY demand_usd DESC FETCH FIRST 100 ROWS ONLY').bind(`${prefix}%`)
    : c.env.DB.prepare('SELECT hs6, demand_usd, latest_year FROM pi_product ORDER BY demand_usd DESC FETCH FIRST 100 ROWS ONLY');
  const meta = c.env.DB.prepare("SELECT k, v, updated_at FROM pi_meta WHERE k = 'run'");
  const [rows, m] = await c.env.DB.batch([stmt, meta]);
  const run = parse(((m.results ?? [])[0] as { v?: string } | undefined)?.v);
  return json({ products: rows.results ?? [], run }, 200, { 'cache-control': 'public, max-age=600' });
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
    product: parse(row.payload),
    computed_at: row.computed_at,
    methods: parse(((methods.results ?? [])[0] as { v?: string } | undefined)?.v),
    run: parse(((run.results ?? [])[0] as { v?: string } | undefined)?.v),
  }, 200, { 'cache-control': 'public, max-age=600' });
});
