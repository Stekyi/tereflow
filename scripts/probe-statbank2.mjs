/**
 * Is the latest StatBank year complete, and how granular is the data really?
 *
 * Both questions decide whether the refactor can do what the spec wants. A
 * partial latest year compared against a full one reads as a collapse in
 * demand, and nothing in the numbers themselves would say otherwise.
 */
const ENDPOINT = 'https://statsbank.statsghana.gov.gh/api/v1/en/Trade/trade_detail_hs2.px';

async function q(query, label) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, response: { format: 'json-stat2' } }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(`${label}: HTTP ${r.status} ${text.slice(0, 200)}`);
    return null;
  }
  return JSON.parse(text);
}
const sel = (code, values) => ({ code, selection: { filter: 'item', values } });

/** Read a json-stat2 cube by dimension labels rather than guessed index maths. */
function reader(js) {
  const ids = js.id;
  const sizes = js.size;
  const idx = {};
  for (const d of ids) idx[d] = js.dimension[d].category.index;
  return (pick) => {
    let offset = 0;
    for (let i = 0; i < ids.length; i++) {
      const d = ids[i];
      const key = pick[d];
      const map = idx[d];
      const pos = typeof map === 'object' && !Array.isArray(map) ? map[key] : map.indexOf(key);
      if (pos == null || pos < 0) return undefined;
      offset = offset * sizes[i] + pos;
    }
    return js.value[offset];
  };
}

console.log('\n1. Monthly reporting by year, all products, all partners');
console.log('--------------------------------------------------------');
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];
const m = await q([
  sel('Valuation_Parameter', ['Value in US Dollars']),
  sel('Tradeflow', ['Import']),
  sel('Year', ['2021', '2022', '2023', '2024', '2025']),
  sel('Month', MONTHS),
  sel('HS_2_digit', ['All Products']),
  sel('Partner_Country', ['All Partner Countries']),
], 'monthly');

if (m) {
  const get = reader(m);
  for (const year of ['2021', '2022', '2023', '2024', '2025']) {
    const cells = MONTHS.map((mo) => get({
      Valuation_Parameter: 'Value in US Dollars',
      Tradeflow: 'Import',
      Year: year,
      Month: mo,
      HS_2_digit: 'All Products',
      Partner_Country: 'All Partner Countries',
    }));
    const present = cells.filter((v) => v != null && v > 0).length;
    const total = cells.reduce((s, v) => s + (v ?? 0), 0);
    console.log(
      `  ${year}: ${cells.map((v) => (v != null && v > 0 ? 'X' : '.')).join('')}  ` +
      `${present}/12 months, $${(total / 1e9).toFixed(2)}bn`,
    );
  }
}

console.log('\n2. Annual import totals, all partners');
console.log('-------------------------------------');
const a = await q([
  sel('Valuation_Parameter', ['Value in US Dollars']),
  sel('Tradeflow', ['Import']),
  sel('Year', ['2021', '2022', '2023', '2024', '2025']),
  sel('Month', ['All Months']),
  sel('HS_2_digit', ['All Products']),
  sel('Partner_Country', ['All Partner Countries']),
], 'annual');
if (a) {
  const get = reader(a);
  for (const year of ['2021', '2022', '2023', '2024', '2025']) {
    const v = get({
      Valuation_Parameter: 'Value in US Dollars',
      Tradeflow: 'Import',
      Year: year,
      Month: 'All Months',
      HS_2_digit: 'All Products',
      Partner_Country: 'All Partner Countries',
    });
    console.log(`  ${year}: ${v == null ? 'NULL' : '$' + (v / 1e9).toFixed(2) + 'bn'}`);
  }
}

console.log('\n3. How many partners actually report, and how sparse is a chapter?');
console.log('------------------------------------------------------------------');
const meta = await (await fetch(ENDPOINT, { signal: AbortSignal.timeout(30_000) })).json();
const partners = meta.variables.find((v) => v.code === 'Partner_Country').values
  .filter((p) => p !== 'All Partner Countries');
const chapters = meta.variables.find((v) => v.code === 'HS_2_digit').values
  .filter((p) => p !== 'All Products');
console.log(`  partners offered: ${partners.length}, chapters offered: ${chapters.length}`);

// One chapter across a realistic partner set, to see how many cells come back null.
const SAMPLE = ['China', 'India', 'United States', 'Netherlands', 'United Kingdom',
  'South Africa', 'Nigeria', 'Turkey', 'Germany', 'Belgium'];
const s = await q([
  sel('Valuation_Parameter', ['Value in US Dollars']),
  sel('Tradeflow', ['Import']),
  sel('Year', ['2024']),
  sel('Month', ['All Months']),
  sel('HS_2_digit', [chapters.find((c) => c.startsWith('34 -'))]),
  sel('Partner_Country', SAMPLE),
], 'sparsity');
if (s) {
  const get = reader(s);
  const rows = SAMPLE.map((p) => [p, get({
    Valuation_Parameter: 'Value in US Dollars',
    Tradeflow: 'Import',
    Year: '2024',
    Month: 'All Months',
    HS_2_digit: chapters.find((c) => c.startsWith('34 -')),
    Partner_Country: p,
  })]);
  console.log('  HS34 soap imports 2024 by partner:');
  for (const [p, v] of rows) {
    console.log(`    ${p.padEnd(16)} ${v == null ? 'null' : '$' + (v / 1e6).toFixed(1) + 'm'}`);
  }
  const nulls = rows.filter(([, v]) => v == null).length;
  console.log(`  ${nulls} of ${rows.length} partner cells are null`);
}

console.log('\n4. Is net weight reported alongside value?');
console.log('------------------------------------------');
const w = await q([
  sel('Valuation_Parameter', ['Value in US Dollars', 'Net weight in KG']),
  sel('Tradeflow', ['Import']),
  sel('Year', ['2024']),
  sel('Month', ['All Months']),
  sel('HS_2_digit', [chapters.find((c) => c.startsWith('34 -'))]),
  sel('Partner_Country', ['China']),
], 'weight');
if (w) {
  const get = reader(w);
  for (const param of ['Value in US Dollars', 'Net weight in KG']) {
    const v = get({
      Valuation_Parameter: param,
      Tradeflow: 'Import',
      Year: '2024',
      Month: 'All Months',
      HS_2_digit: chapters.find((c) => c.startsWith('34 -')),
      Partner_Country: 'China',
    });
    console.log(`  ${param.padEnd(22)} ${v == null ? 'null' : v}`);
  }
}
