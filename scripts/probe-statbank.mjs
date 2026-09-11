/**
 * Probe the Ghana StatBank endpoint for real, before anything is built on it.
 *
 * The refactor spec treats this API as the authoritative source, so the things
 * worth knowing up front are the ones that would quietly poison the analytics:
 * how many years there really are, whether the latest year is complete, and
 * what a value actually looks like when it comes back.
 */
const ENDPOINT = 'https://statsbank.statsghana.gov.gh/api/v1/en/Trade/trade_detail_hs2.px';

async function query(body, label) {
  const t = Date.now();
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(60_000),
  });
  const text = await r.text();
  console.log(`\n${label}: HTTP ${r.status} in ${Date.now() - t}ms, ${text.length} bytes`);
  if (!r.ok) {
    console.log('  body:', text.slice(0, 400));
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    console.log('  not JSON:', text.slice(0, 300));
    return null;
  }
}

function sel(code, values) {
  return { code, selection: { filter: 'item', values } };
}

// 1. One chapter, one partner, all years, annual totals. The smallest thing
//    that proves the whole path works.
const one = await query(
  {
    query: [
      sel('Valuation_Parameter', ['Value in US Dollars']),
      sel('Tradeflow', ['Import']),
      sel('Year', ['2021', '2022', '2023', '2024', '2025']),
      sel('Month', ['All Months']),
      sel('HS_2_digit', ['34 - Soap, organic surface-active agents, washing preparations, lubricating preparations, artificial waxes, prepared waxes, polishing or scouring preparations, candles and similar articles, modelling pastes, dental waxes and dental preparations with a basis of plaster']),
      sel('Partner_Country', ['China']),
    ],
    response: { format: 'json-stat2' },
  },
  'HS34 soap, imports from China, 2021-2025',
);

if (one) {
  console.log('  keys:', Object.keys(one).join(', '));
  console.log('  label:', one.label);
  if (one.value) console.log('  values:', JSON.stringify(one.value));
  if (one.dimension && one.id) {
    for (const d of one.id) {
      const cat = one.dimension[d]?.category;
      console.log(`  dim ${d}:`, JSON.stringify(Object.keys(cat?.label ?? cat?.index ?? {})).slice(0, 200));
    }
  }
}

// 2. Is the latest year complete? A partial year compared against a full one
//    reads as a collapse in demand, and nothing in the numbers says otherwise.
const monthly = await query(
  {
    query: [
      sel('Valuation_Parameter', ['Value in US Dollars']),
      sel('Tradeflow', ['Import']),
      sel('Year', ['2024', '2025']),
      sel('Month', ['January', 'February', 'March', 'April', 'May', 'June',
        'July', 'August', 'September', 'October', 'November', 'December']),
      sel('HS_2_digit', ['All Products']),
      sel('Partner_Country', ['All Partner Countries']),
    ],
    response: { format: 'json-stat2' },
  },
  'All products, all partners, monthly 2024 vs 2025',
);

if (monthly?.value) {
  const months = monthly.dimension?.Month?.category?.index ?? {};
  const years = monthly.dimension?.Year?.category?.index ?? {};
  const monthNames = Object.keys(months);
  const yearNames = Object.keys(years);
  console.log('\n  monthly coverage:');
  for (const y of yearNames) {
    const row = [];
    for (const m of monthNames) {
      const yi = years[y];
      const mi = months[m];
      const idx = yi * monthNames.length + mi;
      const v = monthly.value[idx];
      row.push(v == null ? '-' : 'X');
    }
    const present = row.filter((c) => c === 'X').length;
    console.log(`    ${y}: ${row.join('')}  (${present}/12 months reported)`);
  }
}
