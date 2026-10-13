import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { oracleConfig } from '../lib/oracle';
import { oracleProductDetail, type ProductDetailPayload } from '../lib/oracle-insight';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { BYPRODUCTS_BY_HS4, byproductAnalysis, type ByproductInput } from '../../shared/byproducts';

/** By-product and logistics leads for one country's main export, checked against that country's own trade. Reads only. */
export const byproducts = new Hono<{ Bindings: Env }>();

const latest = (d: ProductDetailPayload | null) => {
  const s = d?.series ?? [];
  const last = s[s.length - 1];
  return last ? { year: last.year, value: last.value_usd } : null;
};

byproducts.get('/:country/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = c.req.param('hs').replace(/[\s.]/g, '');
  if (!/^\d{4,10}$/.test(hs)) return bad('hs must be 4 to 10 digits', 400);
  const key = c.req.param('country').trim().toLowerCase();
  const entity = await c.env.DB.prepare("SELECT iso3, name FROM entities WHERE kind = 'country' AND (slug = ? OR lower(iso3) = ?)")
    .bind(key, key).first<{ iso3: string | null; name: string }>();
  const iso3 = entity?.iso3?.toUpperCase();
  if (!iso3) return bad('Unknown country', 404);

  const q = new URL(c.req.url).searchParams;
  const thresholds = {
    min_main_usd: q.has('min_main_usd') ? Number(q.get('min_main_usd')) : undefined,
    under_ratio: q.has('under_ratio') ? Number(q.get('under_ratio')) : undefined,
    import_gap_usd: q.has('import_gap_usd') ? Number(q.get('import_gap_usd')) : undefined,
  };

  const cfg = oracleConfig(c.env);
  const hs4 = hs.slice(0, 4);
  const cands = BYPRODUCTS_BY_HS4[hs4] ?? [];
  let mainValue: number | null = null;
  let year: number | null = null;
  const data: ByproductInput[] = [];

  if (cfg) {
    const main = await oracleProductDetail(cfg, iso3, 'X', hs4).catch(() => null);
    const m = latest(main);
    mainValue = m?.value ?? null;
    year = m?.year ?? null;
    const pairs = await Promise.all(cands.map(async (cd) => {
      const [x, i] = await Promise.all([
        oracleProductDetail(cfg, iso3, 'X', cd.hs4).catch(() => null),
        oracleProductDetail(cfg, iso3, 'M', cd.hs4).catch(() => null),
      ]);
      const xv = latest(x);
      const iv = latest(i);
      // Only use a year that matches the main commodity's year, so the ratio compares like with like.
      return {
        hs4: cd.hs4,
        exports_usd: xv && xv.year === year ? xv.value : null,
        imports_usd: iv && iv.year === year ? iv.value : null,
      };
    }));
    data.push(...pairs);
  }

  const analysis = byproductAnalysis(hs, mainValue, data, thresholds);
  return json(
    { country: entity?.name ?? iso3, hs4, year, ...analysis, has_data: cfg != null && mainValue != null },
    200,
    { 'cache-control': 'public, max-age=3600' },
  );
});
