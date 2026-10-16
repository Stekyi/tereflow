import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { oracleConfig, oracleJson } from '../lib/oracle';
import { oracleProductDetail } from '../lib/oracle-insight';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { ISO3_NAME } from '../../shared/country-names';
import { readTariff, type TariffRead, type TariffRow } from '../../shared/tariff';
import { isMarket } from '../../shared/markets';

/**
 * Import tariffs facing one country's exports of one product, in that country's main buying markets.
 * Reads tariffs held in Oracle only; it never calls the tariff source from a request. Reads only.
 */
export const tariffs = new Hono<{ Bindings: Env }>();

const TOP_BUYERS = 4;
// Comtrade's catch-all areas are not countries with a tariff; see shared/markets.ts.
// Belgium, France and the Netherlands apply the EU tariff, which the source reports as one reporter.
const EU_MEMBERS = new Set(['AUT', 'BEL', 'BGR', 'HRV', 'CYP', 'CZE', 'DNK', 'EST', 'FIN', 'FRA', 'DEU', 'GRC', 'HUN', 'IRL', 'ITA', 'LVA', 'LTU', 'LUX', 'MLT', 'NLD', 'POL', 'PRT', 'ROU', 'SVK', 'SVN', 'ESP', 'SWE']);

tariffs.get('/:country/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = c.req.param('hs').replace(/[\s.]/g, '');
  if (!/^\d{6}$/.test(hs)) return bad('hs must be a 6-digit product code', 400);
  const key = c.req.param('country').trim().toLowerCase();
  const entity = await c.env.DB.prepare("SELECT iso3, name FROM entities WHERE kind = 'country' AND (slug = ? OR lower(iso3) = ?)")
    .bind(key, key).first<{ iso3: string | null; name: string }>();
  const home = entity?.iso3?.toUpperCase();
  if (!home) return bad('Unknown country', 404);

  const cfg = oracleConfig(c.env);
  if (!cfg) return json({ available: false, reason: 'Trade data is not connected.' }, 200, { 'cache-control': 'public, max-age=300' });

  const exp = await oracleProductDetail(cfg, home, 'X', hs).catch(() => null);
  const partners = (exp?.partners ?? []).filter((p) => isMarket(p.iso3) && p.value_usd > 0);
  if (!exp || !partners.length) {
    return json({ available: false, reason: `No export partners are held for ${entity?.name} in this product.` }, 200, { 'cache-control': 'public, max-age=300' });
  }

  // Group EU members into one market so the EU tariff is not repeated per member.
  const seen = new Set<string>();
  const markets: { reporter: string; label: string; value_usd: number; members: string[] }[] = [];
  for (const p of partners) {
    const reporter = EU_MEMBERS.has(p.iso3) ? 'EUN' : p.iso3;
    if (seen.has(reporter)) {
      const m = markets.find((x) => x.reporter === reporter)!;
      m.value_usd += p.value_usd;
      m.members.push(ISO3_NAME[p.iso3] ?? p.iso3);
      continue;
    }
    seen.add(reporter);
    markets.push({ reporter, label: reporter === 'EUN' ? 'European Union' : (ISO3_NAME[reporter] ?? reporter), value_usd: p.value_usd, members: reporter === 'EUN' ? [ISO3_NAME[p.iso3] ?? p.iso3] : [] });
  }
  markets.sort((a, b) => b.value_usd - a.value_usd);

  const out = await Promise.all(markets.slice(0, TOP_BUYERS).map(async (m) => {
    const held = await oracleJson<{ rows: TariffRow[] }>(cfg, { route: 'tariff', iso3: m.reporter, code: hs }).catch(() => null);
    const read: TariffRead = readTariff(held?.rows ?? [], m.reporter === 'EUN' ? 'The European Union' : m.label);
    return {
      market: m.label,
      reporter: m.reporter,
      export_value_usd: m.value_usd,
      applies_to: m.reporter === 'EUN' ? m.members : [],
      tariff: read,
    };
  }));

  const verified = out.filter((o) => o.tariff.status === 'verified').length;
  return json(
    {
      available: true,
      country: entity?.name ?? home,
      hs,
      export_year: exp.latest_year,
      markets: out,
      coverage: { markets_shown: out.length, markets_with_verified_tariff: verified },
      notes: [
        'Tariffs come from UNCTAD TRAINS through the World Bank WITS service and are loaded in advance, so a market can show as unavailable until it has been loaded.',
        'The EU is one tariff area, so Belgium, France, the Netherlands and the other members share one rate.',
      ],
    },
    200,
    { 'cache-control': 'public, max-age=900' },
  );
});
