/**
 * Forensic data audit against the local D1.
 *
 * Read only. Every check here is a way the database can be wrong while every
 * page still renders and every test still passes. The point is not to confirm
 * the app works, it is to find the numbers that are quietly untrue.
 */
import { openDb, q } from './dbq.mjs';

const db = openDb();
const findings = [];

function finding(severity, title, detail, evidence) {
  findings.push({ severity, title, detail, evidence });
}

function has(table) {
  return q(db, "SELECT 1 FROM sqlite_master WHERE type='table' AND name=?", table).length > 0;
}

const one = (sql, ...p) => {
  const r = q(db, sql, ...p);
  return r.length ? Object.values(r[0])[0] : null;
};

console.log('\n=== SCALE ===');
for (const t of ['entities', 'trade_facts', 'analysis_results', 'analysis_runs', 'entity_sources',
                 'product_analytics', 'opportunity_signals', 'export_classifications',
                 'indicator_observations', 'sector_observations', 'data_uploads', 'users',
                 'business_cards', 'messages', 'feed_items']) {
  if (!has(t)) { console.log(`${t.padEnd(24)} MISSING`); continue; }
  console.log(`${t.padEnd(24)} ${one(`SELECT COUNT(*) FROM ${t}`)}`);
}

console.log('\n=== TRADE FACTS ===');

const tfCols = q(db, 'PRAGMA table_info(trade_facts)').map((c) => c.name);
console.log('columns:', tfCols.join(', '));

// A zero dollar value is not a fact. Either the source said zero, which is
// vanishingly rare in trade data, or something wrote a placeholder where a
// missing number belonged. The second reads as real and drags every average.
const zero = one("SELECT COUNT(*) FROM trade_facts WHERE value_usd = 0");
console.log('value_usd = 0 :', zero);
if (zero > 0) {
  const sample = q(db, "SELECT entity_id, year, flow, hs_code, product_name, source_ref FROM trade_facts WHERE value_usd = 0 LIMIT 5");
  finding('high', 'Trade rows stored with value_usd = 0',
    `${zero} rows hold a zero dollar value. Zero trade is nearly always an absent figure written as a number. These rows count as real in every total, average and ranking.`,
    JSON.stringify(sample));
}

const neg = one("SELECT COUNT(*) FROM trade_facts WHERE value_usd < 0");
console.log('value_usd < 0 :', neg);
if (neg > 0) {
  finding('medium', 'Negative trade values',
    `${neg} rows have a negative value_usd. Re-exports and adjustments can be negative in some publications, but they break sums and share calculations unless handled deliberately.`,
    JSON.stringify(q(db, "SELECT entity_id, year, flow, hs_code, value_usd FROM trade_facts WHERE value_usd < 0 LIMIT 5")));
}

const nullUsd = one("SELECT COUNT(*) FROM trade_facts WHERE value_usd IS NULL");
console.log('value_usd IS NULL :', nullUsd);

// Year sanity.
const yr = q(db, "SELECT MIN(year) lo, MAX(year) hi FROM trade_facts")[0];
console.log('year range :', yr.lo, '-', yr.hi);
const nowY = new Date().getUTCFullYear();
if (yr.hi > nowY) {
  finding('high', 'Trade data dated in the future',
    `Latest year is ${yr.hi}, later than the current year ${nowY}. A future year sorts to the top of every "latest" query and would be shown as the current picture.`,
    JSON.stringify(q(db, "SELECT entity_id, year, COUNT(*) n FROM trade_facts WHERE year > ? GROUP BY entity_id, year LIMIT 10", nowY)));
}
if (yr.lo < 1960) {
  finding('medium', 'Implausibly old trade year', `Earliest year is ${yr.lo}.`, '');
}

// Duplicates on the logical key. Two rows for one fact double the money.
const dupSql = `
  SELECT entity_id, year, flow, stream, IFNULL(partner_iso3,''), IFNULL(hs_code,''), IFNULL(sector,''), COUNT(*) n
  FROM trade_facts
  GROUP BY entity_id, year, flow, stream, IFNULL(partner_iso3,''), IFNULL(hs_code,''), IFNULL(sector,'')
  HAVING COUNT(*) > 1
  ORDER BY n DESC LIMIT 10`;
const dups = q(db, dupSql);
const dupTotal = one(`SELECT COUNT(*) FROM (${dupSql.replace('LIMIT 10','')})`);
console.log('duplicate logical keys :', dupTotal ?? 0);
if (dups.length) {
  finding('high', 'Duplicate trade facts',
    `${dupTotal} logical keys appear more than once. Each duplicate counts twice in every total and ranking.`,
    JSON.stringify(dups.slice(0, 5)));
}

// Orphans.
const orphan = one("SELECT COUNT(*) FROM trade_facts f LEFT JOIN entities e ON e.id = f.entity_id WHERE e.id IS NULL");
console.log('orphan trade_facts :', orphan);
if (orphan > 0) {
  finding('medium', 'Trade rows with no country',
    `${orphan} rows point at an entity_id that does not exist. They are invisible in the UI but counted by any query that does not join.`, '');
}

// Flow and stream vocabulary.
console.log('flows :', JSON.stringify(q(db, "SELECT flow, COUNT(*) n FROM trade_facts GROUP BY flow")));
console.log('streams :', JSON.stringify(q(db, "SELECT stream, COUNT(*) n FROM trade_facts GROUP BY stream")));

// Partner pointing at itself is a reporting artefact that inflates a country's
// own numbers against itself.
if (tfCols.includes('partner_iso3')) {
  const self = q(db, `
    SELECT e.slug, f.year, f.flow, COUNT(*) n, SUM(f.value_usd) v
    FROM trade_facts f JOIN entities e ON e.id = f.entity_id
    WHERE UPPER(f.partner_iso3) = UPPER(e.iso3)
    GROUP BY e.slug, f.year, f.flow LIMIT 5`);
  console.log('self-partner rows :', self.length);
  if (self.length) {
    finding('medium', 'Country trading with itself',
      'Rows where partner_iso3 equals the reporting country. That is a reporting artefact, and it inflates both the total and that partner ranking.',
      JSON.stringify(self));
  }
}

// A "World" or "Total" partner mixed in with real partners is double counting:
// the total is the sum of the others, and summing all of them doubles it.
if (tfCols.includes('partner_name')) {
  const totals = q(db, `
    SELECT partner_iso3, partner_name, COUNT(*) n, SUM(value_usd) v
    FROM trade_facts
    WHERE partner_name IS NOT NULL
      AND (LOWER(partner_name) IN ('world','total','all','all countries','world total')
           OR LOWER(IFNULL(partner_iso3,'')) IN ('wld','w00','all','tot'))
    GROUP BY partner_iso3, partner_name`);
  console.log('aggregate partner rows :', JSON.stringify(totals));
  if (totals.length) {
    finding('high', 'Aggregate partner mixed with real partners',
      'Rows whose partner is World or Total sit alongside per-country rows. Any sum over partners counts the trade twice, and the aggregate outranks every real partner in a "top partners" list.',
      JSON.stringify(totals));
  }
}

console.log('\n=== ANALYSIS CONSISTENCY ===');

if (has('analysis_results')) {
  const arCols = q(db, 'PRAGMA table_info(analysis_results)').map((c) => c.name);
  console.log('analysis_results columns:', arCols.join(', '));
  const rows = q(db, 'SELECT * FROM analysis_results LIMIT 3');
  if (rows.length) {
    const r = rows[0];
    for (const [k, v] of Object.entries(r)) {
      const s = typeof v === 'string' ? v.slice(0, 120) : v;
      console.log(`  ${k}: ${s}`);
    }
  }

  // Countries with trade data but no analysis are silently blank in the UI.
  const noAnalysis = q(db, `
    SELECT e.slug, COUNT(f.id) n
    FROM entities e JOIN trade_facts f ON f.entity_id = e.id
    WHERE NOT EXISTS (SELECT 1 FROM analysis_results a WHERE a.entity_id = e.id)
    GROUP BY e.slug ORDER BY n DESC LIMIT 10`);
  console.log('entities with facts but no analysis :', noAnalysis.length);
  if (noAnalysis.length) {
    finding('medium', 'Countries with trade data but no analysis',
      `${noAnalysis.length} countries hold trade rows but have no analysis row, so their pages have nothing to show even though the data is there.`,
      JSON.stringify(noAnalysis));
  }

  // Analysis older than the newest fact it describes is stale: the page shows
  // conclusions drawn before the data it claims to summarise.
  if (arCols.includes('created_at') || arCols.includes('updated_at')) {
    const col = arCols.includes('updated_at') ? 'updated_at' : 'created_at';
    const stale = q(db, `
      SELECT e.slug, a.${col} analysed, MAX(f.year) latest_fact_year
      FROM analysis_results a
      JOIN entities e ON e.id = a.entity_id
      JOIN trade_facts f ON f.entity_id = a.entity_id
      GROUP BY e.slug, a.${col} LIMIT 5`);
    console.log('analysis sample:', JSON.stringify(stale));
  }
}

console.log('\n=== ENTITIES ===');
const eCols = q(db, 'PRAGMA table_info(entities)').map((c) => c.name);
console.log('columns:', eCols.join(', '));
console.log('by kind:', JSON.stringify(q(db, 'SELECT kind, COUNT(*) n FROM entities GROUP BY kind')));
if (eCols.includes('activated')) {
  console.log('activated:', JSON.stringify(q(db, 'SELECT activated, COUNT(*) n FROM entities GROUP BY activated')));
  const activeNoData = q(db, `
    SELECT e.slug FROM entities e
    WHERE e.activated = 1 AND NOT EXISTS (SELECT 1 FROM trade_facts f WHERE f.entity_id = e.id)
    LIMIT 20`);
  console.log('activated with no trade data :', activeNoData.length);
  if (activeNoData.length) {
    finding('high', 'Activated countries with no data',
      `${activeNoData.length} countries are switched on but hold no trade rows. Activation is what tells the app a country is ready to show, so these present as available and then have nothing behind them.`,
      JSON.stringify(activeNoData.slice(0, 15)));
  }
}

// Duplicate slugs or ISO3 codes split one country in two.
for (const col of ['slug', 'iso3']) {
  if (!eCols.includes(col)) continue;
  const d = q(db, `SELECT ${col}, COUNT(*) n FROM entities WHERE ${col} IS NOT NULL AND ${col} <> '' GROUP BY LOWER(${col}) HAVING COUNT(*) > 1`);
  console.log(`duplicate ${col} :`, d.length);
  if (d.length) {
    finding('high', `Duplicate ${col} in entities`,
      `The same ${col} appears on more than one row, so one country exists twice and its data is split between them.`,
      JSON.stringify(d));
  }
}

console.log('\n=== PRECOMPUTED TABLES vs SOURCE ===');
if (has('product_analytics')) {
  const paCols = q(db, 'PRAGMA table_info(product_analytics)').map((c) => c.name);
  console.log('product_analytics columns:', paCols.join(', '));
  console.log('rows:', one('SELECT COUNT(*) FROM product_analytics'));
  const sample = q(db, 'SELECT * FROM product_analytics LIMIT 2');
  sample.forEach((r) => console.log('  ', JSON.stringify(r).slice(0, 300)));
}
if (has('opportunity_signals')) {
  console.log('opportunity_signals rows:', one('SELECT COUNT(*) FROM opportunity_signals'));
}

console.log('\n=== MANUAL DATA TABLES ===');
for (const t of ['data_uploads', 'upload_issues', 'indicator_observations', 'sector_observations']) {
  if (!has(t)) continue;
  console.log(`${t}: ${one(`SELECT COUNT(*) FROM ${t}`)}`);
}
if (has('data_uploads')) {
  console.log('upload statuses:', JSON.stringify(q(db, 'SELECT import_status, COUNT(*) n FROM data_uploads GROUP BY import_status')));
  // An upload marked imported whose rows are gone means a revert removed the
  // rows without moving the status, and the history would then be lying.
  const ghost = q(db, `
    SELECT u.id, u.filename, u.rows_written
    FROM data_uploads u
    WHERE u.import_status = 'imported'
      AND u.rows_written > 0
      AND NOT EXISTS (SELECT 1 FROM trade_facts f WHERE f.source_ref = 'upload:' || u.id)
      AND NOT EXISTS (SELECT 1 FROM indicator_observations i WHERE i.upload_id = u.id)
      AND NOT EXISTS (SELECT 1 FROM sector_observations s WHERE s.upload_id = u.id)`);
  console.log('uploads marked imported with no rows:', ghost.length);
  if (ghost.length) {
    finding('high', 'Upload history disagrees with the data',
      'An upload is marked imported and claims rows written, but none of those rows exist. The history is telling the administrator something that is not true.',
      JSON.stringify(ghost));
  }
}

console.log('\n=== SOURCES ===');
if (has('entity_sources')) {
  const sCols = q(db, 'PRAGMA table_info(entity_sources)').map((c) => c.name);
  console.log('columns:', sCols.join(', '));
  console.log('rows:', one('SELECT COUNT(*) FROM entity_sources'));
  if (sCols.includes('fmt')) console.log('by fmt:', JSON.stringify(q(db, 'SELECT fmt, COUNT(*) n FROM entity_sources GROUP BY fmt ORDER BY n DESC')));
}

console.log('\n\n=== FINDINGS ===');
if (!findings.length) console.log('none');
for (const f of findings) {
  console.log(`\n[${f.severity.toUpperCase()}] ${f.title}`);
  console.log(`  ${f.detail}`);
  if (f.evidence) console.log(`  evidence: ${f.evidence.slice(0, 700)}`);
}
console.log(`\n${findings.length} finding(s)\n`);
db.close();
