// Sanity check for the product insight endpoint.
// Cocoa beans have a publicly known world price, so they make a good honesty
// check on the unit-value maths: if $/tonne comes out wildly off, the
// arithmetic is wrong regardless of what the code says.
const BASE = process.env.TF_BASE ?? 'http://127.0.0.1:8787';
const hs = process.argv[2] ?? '180100';

const r = await fetch(`${BASE}/api/insight/${hs}`, { headers: { accept: 'application/json' } });
const d = await r.json();

const money = (n) => (n == null ? 'n/a' : `$${(n / 1e6).toFixed(1)}M`);
const perT = (n) => (n == null ? 'no weight' : `$${Math.round(n).toLocaleString()}/t`);

console.log(`\n${d.name}  [HS ${d.hs_code}]  ${d.sector}`);
console.log(`  world median price   ${perT(d.world_median_usd_t)}`);
console.log(`  headline             ${money(d.value_usd)} in ${d.year}, ${perT(d.unit_value_usd_t)}, ${d.price_premium}` +
  (d.price_from_name ? `  (price from ${d.price_from_name})` : ''));
console.log(`  reporting countries  ${d.totals.reporting_countries} of ${d.totals.countries_with_data} with data`);
console.log(`  partner-level flows  ${d.partner_detail_available}`);
console.log(`  subscribers          ${d.subscriber_count}`);

console.log('\n  SELLS THE MOST');
for (const s of d.sellers.slice(0, 6)) {
  const t = s.qty_kg ? `${Math.round(s.qty_kg / 1000).toLocaleString()} t` : 'no weight';
  console.log(
    `    ${String(s.rank).padStart(2)}  ${s.name.padEnd(16)} ${money(s.value_usd).padStart(9)}  ` +
      `${t.padStart(12)}  ${perT(s.unit_value_usd_t).padStart(12)}  ${s.price_premium}`,
  );
}

console.log('\n  BUYS THE MOST');
for (const b of d.buyers.slice(0, 6)) {
  console.log(
    `    ${String(b.rank).padStart(2)}  ${b.name.padEnd(16)} ${money(b.value_usd).padStart(9)}  ` +
      `${perT(b.unit_value_usd_t).padStart(12)}`,
  );
}

console.log('\n  DEMAND GROWING FASTEST');
for (const t of d.target_markets.slice(0, 6)) {
  console.log(`    ${t.name.padEnd(16)} ${money(t.value_usd).padStart(9)}  ${Math.round(t.cagr_pct)}%/yr`);
}
console.log('');
