import { readFileSync, writeFileSync } from 'node:fs';

const wb = JSON.parse(readFileSync('data/wb-countries.json', 'utf8'));
const rows = wb[1] ?? [];
const want = new Set(JSON.parse(readFileSync('data/iso3-list.json', 'utf8')));

const map = {};
for (const r of rows) {
  // region.id === 'NA' marks aggregates (World, EU, income groups) rather than economies.
  if (r.id && want.has(r.id) && r.region && r.region.id !== 'NA') map[r.id] = r.name;
}

// Comtrade reports these as partners; the World Bank does not list them as economies.
Object.assign(map, {
  TWN: 'Taiwan',
  NCL: 'New Caledonia',
  PYF: 'French Polynesia',
  PRK: "Korea, Dem. People's Rep.",
  VEN: 'Venezuela',
  ERI: 'Eritrea',
  SYR: 'Syrian Arab Republic',
  YEM: 'Yemen',
});

const missing = [...want].filter((k) => !map[k]);
console.log(`mapped ${Object.keys(map).length}, missing ${missing.length}`);
if (missing.length) console.log('missing:', missing.join(', '));

const body = Object.keys(map)
  .sort()
  .map((k) => `  ${k}: ${JSON.stringify(map[k])},`)
  .join('\n');

const out = `/** ISO3 -> display name. Generated from the World Bank country list. */
export const ISO3_NAME: Record<string, string> = {
${body}
};
`;

writeFileSync('data/iso3-names.generated.ts', out);
console.log('wrote data/iso3-names.generated.ts');
