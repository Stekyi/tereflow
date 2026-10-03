/** Regenerates oracle/tests/fixtures/ts_parity.json from the TypeScript analytics.
 *  node scripts/gen-oracle-parity.mjs   (the Python tests then check the port against it) */
import { build } from 'esbuild';
import { writeFileSync, rmSync } from 'node:fs';
const OUT = '.tmp-parity.mjs';
await build({ entryPoints: ['scripts/entry-analytics.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', target: 'node20' });
const { computeMetrics, buildOpportunities, GHANA } = await import(`./../${OUT}`);
const scenarios = [
  { flow: 'M', code: '870323', desc: 'Cars 1500-3000cc', years: { 2020: 8e6, 2021: 9e6, 2022: 10.5e6, 2023: 12e6, 2024: 14e6 }, weight: 4e6, partners: { USA: 5e6, CHN: 4e6, JPN: 3e6, DEU: 2e6 } },
  { flow: 'M', code: '340111', desc: 'Soap', years: { 2021: 3e6, 2022: 2.5e6, 2023: 2e6, 2024: 1.6e6 }, weight: null, partners: { CHN: 1.0e6, IND: 0.6e6 } },
  { flow: 'M', code: '100630', desc: 'Rice', years: { 2020: 5e6, 2021: 12e6, 2022: 4e6, 2023: 14e6, 2024: 5e6 }, weight: 9e6, partners: { VNM: 2e6, THA: 1.5e6, USA: 1.0e6, IND: 0.5e6 } },
  { flow: 'M', code: '430110', desc: 'Furskins', years: { 2022: 90e3, 2023: 100e3, 2024: 120e3 }, weight: 1000, partners: { ITA: 120e3 } },
  { flow: 'M', code: '271019', desc: 'Petroleum oils', years: { 2022: 1e9, 2023: 1.2e9, 2024: 1.5e9 }, weight: 2e9, partners: { NLD: 1e9, USA: 0.5e9 } },
  { flow: 'M', code: '210690', desc: 'Food prep', years: { 2024: 6e6 }, weight: 2e6, partners: { USA: 3.1e6, FRA: 2.9e6 } },
  { flow: 'X', code: '180100', desc: 'Cocoa beans', years: { 2020: 1.0e9, 2021: 1.1e9, 2022: 1.3e9, 2023: 1.5e9, 2024: 2.0e9 }, weight: 5e8, partners: { NLD: 0.9e9, MYS: 0.6e9, USA: 0.5e9 } },
  { flow: 'X', code: '200820', desc: 'Pineapples prepared', years: { 2021: 2e6, 2022: 3e6, 2023: 3.2e6, 2024: 4.5e6 }, weight: 1e6, partners: { GBR: 2e6, NLD: 1.5e6, FRA: 1e6 } },
  { flow: 'M', code: '190590', desc: 'Bakers wares', years: { 2019: 1e6, 2022: 5e6, 2024: 7e6 }, weight: 3e6, partners: { ZAF: 3e6, GBR: 2e6, TUR: 2e6 } },
  { flow: 'M', code: '732393', desc: 'Steel tableware', years: { 2022: 4e6, 2023: 4.2e6, 2024: 4.4e6 }, weight: 1e6, partners: { CHN: 3.9e6, IND: 0.5e6 } },
];
const obs = [];
let id = 0;
for (const s of scenarios) {
  const flow = s.flow === 'M' ? 'import' : 'export';
  const yrs = Object.keys(s.years).map(Number).sort();
  for (const y of yrs) {
    const latest = y === yrs[yrs.length - 1];
    const parts = latest ? Object.entries(s.partners) : [['OLD', s.years[y]]];
    parts.forEach(([p, v], i) => obs.push({
      id: id++, country_code: 'GH', year: y, month: 0, trade_flow: flow, classification_system: 'HS',
      classification_level: 'HS6', product_code: s.code, product_description: s.desc,
      partner_country: p, partner_iso3: p, import_value_usd: v, net_weight_kg: i === 0 ? s.weight : null,
      value_is_derived: false, months_counted: 12, source: 't', source_endpoint: null, retrieved_at: 'x',
    }));
  }
}
const opps = buildOpportunities(computeMetrics(obs), GHANA);
writeFileSync('oracle/tests/fixtures/ts_parity.json', JSON.stringify({
  scenarios,
  expected: opps.map(o => ({ flow: o.trade_flow === 'import' ? 'M' : 'X', code: o.product_code, score: o.opportunity_score,
    breakdown: o.score_breakdown, signal: o.signal_type, confidence: o.data_confidence, reasons: o.confidence_reasons,
    excluded: o.is_excluded, excluded_reason: o.excluded_reason, explanation: o.explanation, evidence: o.evidence,
    limitations: o.limitations, trend: o.metrics.trend })),
}, null, 1));
rmSync(OUT);
console.log('scenarios', scenarios.length, 'opportunities', opps.length);
