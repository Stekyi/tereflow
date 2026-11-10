import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { currentUser, isEntitled } from '../lib/session';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { hs6Label } from '../agent/codes';
import { shortProductName } from '../../shared/product-name';
import { ISO3_NAME } from '../../shared/country-names';

/**
 * Product growth outlook. Premium. Reads forecasts the Oracle job (forecast-run) wrote; nothing is computed here.
 * The model, its test against a held-out year and its limits are in reports/growth-model-eval-*.md.
 */
export const forecast = new Hono<{ Bindings: Env }>();

forecast.get('/:country', async (c) => {
  const user = await currentUser(c.req.raw, c.env);
  if (!user || !isEntitled(user)) return bad('The growth outlook is a premium feature', 402);
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (limited) return tooMany(limited);
  const iso3 = c.req.param('country').toUpperCase();
  if (!/^[A-Z]{3}$/.test(iso3)) return bad('country must be an ISO3 code');
  const flow = c.req.query('flow') === 'M' ? 'M' : 'X';
  const { results } = await c.env.DB.prepare(
    `SELECT hs6, base_year, base_value_usd, p_grow, growth_pred, growth_low, growth_high
       FROM forecasts
      WHERE reporter_iso3 = ? AND flow = ? AND base_value_usd >= 1000000
      ORDER BY p_grow DESC
      LIMIT 40`,
  )
    .bind(iso3, flow)
    .all<{ hs6: string; base_year: number; base_value_usd: number; p_grow: number; growth_pred: number; growth_low: number; growth_high: number }>();
  return json({
    country: iso3,
    country_name: ISO3_NAME[iso3] ?? iso3,
    flow,
    model: 'Experimental. Ranks products by the chance of 10% or more growth next year. Tested on one held-out year; treat as a lead, not a promise.',
    items: (results ?? []).map((r) => ({
      hs6: r.hs6,
      name: shortProductName(hs6Label(r.hs6) ?? r.hs6),
      base_year: r.base_year,
      base_value_usd: r.base_value_usd,
      p_grow: Math.round(r.p_grow * 100) / 100,
      growth_pred: Math.round(r.growth_pred * 1000) / 1000,
      growth_low: Math.round(r.growth_low * 1000) / 1000,
      growth_high: Math.round(r.growth_high * 1000) / 1000,
    })),
  });
});