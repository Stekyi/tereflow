import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { oracleConfig } from '../lib/oracle';
import { oracleProductDetail } from '../lib/oracle-insight';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { PRODUCTION_BY_HS, productionSignal, type ProductionPoint } from '../../shared/production';

/** Domestic crop production for one country and product, from FAOSTAT. Reads only. */
export const production = new Hono<{ Bindings: Env }>();

production.get('/:country/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = c.req.param('hs').replace(/[\s.]/g, '');
  if (!/^\d{4,10}$/.test(hs)) return bad('hs must be 4 to 10 digits', 400);
  // Accepts a country slug (what the app has) or a 3-letter code.
  const key = c.req.param('country').trim().toLowerCase();
  const entity = await c.env.DB.prepare("SELECT iso3 FROM entities WHERE kind = 'country' AND (slug = ? OR lower(iso3) = ?)")
    .bind(key, key).first<{ iso3: string | null }>();
  const iso3 = entity?.iso3?.toUpperCase();
  if (!iso3) return bad('Unknown country', 404);

  const item = PRODUCTION_BY_HS[hs.slice(0, 4)];
  if (!item) return json(productionSignal(hs, []), 200, { 'cache-control': 'public, max-age=3600' });

  const { results } = await c.env.DB.prepare(
    'SELECT year, tonnes, area_ha, flag FROM crop_production WHERE iso3 = ? AND fao_item = ? ORDER BY year',
  ).bind(iso3, item.faoCode).all<{ year: number; tonnes: number | null; area_ha: number | null; flag: string | null }>();
  const points: ProductionPoint[] = results.map((r) => ({ year: r.year, tonnes: r.tonnes, area_ha: r.area_ha, flag: r.flag }));

  // The country's own exported weight puts production in proportion; if Oracle has none, the ratio is left out.
  const exportKg: Record<number, number> = {};
  const cfg = oracleConfig(c.env);
  if (cfg && hs.length >= 6) {
    const d = await oracleProductDetail(cfg, iso3, 'X', hs.slice(0, 6)).catch(() => null);
    for (const r of d?.series ?? []) if (r.qty_kg && r.qty_kg > 0) exportKg[r.year] = r.qty_kg;
  }
  const meta = await c.env.DB.prepare('SELECT file_date FROM crop_production_meta WHERE id = 1').first<{ file_date: string | null }>();
  return json({ ...productionSignal(hs, points, exportKg), data_as_of: meta?.file_date ?? null }, 200, { 'cache-control': 'public, max-age=3600' });
});
