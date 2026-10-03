/** Regenerates oracle/tests/fixtures/ts_dashboard_parity.json from worker/agent/analyse.ts.
 *  node scripts/gen-oracle-dashboard-parity.mjs */
import { build } from 'esbuild';
import { writeFileSync, readFileSync, rmSync } from 'node:fs';
const OUT = '.tmp-dash-parity.mjs';
await build({ stdin: { contents: "export { analyse } from './worker/agent/analyse';", resolveDir: '.', loader: 'ts' },
  outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
const { analyse } = await import(`./../${OUT}`);
const names = JSON.parse(readFileSync('oracle/tereflow_oracle/data/iso3_name.json', 'utf8'));

// Deterministic pseudo-data: 24 products, 6 partners, years 2021-2024, both flows.
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const years = [2021, 2022, 2023, 2024];
const partners = ['USA', 'CHN', 'DEU', 'NGA', 'IND', 'GHA'];
const products = [];
for (let i = 0; i < 24; i++) {
  const ch = ['18', '85', '87', '10', '27', '84'][i % 6];
  products.push({ code: ch + String(1000 + i * 37).slice(0, 4), desc: `Product ${i} (${ch})`,
    base: Math.round(2e5 + rnd() * 6e7), growth: 0.85 + rnd() * 0.5 });
}
const facts = []; // python side: (flow, year, code, desc, value)
const rows = [];
const partnerTot = {};
for (const flow of ['X', 'M']) {
  for (const y of years) {
    let tot = 0;
    const chap = {};
    for (const p of products) {
      const v = Math.round(p.base * Math.pow(p.growth, y - 2021) * (flow === 'X' ? 1 : 1.7));
      // some lines are missing in some years
      if ((p.code.charCodeAt(2) + y + (flow === 'X' ? 1 : 0)) % 11 === 0) continue;
      facts.push({ flow, year: y, code: p.code, desc: p.desc, value: v });
      tot += v; chap[p.code.slice(0, 2)] = (chap[p.code.slice(0, 2)] ?? 0) + v;
      rows.push({ year: y, flow: flow === 'X' ? 'export' : 'import', stream: 'goods', partner_iso3: null, partner_name: null,
        hs_code: p.code, product_name: p.desc, sector: null, value_usd: v, source_ref: 't' });
      partners.forEach((pi, k) => {
        const share = [0.35, 0.25, 0.15, 0.11, 0.09, 0.05][k];
        const key = `${flow}|${y}|${pi}`;
        partnerTot[key] = (partnerTot[key] ?? 0) + v * share;
      });
    }
    rows.push({ year: y, flow: flow === 'X' ? 'export' : 'import', stream: 'goods', partner_iso3: null, partner_name: null,
      hs_code: null, product_name: null, sector: null, value_usd: tot, source_ref: 't' });
    for (const [c, v] of Object.entries(chap)) rows.push({ year: y, flow: flow === 'X' ? 'export' : 'import', stream: 'goods',
      partner_iso3: null, partner_name: null, hs_code: c, product_name: c, sector: null, value_usd: v, source_ref: 't' });
  }
}
const partnerFacts = [];
for (const [key, v] of Object.entries(partnerTot)) {
  const [flow, y, pi] = key.split('|');
  partnerFacts.push({ flow, year: +y, iso3: pi, value: v });
  rows.push({ year: +y, flow: flow === 'X' ? 'export' : 'import', stream: 'goods', partner_iso3: pi, partner_name: names[pi],
    hs_code: null, product_name: null, sector: null, value_usd: v, source_ref: 't' });
}
const ctx = { gdp_by_year: {}, services_export_by_year: {}, services_import_by_year: {}, gns_export_by_year: {}, gns_import_by_year: {} };
const b = analyse('Ghana', rows, ctx, ['un-comtrade'], [], undefined, 'GHA', new Map());
writeFileSync('oracle/tests/fixtures/ts_dashboard_parity.json', JSON.stringify({
  facts, partnerFacts, thisYear: new Date().getUTCFullYear(),
  expected: { overview: b.overview, top_exports: b.top_exports, top_imports: b.top_imports,
    partners_export: b.partners_export, partners_import: b.partners_import, trend: b.yearly_trend },
}, null, 1));
rmSync(OUT);
console.log('facts', facts.length, 'overview year', b.overview.year, 'top export', b.top_exports[0]?.name);



