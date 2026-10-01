/**
 * Focused invariants for /api/trade/sandbox.
 *   npm run test:sandbox
 */
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-trade-sandbox.mjs';
await build({
  entryPoints: ['worker/routes/public.ts'],
  outfile: OUT,
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
});
const { pub } = await import(`./../${OUT}`);

const currentYear = new Date().getUTCFullYear();
const years = Array.from({ length: 5 }, (_, i) => currentYear - 1 - (4 - i));
const older = years[years.length - 2];
const latest = years[years.length - 1];

const primaryRows = [
  { year: older, flow: 'export', partner_iso3: 'DEU', hs_code: '100100', product_name: 'Wheat', value_usd: 100, qty_kg: 10 },
  { year: older, flow: 'export', partner_iso3: 'USA', hs_code: '100100', product_name: 'Wheat', value_usd: 50, qty_kg: 5 },
  // Overlapping HS8 rows must be ignored because this year is HS6.
  { year: older, flow: 'export', partner_iso3: 'DEU', hs_code: '10010001', product_name: 'Wheat detail', value_usd: 999, qty_kg: 99 },
  { year: latest, flow: 'export', partner_iso3: 'DEU', hs_code: '10010001', product_name: 'Wheat detail', value_usd: 200, qty_kg: 20 },
  { year: latest, flow: 'export', partner_iso3: 'USA', hs_code: '10010001', product_name: 'Wheat detail', value_usd: 50, qty_kg: 5 },
  // Overlapping HS6 rows must be ignored because this year is HS8.
  { year: latest, flow: 'export', partner_iso3: 'DEU', hs_code: '100100', product_name: 'Wheat', value_usd: 888, qty_kg: 88 },
  { year: latest, flow: 'import', partner_iso3: 'DEU', hs_code: '10010001', product_name: 'Wheat detail', value_usd: 30, qty_kg: 3 },
];

const levels = [
  { year: older, flow: 'export', classification_length: 6 },
  { year: latest, flow: 'export', classification_length: 8 },
  { year: latest, flow: 'import', classification_length: 8 },
];

const db = {
  prepare(sql) {
    return {
      bind(...args) {
        return {
          async first() {
            if (sql.includes("FROM entities WHERE kind='country'")) {
              return { id: 'ghana-id', slug: 'ghana', name: 'Ghana', iso3: 'GHA' };
            }
            throw new Error(`Unexpected first query: ${sql}`);
          },
          async all() {
            if (sql.includes('MAX(length(hs_code))')) return { results: levels };
            if (sql.includes('GROUP BY year, flow, UPPER(partner_iso3)')) return { results: primaryRows };
            if (sql.includes('GROUP BY year, flow, hs_code')) {
              const totals = new Map();
              for (const row of primaryRows) {
                const key = `${row.year}|${row.flow}|${row.hs_code}`;
                const total = totals.get(key) ?? { year: row.year, flow: row.flow, hs_code: row.hs_code, value_usd: 0 };
                total.value_usd += row.value_usd;
                totals.set(key, total);
              }
              return { results: [...totals.values()] };
            }
            throw new Error(`Unexpected all query: ${sql}`);
          },
        };
      },
    };
  },
};

async function sandbox(partners) {
  const response = await pub.request(
    '/trade/sandbox',
    { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ primary: 'ghana', partners }) },
    { DB: db },
  );
  if (!response.ok) throw new Error(`Sandbox request failed: ${response.status} ${await response.text()}`);
  return response.json();
}

const germanyOnly = await sandbox(['DEU']);
const germany = germanyOnly.partners[0];
const olderProduct = germany.products.find((p) => p.year === older && p.flow === 'export');
const latestProduct = germany.products.find((p) => p.year === latest && p.flow === 'export');
const olderTotal = germanyOnly.primary_product_totals.find((p) => p.year === older && p.flow === 'export' && p.hs_code === '100100');
const latestTotal = germanyOnly.primary_product_totals.find((p) => p.year === latest && p.flow === 'export' && p.hs_code === '10010001');

function check(label, condition, detail = '') {
  if (!condition) throw new Error(`FAIL ${label}${detail ? `: ${detail}` : ''}`);
  console.log(`PASS ${label}`);
}

check('older year keeps HS6 partner rows', olderProduct?.value_usd === 100);
check('older year keeps HS6 all-partner total', olderTotal?.value_usd === 150);
check('latest year keeps HS8 partner rows', latestProduct?.value_usd === 200);
check('latest year keeps HS8 all-partner total', latestTotal?.value_usd === 250);
check('overlapping classification rows are not double-counted', !germany.products.some((p) => p.value_usd >= 888));
check('selected-partner value is included in total', latestProduct.value_usd <= latestTotal.value_usd);
check('selected partners do not define total', (await sandbox(['DEU', 'USA'])).primary_product_totals.find((p) => p.year === latest && p.flow === 'export' && p.hs_code === '10010001')?.value_usd === 250);
check('market share uses all-partner total', (latestProduct.value_usd / latestTotal.value_usd) * 100 === 80);
check('flow remains separate', germany.products.some((p) => p.flow === 'import' && p.value_usd === 30));
check('missing partner is explicit', (await sandbox(['OMN'])).partners[0].reporter_basis === 'none');

rmSync(OUT, { force: true });
console.log('Sandbox checks passed.');