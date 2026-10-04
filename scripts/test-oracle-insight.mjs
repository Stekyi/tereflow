/**
 * The product views built from Oracle feeds: insight, product page, market view, search catalogue.
 *   node scripts/test-oracle-insight.mjs
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-oracle-insight-test.mjs';
await build({
  stdin: { contents: "export * from './worker/lib/oracle-insight';\nexport { DEFAULTS } from './worker/lib/settings';", resolveDir: '.', loader: 'ts' },
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node20',
  external: ['cloudflare:*'],
});
const m = await import(`./../${OUT}`);
const { rowsForCode, buildInsight, buildProductDetail, buildMarketProducts, catalogueFrom, relatedFor, timeSeriesFrom, partnerBreakdownFrom, premiumFrom, DEFAULTS } = m;

let passed = 0, failed = 0;
const check = (label, ok, detail = '') => {
  if (ok) { passed++; console.log(`  PASS  ${label}`); } else { failed++; console.log(`  FAIL  ${label} ${detail}`); }
};

const item = (o) => ({ flow: 'X', code: '090111', level: 'HS6', name: 'Coffee', year: 2025, value_usd: 10e6, cagr_3y: 20, yoy_pct: 5, score: 60,
  confidence: 'high', signal: 'export_growth', top_partner: 'USA', top_share_pct: 40, partner_count: 5, unit_value_usd_t: 2000,
  years_available: 5, trend: 'growing', ...o });
const ent = (slug, name, iso3) => ({ id: `ent_${slug}`, slug, name, iso3, continent: 'Africa' });
const dash = (exp, imp) => ({ overview: { year: 2025, export_usd: exp, import_usd: imp }, top_exports: [], top_imports: [], partners_export: [{ rank: 1, code: 'USA', name: 'United States', value_usd: 1, share_pct: 50 }], partners_import: [], trend: [], computed_at: null });
const country = (slug, name, iso3, items, exp = 1e9, imp = 1e9) => ({ e: ent(slug, name, iso3), feed: { reporter: iso3, latest_year: 2025, count: items.length, products: items }, dash: dash(exp, imp) });
const S = { ...DEFAULTS };

const data = [
  country('ghana', 'Ghana', 'GHA', [item({ value_usd: 50e6, unit_value_usd_t: 3000 }), item({ flow: 'M', value_usd: 5e6, unit_value_usd_t: 2500, cagr_3y: 40 }), item({ code: '090121', name: 'Roasted coffee', value_usd: 8e6 }), item({ code: '090111', year: 2022, value_usd: 99e9 })]),
  country('kenya', 'Kenya', 'KEN', [item({ value_usd: 30e6, unit_value_usd_t: 5000, cagr_3y: 10 }), item({ code: '090112', name: 'Decaf', value_usd: 4e6 })]),
  country('peru', 'Peru', 'PER', [item({ flow: 'M', value_usd: 20e6, unit_value_usd_t: 2800, cagr_3y: 55 })], 1e9, 4e9),
];

console.log('\nrowsForCode');
const rows = rowsForCode(data, '090111', S);
check('one row per country and direction, latest year only (a stale 2022 line is ignored)', rows.length === 4 && rows.every((r) => r.year === 2025));
const gx = rows.find((r) => r.e.slug === 'ghana' && r.flow === 'export');
check('latest-year value is used, not the stale one', gx.value_usd === 50e6);
check('share is a fraction of the country total in that direction', Math.abs(gx.share - 0.05) < 1e-9, String(gx.share));
check('price ratio is against the world median over countries above the pricing floor', rows.every((r) => r.unit_value_usd_t == null || r.price_ratio > 0));
const chap = rowsForCode(data, '09', S).find((r) => r.e.slug === 'ghana' && r.flow === 'export');
check('a chapter sums every line beneath it', chap.value_usd === 58e6, String(chap.value_usd));
check('growth and unit value are blank when several lines are summed', chap.cagr_pct === null && chap.unit_value_usd_t === null);
check('a code nobody trades gives no rows', rowsForCode(data, '270900', S).length === 0);

console.log('\npremium');
check('high', premiumFrom(1.3, 1.15, 0.85) === 'high');
check('low', premiumFrom(0.7, 1.15, 0.85) === 'low');
check('typical', premiumFrom(1.0, 1.15, 0.85) === 'typical');
check('unknown without a ratio', premiumFrom(null, 1.15, 0.85) === 'unknown');

console.log('\nbuildInsight');
const base = { hs: '090111', focusSlug: null, focusFlow: null, data, settings: S, series: null, subscribers: [], category: 'non_traditional', fullName: 'Coffee; not roasted' };
const ins = buildInsight(base);
check('sellers are ranked by value', ins.sellers.map((r) => r.slug).join() === 'ghana,kenya');
check('buyers are ranked by value', ins.buyers.map((r) => r.slug).join() === 'peru,ghana');
check('without a focus the headline is the largest seller', ins.value_usd === 50e6 && ins.focus_slug === null);
check('target markets rank importers by growth, not size', ins.target_markets[0].slug === 'peru');
check('totals sum each direction', ins.totals.export_usd === 80e6 && ins.totals.import_usd === 25e6);
check('three countries reporting, three with data', ins.totals.reporting_countries === 3 && ins.totals.countries_with_data === 3);
check('a score exists and is named after the country it belongs to', typeof ins.score === 'number' && ins.score_from_name === 'Ghana');
check('the score breakdown is present and its total equals the score', ins.score_breakdown && ins.score_breakdown.score === ins.score);
check('world median price is computed', ins.world_median_usd_t > 0);
check('no focus means no time series and no partner flows', ins.time_series.length === 0 && ins.partner_flows === null);

const series = { reporter: 'KEN', flow: 'X', code: '090111', name: 'Coffee', level: 'HS6', latest_year: 2025,
  series: [{ year: 2023, value_usd: 20e6, qty_kg: 4e6 }, { year: 2024, value_usd: 25e6, qty_kg: null }, { year: 2025, value_usd: 30e6, qty_kg: 6e6 }],
  partners: [{ iso3: 'USA', value_usd: 20e6, qty_kg: 4e6 }, { iso3: 'DEU', value_usd: 10e6, qty_kg: null }] };
const foc = buildInsight({ ...base, focusSlug: 'kenya', focusFlow: 'export', series });
check('focus scopes the headline to that country and direction', foc.focus_slug === 'kenya' && foc.value_usd === 30e6 && foc.focus_flow === 'export');
check('time series carries yoy and a unit value only where a weight exists', foc.time_series[1].yoy_pct === 25 && foc.time_series[1].unit_value_usd_t === null && foc.time_series[0].unit_value_usd_t === 5000);
check('partner flows carry shares that add up', Math.abs(foc.partner_flows.partners.reduce((s, p) => s + p.share_pct, 0) - 100) < 1e-9);
check('partner flows name the partner and keep a missing weight as null', foc.partner_flows.partners[1].net_weight_kg === null && foc.partner_flows.partners[0].partner === 'United States');
check('partner detail is flagged available', foc.partner_detail_available === true);
const importFocus = buildInsight({ ...base, focusSlug: 'ghana', focusFlow: 'import', series: { ...series, flow: 'M', reporter: 'GHA' } });
check('focus honours the direction the reader came in on', importFocus.focus_flow === 'import' && importFocus.value_usd === 5e6);
const none = buildInsight({ ...base, hs: '270900' });
check('a product nobody trades is an empty shell with a null score, not a fake zero', none.score === null && none.sellers.length === 0 && none.value_usd === 0);

console.log('\nproduct page and market view');
const det = buildProductDetail({ hs: '090111', data, settings: S, topN: 10, category: 'non_traditional', fullName: 'Coffee', partners: [] });
check('exporters and importers are ranked', det.exporters[0].slug === 'ghana' && det.importers[0].slug === 'peru');
check('totals add the listed countries', det.total_export_usd === 80e6);
check('partial coverage is flagged when a growth rate is missing', buildProductDetail({ hs: '09', data, settings: S, topN: 10, category: 'non_traditional', fullName: 'x', partners: [] }).partial_coverage === true);
const top1 = buildProductDetail({ hs: '090111', data, settings: S, topN: 1, category: 'non_traditional', fullName: 'Coffee', partners: [] });
check('the top-N limit is applied per side', top1.exporters.length === 1 && top1.importers.length === 1);
const mk = buildMarketProducts({ hs: '090111', data, settings: S, topN: 10, category: 'non_traditional', label: 'Coffee' });
check('market view lists both sides', mk.exporters.length === 2 && mk.importers.length === 2);
check('partners are keyed by every listed country', ['ghana', 'kenya', 'peru'].every((s) => s in mk.partners_by_slug));
check('partner lists come from each country dashboard', mk.partners_by_slug.ghana.export[0].name === 'United States');

console.log('\nrelated and catalogue');
const rel = relatedFor(data, '090111');
check('related lists other 6-digit lines in the chapter, largest first, without the product itself', rel.length >= 1 && rel.every((r) => r.hs_code !== '090111') && rel[0].value_usd >= rel[rel.length - 1].value_usd);
check('no related list for a chapter-level request', relatedFor(data, '09').length === 0);
const cat = catalogueFrom(data);
check('catalogue has one entry per 6-digit product and ignores stale years', cat.length === 3 && cat.find((c) => c.hs_code === '090111').total_value === 5e6 + 50e6 + 30e6 + 20e6);
check('catalogue keeps a name', cat.find((c) => c.hs_code === '090121').product_name === 'Roasted coffee');

console.log('\nseries helpers');
check('an empty detail gives an empty series', timeSeriesFrom(null).length === 0);
check('no partners means no breakdown', partnerBreakdownFrom({ ...series, partners: [] }, 'Kenya', '090111') === null);

rmSync(OUT);
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
