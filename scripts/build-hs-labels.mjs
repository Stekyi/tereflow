import { writeFileSync } from 'node:fs';

// UN Comtrade's own classification reference file: every HS (Harmonized
// System) code at every digit level, with a plain-English description. This
// is a static international standard (WCO/UN Stats), not business data, and
// it is a *separate* endpoint from the rate-limited trade-data preview API,
// so fetching it once here avoids ever needing it at request time.
const SRC = 'https://comtradeapi.un.org/files/v1/app/reference/H5.json';

const res = await fetch(SRC, { headers: { accept: 'application/json' } });
if (!res.ok) throw new Error(`Failed to fetch HS reference data: HTTP ${res.status}`);
const body = await res.json();
const entries = body.results ?? [];

// aggrlevel 6 + isLeaf '1' = the specific, tradeable line item -- "Fruit,
// edible; pineapples, fresh or dried" rather than the parent grouping
// "Fruit, dried" or the chapter "Fruit & nuts".
const map = {};
for (const e of entries) {
  if (e.aggrlevel !== 6 || e.isLeaf !== '1') continue;
  const code = String(e.id ?? '').trim();
  if (!/^\d{6}$/.test(code)) continue;
  // text looks like "080430 - Fruit, edible; pineapples, fresh or dried".
  const desc = String(e.text ?? '').replace(/^\d{6}\s*-\s*/, '').trim();
  if (desc) map[code] = desc;
}

console.log(`mapped ${Object.keys(map).length} HS6 leaf codes out of ${entries.length} reference entries`);

const body_ = Object.keys(map)
  .sort()
  .map((k) => `  '${k}': ${JSON.stringify(map[k])},`)
  .join('\n');

const out = `/**
 * HS6 (6-digit Harmonized System) code -> plain English description.
 * Generated from UN Comtrade's own classification reference
 * (${SRC}), which is a static international standard, not
 * business data that changes -- see scripts/build-hs-labels.mjs to rebuild
 * after a Harmonized System revision.
 */
export const HS6_LABEL: Record<string, string> = {
${body_}
};
`;

const OUT = 'worker/agent/hs6-codes.generated.ts';
writeFileSync(OUT, out);
console.log(`wrote ${OUT}`);
