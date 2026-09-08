/**
 * Does the precomputed layer agree with the facts it was computed from?
 *
 * product_analytics and opportunity_signals are what the product pages read.
 * If they drift from trade_facts, every figure on screen is wrong and nothing
 * fails: the tables are internally consistent, the pages render, the tests
 * pass. This recomputes from source and compares.
 */
import { openDb, q } from './dbq.mjs';

const db = openDb();
let bad = 0;
let checked = 0;
const problems = [];

function near(a, b, tol = 0.005) {
  if (a == null || b == null) return a == b;
  const d = Math.abs(a - b);
  return d <= Math.max(Math.abs(a), Math.abs(b), 1) * tol;
}

console.log('\n=== product_analytics.value_usd vs SUM(trade_facts) ===');

const rows = q(db, `
  SELECT entity_id, flow, year, hs_code, value_usd, qty_kg, share, unit_value_usd_t
  FROM product_analytics
  ORDER BY value_usd DESC
  LIMIT 300`);

for (const r of rows) {
  checked++;
  const src = q(db, `
    SELECT SUM(value_usd) v, SUM(qty) qty, COUNT(*) n
    FROM trade_facts
    WHERE entity_id = ? AND flow = ? AND year = ? AND hs_code = ?`,
    r.entity_id, r.flow, r.year, r.hs_code)[0];
  if (src.n === 0) {
    bad++;
    problems.push({ kind: 'no_source', ...r });
    continue;
  }
  if (!near(r.value_usd, src.v)) {
    bad++;
    problems.push({ kind: 'value_mismatch', entity: r.entity_id, hs: r.hs_code, year: r.year, flow: r.flow, precomputed: r.value_usd, source: src.v });
  }
}
console.log(`checked ${checked} of the largest rows, ${bad} disagreed with trade_facts`);
problems.slice(0, 8).forEach((p) => console.log('  ', JSON.stringify(p)));

console.log('\n=== share: is it really a share? ===');
// share should be this product's value over the country's total for that flow
// and year. A share above 1 means the denominator is wrong; shares that do not
// sum to about 1 across a country-year mean the same.
const over = q(db, 'SELECT COUNT(*) n FROM product_analytics WHERE share > 1.0001')[0].n;
console.log('rows with share > 1 :', over);

const sums = q(db, `
  SELECT entity_id, flow, year, SUM(share) s, COUNT(*) n
  FROM product_analytics
  GROUP BY entity_id, flow, year
  HAVING n > 5
  ORDER BY ABS(1 - SUM(share)) DESC
  LIMIT 10`);
console.log('worst share sums (should be near 1):');
sums.forEach((s) => console.log(`   ${s.entity_id} ${s.flow} ${s.year}  sum=${s.s?.toFixed(4)}  over ${s.n} products`));

console.log('\n=== unit value sanity ===');
// unit_value_usd_t is dollars per tonne. A mis-declared weight produces prices
// that are absurd, and one absurd price drags any median or ranking built on
// them. This bit the project before with gold at 697,170 dollars a tonne.
const uv = q(db, `
  SELECT entity_id, hs_code, year, flow, value_usd, qty_kg, unit_value_usd_t
  FROM product_analytics
  WHERE unit_value_usd_t IS NOT NULL
  ORDER BY unit_value_usd_t DESC LIMIT 8`);
uv.forEach((r) => console.log(`   ${String(r.unit_value_usd_t).padStart(22)} $/t  ${r.entity_id} ${r.hs_code} ${r.year} ${r.flow}  (v=${r.value_usd}, kg=${r.qty_kg})`));

const uvLow = q(db, `
  SELECT entity_id, hs_code, year, unit_value_usd_t, value_usd, qty_kg
  FROM product_analytics
  WHERE unit_value_usd_t IS NOT NULL AND unit_value_usd_t > 0
  ORDER BY unit_value_usd_t ASC LIMIT 5`);
console.log('  lowest:');
uvLow.forEach((r) => console.log(`   ${String(r.unit_value_usd_t).padStart(22)} $/t  ${r.entity_id} ${r.hs_code} ${r.year}  (v=${r.value_usd}, kg=${r.qty_kg})`));

// Recompute unit value from the two columns beside it.
let uvBad = 0;
const uvAll = q(db, 'SELECT value_usd, qty_kg, unit_value_usd_t FROM product_analytics WHERE unit_value_usd_t IS NOT NULL AND qty_kg > 0 LIMIT 500');
for (const r of uvAll) {
  const expect = r.value_usd / (r.qty_kg / 1000);
  if (!near(expect, r.unit_value_usd_t, 0.01)) uvBad++;
}
console.log(`unit value recomputed on ${uvAll.length} rows, ${uvBad} disagreed`);

console.log('\n=== CAGR sanity ===');
const cagr = q(db, 'SELECT COUNT(*) n FROM product_analytics WHERE cagr_pct IS NOT NULL')[0].n;
const cagrWild = q(db, `
  SELECT entity_id, hs_code, flow, year, cagr_pct, value_usd
  FROM product_analytics WHERE cagr_pct IS NOT NULL
  ORDER BY ABS(cagr_pct) DESC LIMIT 5`);
console.log(`cagr present on ${cagr} rows; largest magnitudes:`);
cagrWild.forEach((r) => console.log(`   ${String(r.cagr_pct?.toFixed(1)).padStart(14)}%  ${r.entity_id} ${r.hs_code} ${r.flow} ${r.year} v=${r.value_usd}`));

console.log('\n=== analysis_results payload vs trade_facts ===');
const an = q(db, `
  SELECT a.entity_id, e.slug, a.kind, a.payload, a.computed_at
  FROM analysis_results a JOIN entities e ON e.id = a.entity_id
  WHERE a.kind = 'overview' LIMIT 12`);
let anBad = 0;
for (const r of an) {
  let p;
  try { p = JSON.parse(r.payload); } catch { console.log(`   ${r.slug}: payload is not JSON`); anBad++; continue; }
  const y = p.year;
  if (!y) { console.log(`   ${r.slug}: no year in payload`); anBad++; continue; }
  const src = q(db, `
    SELECT
      SUM(CASE WHEN flow='export' THEN value_usd ELSE 0 END) ex,
      SUM(CASE WHEN flow='import' THEN value_usd ELSE 0 END) im
    FROM trade_facts WHERE entity_id = ? AND year = ?`, r.entity_id, y)[0];
  const exOk = near(p.export_usd, src.ex, 0.02);
  const imOk = near(p.import_usd, src.im, 0.02);
  if (!exOk || !imOk) {
    anBad++;
    console.log(`   MISMATCH ${r.slug} ${y}: payload ex=${p.export_usd} im=${p.import_usd} | facts ex=${src.ex} im=${src.im}`);
  } else {
    console.log(`   ok ${r.slug} ${y}`);
  }
}
console.log(`${an.length} overviews checked, ${anBad} disagreed`);

console.log('\n=== is_active vs data ===');
const activeNo = q(db, `
  SELECT e.slug, e.kind FROM entities e
  WHERE e.is_active = 1 AND e.kind='country'
    AND NOT EXISTS (SELECT 1 FROM trade_facts f WHERE f.entity_id = e.id)`);
console.log(`countries active with no trade rows: ${activeNo.length}`);
activeNo.slice(0, 20).forEach((r) => console.log('   ', r.slug));

const inactiveWith = q(db, `
  SELECT e.slug, COUNT(f.id) n FROM entities e JOIN trade_facts f ON f.entity_id=e.id
  WHERE e.is_active = 0 GROUP BY e.slug ORDER BY n DESC LIMIT 10`);
console.log(`inactive entities that hold trade rows: ${inactiveWith.length}`);
inactiveWith.forEach((r) => console.log('   ', r.slug, r.n));

console.log('\n=== self-partner detail ===');
const self = q(db, `
  SELECT e.slug, f.year, f.flow, f.hs_code, f.product_name, f.value_usd, f.source_ref
  FROM trade_facts f JOIN entities e ON e.id=f.entity_id
  WHERE UPPER(f.partner_iso3)=UPPER(e.iso3)`);
self.forEach((r) => console.log('  ', JSON.stringify(r)));

db.close();
