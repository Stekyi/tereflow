import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { oracleConfig } from '../lib/oracle';
import { oracleProductDetail } from '../lib/oracle-insight';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { currentUser, isEntitled } from '../lib/session';
import { ISO3_NAME } from '../../shared/country-names';
import { fxRisk, saturation, type FxPoint, type FxRisk, type Saturation } from '../../shared/prospect';
import { isMarket } from '../../shared/markets';

/**
 * Premium prospect view for one country's export of one product: how crowded each main buyer's supply
 * already is, and how risky each buyer's currency (and the home currency) has been. Reads only.
 */
export const prospect = new Hono<{ Bindings: Env }>();

const TOP_BUYERS = 3;
const FX_FROM = 2012;

async function worldBankRates(iso3: string): Promise<FxPoint[] | null> {
  const to = new Date().getUTCFullYear();
  const url = `https://api.worldbank.org/v2/country/${iso3}/indicator/PA.NUS.FCRF?format=json&per_page=60&date=${FX_FROM}:${to}`;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(7000), cf: { cacheTtl: 86_400, cacheEverything: true } } as RequestInit);
    if (!res.ok) return null;
    const body = (await res.json()) as [unknown, Array<{ date: string; value: number | null }> | null];
    const rows = body?.[1];
    if (!Array.isArray(rows)) return null;
    return rows.filter((r) => r.value != null).map((r) => ({ year: Number(r.date), rate: Number(r.value) }));
  } catch {
    return null;
  }
}

const nameOf = (iso3: string) => ISO3_NAME[iso3] ?? iso3;

prospect.get('/:country/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = c.req.param('hs').replace(/[\s.]/g, '');
  if (!/^\d{6}$/.test(hs)) return bad('hs must be a 6-digit product code', 400);

  // Entitlement comes from the signed-in user, never from the request. Free viewers get the outline only.
  const viewer = await currentUser(c.req.raw, c.env);
  if (!isEntitled(viewer)) {
    return json(
      {
        locked: true,
        title: 'Business prospect view',
        teaser: 'How crowded each main buyer market already is, and how risky each buyer currency has been. Premium.',
      },
      200,
      { 'cache-control': 'private, no-store' },
    );
  }

  const key = c.req.param('country').trim().toLowerCase();
  const entity = await c.env.DB.prepare("SELECT iso3, name FROM entities WHERE kind = 'country' AND (slug = ? OR lower(iso3) = ?)")
    .bind(key, key).first<{ iso3: string | null; name: string }>();
  const home = entity?.iso3?.toUpperCase();
  if (!home) return bad('Unknown country', 404);

  const cfg = oracleConfig(c.env);
  if (!cfg) return json({ locked: false, available: false, reason: 'Trade data is not connected.' }, 200, { 'cache-control': 'private, no-store' });

  const exp = await oracleProductDetail(cfg, home, 'X', hs).catch(() => null);
  const buyersRaw = (exp?.partners ?? []).filter((p) => isMarket(p.iso3) && p.value_usd > 0).slice(0, TOP_BUYERS);
  const total = (exp?.partners ?? []).filter((p) => isMarket(p.iso3)).reduce((s, p) => s + p.value_usd, 0);
  if (!exp || !buyersRaw.length) {
    return json({ locked: false, available: false, reason: `No export partners are held for ${entity?.name} in this product.` }, 200, { 'cache-control': 'private, no-store' });
  }

  const homeFx = worldBankRates(home);
  const buyers = await Promise.all(buyersRaw.map(async (b) => {
    const [imp, rates] = await Promise.all([
      oracleProductDetail(cfg, b.iso3, 'M', hs).catch(() => null),
      worldBankRates(b.iso3),
    ]);
    let sat: Saturation | null = null;
    if (imp?.partners?.length) {
      sat = saturation(imp.partners.filter((p) => isMarket(p.iso3)).map((p) => ({ name: nameOf(p.iso3), value_usd: p.value_usd })));
    }
    const fx: FxRisk | null = rates ? fxRisk(rates) : null;
    return {
      iso3: b.iso3,
      name: nameOf(b.iso3),
      export_value_usd: b.value_usd,
      share_pct: total > 0 ? Math.round((b.value_usd / total) * 1000) / 10 : null,
      import_year: imp?.latest_year ?? null,
      saturation: sat,
      saturation_note: sat ? null : `Tereflow does not hold ${nameOf(b.iso3)}'s imports of this product yet, so its market cannot be judged.`,
      fx,
      fx_note: fx ? null : 'Exchange rate history could not be retrieved.',
    };
  }));
  const homeRates = await homeFx;

  return json(
    {
      locked: false,
      available: true,
      country: entity?.name ?? home,
      hs,
      export_year: exp.latest_year,
      buyers,
      home_fx: homeRates ? { iso3: home, name: nameOf(home), ...fxRisk(homeRates) } : null,
      sources: [
        'Export partners and buyer imports: UN Comtrade, as held by Tereflow.',
        'Exchange rates: World Bank indicator PA.NUS.FCRF, official annual average, local currency per US dollar.',
      ],
      limitations: [
        'Only the top three buyers are shown. Saturation is judged only for buyers whose imports Tereflow holds.',
        'Tariffs, non-tariff barriers, logistics cost and margin are not in this view yet. They need other sources and are labelled as estimates when added.',
      ],
    },
    200,
    { 'cache-control': 'private, max-age=300' },
  );
});
