/**
 * Two things the refactor would get wrong without checking.
 *
 * First: whether "All Months" can be trusted as the annual figure. Second:
 * whether the app's own country names are the names StatBank uses. A partner
 * name that does not match is not an error anybody sees, it is a country that
 * quietly returns nothing.
 */
const ENDPOINT = 'https://statsbank.statsghana.gov.gh/api/v1/en/Trade/trade_detail_hs2.px';
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'];

const meta = await (await fetch(ENDPOINT, { signal: AbortSignal.timeout(30_000) })).json();
const partnerValues = meta.variables.find((v) => v.code === 'Partner_Country').values;
const chapters = meta.variables.find((v) => v.code === 'HS_2_digit').values;
const HS34 = chapters.find((c) => c.startsWith('34 -'));

async function q(query, label) {
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json' },
    body: JSON.stringify({ query, response: { format: 'json-stat2' } }),
    signal: AbortSignal.timeout(90_000),
  });
  const text = await r.text();
  if (!r.ok) {
    console.log(`  ${label}: HTTP ${r.status}`);
    return null;
  }
  return JSON.parse(text);
}
const sel = (code, values) => ({ code, selection: { filter: 'item', values } });

function reader(js) {
  const ids = js.id;
  const sizes = js.size;
  const idx = {};
  for (const d of ids) idx[d] = js.dimension[d].category.index;
  return (pick) => {
    let offset = 0;
    for (let i = 0; i < ids.length; i++) {
      const map = idx[ids[i]];
      const key = pick[ids[i]];
      const pos = Array.isArray(map) ? map.indexOf(key) : map[key];
      if (pos == null || pos < 0) return undefined;
      offset = offset * sizes[i] + pos;
    }
    return js.value[offset];
  };
}

console.log('\n1. Does "All Months" agree with the sum of the twelve months?');
console.log('-------------------------------------------------------------');
console.log('   If a year has months but no All Months total, any pipeline that');
console.log('   asks for All Months loses that year without saying so.\n');

for (const year of ['2023', '2024', '2025']) {
  const all = await q([
    sel('Valuation_Parameter', ['Value in US Dollars']),
    sel('Tradeflow', ['Import']),
    sel('Year', [year]),
    sel('Month', ['All Months']),
    sel('HS_2_digit', [HS34]),
    sel('Partner_Country', ['China']),
  ], `${year} all-months`);

  const monthly = await q([
    sel('Valuation_Parameter', ['Value in US Dollars']),
    sel('Tradeflow', ['Import']),
    sel('Year', [year]),
    sel('Month', MONTHS),
    sel('HS_2_digit', [HS34]),
    sel('Partner_Country', ['China']),
  ], `${year} monthly`);

  const allVal = all ? reader(all)({
    Valuation_Parameter: 'Value in US Dollars', Tradeflow: 'Import', Year: year,
    Month: 'All Months', HS_2_digit: HS34, Partner_Country: 'China',
  }) : undefined;

  let sum = 0;
  let months = 0;
  if (monthly) {
    const get = reader(monthly);
    for (const mo of MONTHS) {
      const v = get({
        Valuation_Parameter: 'Value in US Dollars', Tradeflow: 'Import', Year: year,
        Month: mo, HS_2_digit: HS34, Partner_Country: 'China',
      });
      if (v != null) { sum += v; months++; }
    }
  }
  const allTxt = allVal == null ? 'NULL' : `$${(allVal / 1e6).toFixed(2)}m`;
  console.log(`  ${year}: All Months = ${allTxt.padEnd(12)} sum of ${months} months = $${(sum / 1e6).toFixed(2)}m`);
  if (allVal == null && sum > 0) {
    console.log(`         ^ the year HAS data but the All Months cell is empty`);
  }
}

console.log('\n2. Do this app\'s country names exist in StatBank?');
console.log('-------------------------------------------------');
// The names the app already uses, from worker/agent/country-names.ts.
const APP_NAMES = [
  'China', 'India', 'United States', 'Netherlands', 'United Kingdom',
  'South Africa', 'Nigeria', 'Turkiye', 'Germany', 'Belgium', 'France',
  'Japan', 'Korea, Rep.', 'Brazil', 'Spain', 'Italy', 'Canada', 'Thailand',
  'Viet Nam', 'Indonesia', 'United Arab Emirates', 'Russian Federation',
  'Cote d\'Ivoire', 'Togo', 'Burkina Faso', 'Egypt, Arab Rep.', 'Morocco',
];
const set = new Set(partnerValues);
const missing = [];
for (const n of APP_NAMES) {
  if (!set.has(n)) missing.push(n);
}
console.log(`  checked ${APP_NAMES.length} names, ${missing.length} not found verbatim`);
for (const n of missing) {
  const needle = n.toLowerCase().split(/[,(]/)[0].trim().slice(0, 6);
  const near = partnerValues.filter((p) => p.toLowerCase().includes(needle)).slice(0, 3);
  console.log(`    "${n}" -> StatBank has: ${near.length ? near.map((x) => `"${x}"`).join(', ') : 'nothing similar'}`);
}
