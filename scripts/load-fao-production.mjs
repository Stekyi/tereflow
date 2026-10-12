/**
 * Loads FAOSTAT crop production into D1 from the bulk file.
 *   node scripts/load-fao-production.mjs            (writes migrations-data SQL, then you apply it)
 * Reads local/fao/x/*Normalized*.csv. Streams the 545 MB file and keeps only the mapped crops, the Production
 * (tonnes, element 5510) and Area harvested (element 5312) rows, and real countries.
 */
import fs from 'node:fs';
import readline from 'node:readline';
import { build } from 'esbuild';
import { rmSync } from 'node:fs';

const OUT = '.tmp-production-load.mjs';
await build({ entryPoints: ['shared/production.ts'], outfile: OUT, bundle: true, platform: 'node', format: 'esm', logLevel: 'silent' });
const { PRODUCTION_ITEMS } = await import(`../${OUT}`);
rmSync(OUT);

const dir = 'local/fao/x';
const csv = fs.readdirSync(dir).find((f) => /Normalized.*\.csv$/.test(f));
const m49 = JSON.parse(fs.readFileSync('oracle/tereflow_oracle/data/iso3_m49.json', 'utf8'));
const byM49 = new Map(Object.entries(m49).map(([iso3, code]) => [Number(code), iso3]));
// FAO lists China as an aggregate (156 is mainland); every other country code is the standard M49 one.
const NAME_FIX = new Map([[156, 'CHN']]);
const wantItems = new Map(PRODUCTION_ITEMS.map((p) => [p.faoCode, p.item]));

function fields(line) {
  const out = []; let cur = ''; let q = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (q) { if (ch === '"' && line[i + 1] === '"') { cur += '"'; i++; } else if (ch === '"') q = false; else cur += ch; }
    else if (ch === '"') q = true; else if (ch === ',') { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur); return out;
}

const acc = new Map();
let seen = 0, kept = 0, nameMismatch = 0;
const rl = readline.createInterface({ input: fs.createReadStream(`${dir}/${csv}`, 'utf8'), crlfDelay: Infinity });
let header = true;
for await (const line of rl) {
  if (header) { header = false; continue; }
  seen++;
  const f = fields(line);
  const item = Number(f[3]);
  if (!wantItems.has(item)) continue;
  const element = f[6];
  if (element !== '5510' && element !== '5312') continue;
  const code = Number(String(f[1]).replace("'", ''));
  const iso3 = NAME_FIX.get(code) ?? byM49.get(code);
  if (!iso3) continue;
  if (f[5] !== wantItems.get(item)) { nameMismatch++; continue; }
  const year = Number(f[9]); const value = f[11] === '' ? null : Number(f[11]);
  if (!Number.isFinite(year)) continue;
  const key = `${iso3}|${item}|${year}`;
  const row = acc.get(key) ?? { iso3, item, year, tonnes: null, area: null, flag: null };
  if (element === '5510') { row.tonnes = value; row.flag = f[12] || null; } else row.area = value;
  acc.set(key, row); kept++;
}
if (nameMismatch) { console.error(`REFUSING: ${nameMismatch} rows had an item name that does not match the table`); process.exit(1); }

const rows = [...acc.values()].filter((r) => r.tonnes != null || r.area != null);
const esc = (s) => (s == null ? 'NULL' : `'${String(s).replace(/'/g, "''")}'`);
const num = (n) => (n == null ? 'NULL' : String(n));
const lines = ['DELETE FROM crop_production;'];
for (let i = 0; i < rows.length; i += 400) {
  const chunk = rows.slice(i, i + 400).map((r) => `(${esc(r.iso3)},${r.item},${r.year},${num(r.tonnes)},${num(r.area)},${esc(r.flag)})`);
  lines.push(`INSERT INTO crop_production (iso3, fao_item, year, tonnes, area_ha, flag) VALUES ${chunk.join(',')};`);
}
lines.push(`INSERT OR REPLACE INTO crop_production_meta (id, source_file, file_date, rows_loaded) VALUES (1, ${esc(csv)}, ${esc(fs.statSync(`${dir}/${csv}`).mtime.toISOString().slice(0, 10))}, ${rows.length});`);
fs.mkdirSync('local/fao', { recursive: true });
fs.writeFileSync('local/fao/load.sql', lines.join('\n'));
const countries = new Set(rows.map((r) => r.iso3));
console.log(`scanned ${seen.toLocaleString()} rows, kept ${rows.length.toLocaleString()} country-crop-years for ${countries.size} countries; wrote local/fao/load.sql (${(fs.statSync('local/fao/load.sql').size / 1e6).toFixed(1)} MB)`);
