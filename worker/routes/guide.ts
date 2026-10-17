import { Hono } from 'hono';
import type { Env } from '../lib/db';
import { bad, json } from '../lib/db';
import { oracleConfig } from '../lib/oracle';
import { oracleProductDetail, type ProductDetailPayload } from '../lib/oracle-insight';
import { clientKey, rateLimit, tooMany } from '../lib/ratelimit';
import { currentUser, isEntitled } from '../lib/session';
import { ISO3_NAME } from '../../shared/country-names';
import { fxRisk, saturation } from '../../shared/prospect';
import { isMarket, partnerName } from '../../shared/markets';
import { relationshipsFor, type KbRow } from '../../shared/byproducts';
import { runGuide, unitUsdT, type GuideFacts, type Role } from '../../shared/guide';
import { worldBankRates } from './prospect';

/**
 * Problem-to-supply guide for one product in one country. Gathers facts the platform already holds and hands them to the
 * rule engine in shared/guide.ts. Premium. Reads only, and nothing in it calls a language model.
 */
export const guide = new Hono<{ Bindings: Env }>();

/** HS wording is long and often starts with a one-word heading, so keep enough of it to still make sense. */
const shortName = (full: string) => {
  const seg = full.split(';').map((s) => s.trim());
  return seg[0].length <= 12 && seg[1] ? `${seg[0]}: ${seg[1].split(',')[0].trim()}` : seg[0];
};
const nameOf = (iso3: string) => partnerName(iso3, ISO3_NAME);
const series = (d: ProductDetailPayload | null) => (d?.series ?? []).map((s) => ({ year: s.year, value_usd: s.value_usd, qty_kg: s.qty_kg ?? null }));
const partners = (d: ProductDetailPayload | null) =>
  (d?.partners ?? []).filter((p) => isMarket(p.iso3) && p.value_usd > 0).map((p) => ({ name: nameOf(p.iso3), iso3: p.iso3, value_usd: p.value_usd, qty_kg: p.qty_kg ?? null }));
const lastValue = (d: ProductDetailPayload | null) => (d?.series?.length ? d.series[d.series.length - 1].value_usd : null);

const KB_COLUMNS = `id, parent_name, parent_code, byproduct_name, byproduct_code, kind, process_method, applications, detail_sourced,
  status, confidence, byproduct_hs_official, hs_codes_checked, derivation_checked, trade_evidence_usd, trade_evidence_year,
  trade_evidence_note, evidence_note, source_name, source_url, verified_at`;

guide.get('/:country/:hs', async (c) => {
  const limited = await rateLimit(c.env, 'lookup', clientKey(c.req.raw));
  if (!limited.ok) return tooMany(limited);
  const hs = c.req.param('hs').replace(/[\s.]/g, '');
  if (!/^\d{6}$/.test(hs)) return bad('hs must be a 6-digit product code', 400);

  const viewer = await currentUser(c.req.raw, c.env);
  if (!isEntitled(viewer)) {
    return json({ locked: true, title: 'Problem to supply guide', teaser: 'A five-step walk from a product to the problems in its trade, research questions, and supply or procurement plays, with a risk label and a return range. Premium.' }, 200, { 'cache-control': 'private, no-store' });
  }

  const q = new URL(c.req.url).searchParams;
  const role: Role = q.get('role') === 'procurement' ? 'procurement' : 'supply';
  const rawBudget = Number(q.get('budget'));
  const budget = Number.isFinite(rawBudget) && rawBudget > 0 ? Math.min(rawBudget, 1e9) : null;

  const key = c.req.param('country').trim().toLowerCase();
  const entity = await c.env.DB.prepare("SELECT iso3, name FROM entities WHERE kind = 'country' AND (slug = ? OR lower(iso3) = ?)")
    .bind(key, key).first<{ iso3: string | null; name: string }>();
  const home = entity?.iso3?.toUpperCase();
  if (!home) return bad('Unknown country', 404);
  const cfg = oracleConfig(c.env);
  if (!cfg) return json({ locked: false, available: false, reason: 'Trade data is not connected.' }, 200, { 'cache-control': 'private, no-store' });

  const [exp, imp, homeRates, kb] = await Promise.all([
    oracleProductDetail(cfg, home, 'X', hs).catch(() => null),
    oracleProductDetail(cfg, home, 'M', hs).catch(() => null),
    worldBankRates(home),
    c.env.DB.prepare(`SELECT ${KB_COLUMNS} FROM kb_relationship WHERE ? LIKE parent_code || '%'`).bind(hs).all<KbRow>(),
  ]);
  if (!exp && !imp) {
    return json({ locked: false, available: false, reason: `Tereflow holds no ${entity?.name} trade in this product.` }, 200, { 'cache-control': 'private, no-store' });
  }

  const buyers = partners(exp).sort((a, b) => b.value_usd - a.value_usd);
  const suppliers = partners(imp).sort((a, b) => b.value_usd - a.value_usd);

  const buyer_markets = await Promise.all(buyers.slice(0, 3).map(async (b) => {
    const m = await oracleProductDetail(cfg, b.iso3, 'M', hs).catch(() => null);
    const sat = m?.partners?.length ? saturation(partners(m).map((p) => ({ name: p.name, value_usd: p.value_usd }))) : null;
    const lastPt = m?.series?.length ? m.series[m.series.length - 1] : null;
    return {
      name: b.name,
      saturation: (sat?.level ?? 'insufficient') as 'dominated' | 'few-main' | 'competitive' | 'insufficient',
      top_supplier: sat?.top_supplier ?? null,
      top_share_pct: sat?.top_share_pct ?? null,
      import_unit_usd_t: lastPt ? unitUsdT({ value_usd: lastPt.value_usd, qty_kg: lastPt.qty_kg ?? null }) : null,
      year: lastPt?.year ?? null,
    };
  }));

  const rel = relationshipsFor(kb.results ?? [], hs);
  const related = await Promise.all(rel.active.slice(0, 5).map(async (r) => {
    const six = r.byproduct_code && /^\d{6}$/.test(r.byproduct_code) ? r.byproduct_code : null;
    const [x, m] = six
      ? await Promise.all([oracleProductDetail(cfg, home, 'X', six).catch(() => null), oracleProductDetail(cfg, home, 'M', six).catch(() => null)])
      : [null, null];
    return { name: r.byproduct_name, code: r.byproduct_code, kind: r.kind, confidence: r.confidence, home_export_usd: lastValue(x), home_import_usd: lastValue(m) };
  }));

  const fx = homeRates ? fxRisk(homeRates) : null;
  const facts: GuideFacts = {
    country: entity?.name ?? home,
    product: shortName(exp?.name ?? imp?.name ?? `HS ${hs}`),
    hs, role, budget_usd: budget,
    exports: series(exp), imports: series(imp),
    buyers: buyers.map(({ name, value_usd, qty_kg }) => ({ name, value_usd, qty_kg })),
    suppliers: suppliers.map(({ name, value_usd, qty_kg }) => ({ name, value_usd, qty_kg })),
    buyer_markets, related,
    fx: fx ? { level: fx.level, reason: fx.reason } : null,
  };
  const result = runGuide(facts);

  // When the user typed a by-product, say plainly which trade is being shown: its own code, or its parent's.
  const via = q.get('via');
  let lens: { name: string; kind: string; confidence: string; parent_name: string; shown_through: 'own_code' | 'parent'; note: string } | null = null;
  if (via) {
    const row = await c.env.DB.prepare('SELECT byproduct_name, byproduct_code, kind, confidence, parent_name, parent_code FROM kb_relationship WHERE id = ?')
      .bind(via).first<{ byproduct_name: string; byproduct_code: string | null; kind: string; confidence: string; parent_name: string; parent_code: string | null }>();
    if (row) {
      const own = row.byproduct_code === hs;
      lens = {
        name: row.byproduct_name, kind: row.kind, confidence: row.confidence, parent_name: row.parent_name,
        shown_through: own ? 'own_code' : 'parent',
        note: own
          ? `${row.byproduct_name} is a ${row.kind} of ${row.parent_name}. The trade below is for its own code, which can include goods other than ${row.byproduct_name.toLowerCase()}.`
          : `${row.byproduct_name} is a ${row.kind} of ${row.parent_name} and has no trade code of its own. The trade below is for ${row.parent_name}, not for ${row.byproduct_name.toLowerCase()} itself. How much of it exists scales with that parent trade, but the amount is not measured here.`,
      };
      if (!own) {
        result.unavailable.unshift(`There is no trade data for ${row.byproduct_name.toLowerCase()} itself. Price, buyers and volume for it need a quote from a buyer or a local source.`);
        result.estimate = { available: false, low_usd: null, high_usd: null, basis: [], caveats: [`No return range is given: the prices held are for ${row.parent_name}, not for ${row.byproduct_name.toLowerCase()}.`] };
      }
    }
  }

  return json(
    {
      locked: false,
      available: true,
      inputs: { country: facts.country, product: facts.product, hs, role, budget_usd: budget },
      lens,
      ...result,
      sources: ['Trade values, quantities and partners: UN Comtrade, as held by Tereflow.', 'Related goods: Tereflow by-product knowledge base.', 'Exchange rates: World Bank PA.NUS.FCRF.'],
    },
    200,
    { 'cache-control': 'private, max-age=300' },
  );
});
