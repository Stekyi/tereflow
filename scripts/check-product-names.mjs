// Sanity check for shared/product-name.ts against the real descriptions
// Comtrade returns. Run: node scripts/check-product-names.mjs
import { execFileSync } from 'node:child_process';
import { shortProductName } from '../shared/product-name.ts';

const SQL =
  'SELECT DISTINCT product_name FROM trade_facts ' +
  "WHERE length(hs_code)=6 AND product_name IS NOT NULL LIMIT 400";

// shell:true is needed on Windows to run the npx shim, which also means the
// SQL has to carry its own quoting -- passing it as a bare argv entry lets the
// shell word-split it.
const raw = execFileSync(
  'npx',
  ['wrangler', 'd1', 'execute', 'tereflow', '--local', '--json', '--command', `"${SQL}"`],
  { encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 },
);

const start = raw.indexOf('[');
const rows = JSON.parse(raw.slice(start))[0].results;

let overLong = 0;
let unchanged = 0;
const samples = [];
const byShort = new Map();

for (const { product_name } of rows) {
  const short = shortProductName(product_name);
  if (short.length > 62) overLong++;
  if (short === product_name) unchanged++;
  if (!byShort.has(short)) byShort.set(short, []);
  byShort.get(short).push(product_name);
  if (samples.length < 25 && product_name.length > 45) {
    samples.push([product_name, short]);
  }
}

for (const [from, to] of samples) {
  console.log(`  ${to}\n    <- ${from}\n`);
}

// Two different HS lines that shorten to the same string are unreadable in a
// list, so they matter more than any single ugly name.
const collisions = [...byShort.entries()].filter(([, originals]) => originals.length > 1);
if (collisions.length) {
  console.log('\nCOLLISIONS (same short name, different products):');
  for (const [short, originals] of collisions.slice(0, 10)) {
    console.log(`  "${short}" <- ${originals.length}`);
    for (const o of originals.slice(0, 3)) console.log(`      ${o.slice(0, 110)}`);
  }
}

console.log(
  `\n${rows.length} descriptions, ${unchanged} already short, ${overLong} over 62 chars, ` +
    `${collisions.length} colliding names`,
);
