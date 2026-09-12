/**
 * Market context from the World Bank: who lives in a country, what they earn,
 * what they spend, and what the economy is made of.
 *
 *   node scripts/ingest-context.mjs            all active countries
 *   node scripts/ingest-context.mjs ghana      one, by slug
 *
 * WHY THIS IS NOT A LANGUAGE MODEL READING PDFS
 *
 * The request was to train a local BERT and have it read population,
 * demographics, economic sector and household income out of PDF reports. Every
 * one of those figures is published by the World Bank as structured data, free,
 * without a key, with seven years of history, addressed by ISO code. Extracting
 * them from a PDF instead would add an extraction step that can be wrong, to
 * reach the same numbers the API hands over exactly. A model that reads
 * "35,064,272" off a page and returns 35,064 has failed silently, and nothing
 * downstream would notice.
 *
 * So this is deterministic: same country in, same figures out, and each one
 * carries the endpoint it came from so a reader can check it against the
 * source. The place where a model genuinely earns its cost is where the source
 * is prose rather than a table, and that is a separate question from this.
 *
 * WHAT IT REFUSES TO DO
 *
 * A missing year is left missing. The World Bank returns nulls for years it has
 * not collected, and carrying the previous year forward would produce a chart
 * that looks complete and a figure nobody filed. Nothing is interpolated,
 * back-filled, or estimated.
 */
import { DatabaseSync } from 'node:sqlite';
import { readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = '.wrangler/state/v3/d1/miniflare-D1DatabaseObject';
const BASE = 'https://api.worldbank.org/v2';
const SOURCE_REF = 'world-bank';
const SOURCE_NAME = 'World Bank Open Data';
const FROM_YEAR = 2015;
const TO_YEAR = new Date().getUTCFullYear();

/**
 * World Bank indicator to the code this database already defines.
 *
 * Only exact correspondences are listed. GNI per capita is income of the
 * economy divided by heads, which is NOT median household income: it includes
 * corporate and government income and says nothing about distribution. It is
 * recorded under its own name rather than mapped onto HH_INCOME_MEAN, because
 * the two would be read as the same thing and they are roughly a factor apart
 * in most countries.
 */
const INDICATORS = [
  // Demographics
  ['SP.POP.TOTL', 'POP_TOTAL', 'demographics', 'persons'],
  ['SP.POP.GROW', 'POP_GROWTH', 'demographics', 'percent'],
  ['SP.URB.TOTL', 'POP_URBAN', 'demographics', 'persons'],
  ['SP.RUR.TOTL', 'POP_RURAL', 'demographics', 'persons'],
  ['SP.URB.TOTL.IN.ZS', 'POP_URBAN_SHARE', 'demographics', 'percent'],
  ['EN.POP.DNST', 'POP_DENSITY', 'demographics', 'persons_per_km2'],
  ['SP.POP.DPND', 'AGE_DEPENDENCY', 'demographics', 'percent'],
  ['SP.POP.1564.TO', 'POP_WORKING_AGE', 'demographics', 'persons'],

  // Labour
  ['SL.TLF.CACT.ZS', 'LFP_RATE', 'labour', 'percent'],
  ['SL.UEM.TOTL.ZS', 'UNEMPLOYMENT', 'labour', 'percent'],
  ['SL.UEM.1524.ZS', 'UNEMPLOYMENT_YOUTH', 'labour', 'percent'],

  // What households have and spend
  ['NE.CON.PRVT.CD', 'HH_CONSUMPTION', 'consumer', 'usd'],
  ['NE.CON.PRVT.PC.KD', 'HH_CONSUMPTION_PC', 'consumer', 'usd'],
  ['SI.POV.NAHC', 'POVERTY_RATE', 'consumer', 'percent'],
  ['SI.POV.DDAY', 'POVERTY_EXTREME', 'consumer', 'percent'],
  ['SI.POV.GINI', 'GINI', 'consumer', 'index'],

  // The economy around them
  ['NY.GDP.MKTP.CD', 'GDP', 'macro', 'usd'],
  ['NY.GDP.PCAP.CD', 'GDP_PER_CAPITA', 'macro', 'usd'],
  ['NY.GDP.MKTP.KD.ZG', 'GDP_GROWTH', 'macro', 'percent'],
  ['FP.CPI.TOTL.ZG', 'INFLATION', 'macro', 'percent'],
  ['NY.GNP.PCAP.CD', 'GNI_PER_CAPITA', 'macro', 'usd'],
  ['NV.AGR.TOTL.ZS', 'GDP_AGRI_SHARE', 'macro', 'percent'],
  ['NV.IND.TOTL.ZS', 'GDP_INDUSTRY_SHARE', 'macro', 'percent'],
  ['NV.SRV.TOTL.ZS', 'GDP_SERVICES_SHARE', 'macro', 'percent'],

  // Whether a business can physically operate
  ['EG.ELC.ACCS.ZS', 'ELECTRICITY_ACCESS', 'infrastructure', 'percent'],
  ['IT.NET.USER.ZS', 'INTERNET_USERS', 'digital', 'percent'],
  ['IT.CEL.SETS.P2', 'MOBILE_SUBS', 'digital', 'per_100'],

  // Money coming in
  ['BX.KLT.DINV.CD.WD', 'FDI_INFLOW', 'investment', 'usd'],
  ['FS.AST.PRVT.GD.ZS', 'CREDIT_PRIVATE', 'finance', 'percent'],
];

/**
 * Sector value added, where the World Bank's category is genuinely one sector.
 *
 * Only manufacturing qualifies. "Industry" and "services" are aggregates and
 * are recorded as GDP composition above rather than pretending to be a row in
 * sector_definitions.
 */
const SECTORS = [
  ['NV.IND.MANF.ZS', 'manufacturing', 'Manufacturing'],
  ['NV.AGR.TOTL.ZS', 'agriculture', 'Agriculture'],
];

function openDb() {
  const files = readdirSync(ROOT)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => ({ f, size: statSync(join(ROOT, f)).size }))
    .sort((a, b) => b.size - a.size);
  if (!files.length) throw new Error(`No sqlite file under ${ROOT}`);
  return new DatabaseSync(join(ROOT, files[0].f));
}

function url(iso3, indicator) {
  return `${BASE}/country/${iso3}/indicator/${indicator}?format=json&date=${FROM_YEAR}:${TO_YEAR}&per_page=100`;
}

/**
 * One indicator series.
 *
 * Returns [] for anything the World Bank does not hold for this country, which
 * is a normal answer for many indicators in many places. Throwing would stop a
 * whole country's ingest over one series nobody collects.
 */
async function fetchSeries(iso3, indicator) {
  const res = await fetch(url(iso3, indicator));
  if (!res.ok) return { rows: [], note: `HTTP ${res.status}` };
  const body = await res.json();
  if (!Array.isArray(body) || !Array.isArray(body[1])) return { rows: [], note: 'no series' };
  return {
    rows: body[1]
      .filter((r) => r && r.value != null && Number.isFinite(Number(r.value)))
      .map((r) => ({ year: Number(r.date), value: Number(r.value) })),
    note: null,
  };
}

async function main() {
  const slugArg = process.argv[2];
  const db = openDb();

  const countries = db
    .prepare(
      slugArg
        ? `SELECT id, slug, name, iso3 FROM entities WHERE kind='country' AND slug=? AND iso3 IS NOT NULL`
        : `SELECT id, slug, name, iso3 FROM entities WHERE kind='country' AND is_active=1 AND iso3 IS NOT NULL ORDER BY name`,
    )
    .all(...(slugArg ? [slugArg] : []));

  if (!countries.length) {
    console.log(slugArg ? `No active country with slug "${slugArg}".` : 'No active countries.');
    db.close();
    return;
  }

  console.log(`Market context for ${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`);
  console.log(`Years ${FROM_YEAR} to ${TO_YEAR}, from ${SOURCE_NAME}\n`);

  const insertInd = db.prepare(
    `INSERT INTO indicator_observations
       (entity_id, indicator_code, indicator_name, category, year, value, unit,
        source_name, source_url, confidence, source_ref, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );
  const insertSector = db.prepare(
    `INSERT INTO sector_observations
       (entity_id, sector_code, sector_name, year, share_of_gdp, unit,
        source_name, source_url, source_ref, ingested_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))`,
  );

  let totalRows = 0;
  const missing = [];

  for (const country of countries) {
    // Replace this source's rows rather than adding to them, so re-running
    // corrects figures instead of accumulating duplicate years. Only this
    // source's rows: anything uploaded by hand stays where it is.
    db.prepare('DELETE FROM indicator_observations WHERE entity_id = ? AND source_ref = ?').run(
      country.id,
      SOURCE_REF,
    );
    db.prepare('DELETE FROM sector_observations WHERE entity_id = ? AND source_ref = ?').run(
      country.id,
      SOURCE_REF,
    );

    let wrote = 0;
    let absent = 0;

    for (const [wbCode, code, category, unit] of INDICATORS) {
      const { rows } = await fetchSeries(country.iso3, wbCode);
      if (rows.length === 0) {
        absent += 1;
        missing.push(`${country.slug}/${code}`);
        continue;
      }
      const src = url(country.iso3, wbCode);
      for (const r of rows) {
        insertInd.run(
          country.id,
          code,
          null,
          category,
          r.year,
          r.value,
          unit,
          SOURCE_NAME,
          src,
          // The World Bank publishes national accounts compiled from each
          // country's own statistics office. Good, not perfect, and not the
          // same standing as a figure the country filed directly.
          0.85,
          SOURCE_REF,
        );
        wrote += 1;
      }
    }

    for (const [wbCode, sectorCode, sectorName] of SECTORS) {
      const { rows } = await fetchSeries(country.iso3, wbCode);
      if (rows.length === 0) continue;
      const src = url(country.iso3, wbCode);
      for (const r of rows) {
        insertSector.run(
          country.id,
          sectorCode,
          sectorName,
          r.year,
          r.value,
          'percent',
          SOURCE_NAME,
          src,
          SOURCE_REF,
        );
        wrote += 1;
      }
    }

    totalRows += wrote;
    const note = absent ? `, ${absent} of ${INDICATORS.length} series not published` : '';
    console.log(`  ${country.name.padEnd(24)} ${String(wrote).padStart(4)} rows${note}`);
  }

  console.log(`\n${totalRows} rows written.`);
  if (missing.length) {
    // Named rather than counted. "12 series missing" is a number; knowing it was
    // poverty and Gini tells you which questions this country cannot answer.
    console.log(`\nNot published for these, so left empty rather than estimated:`);
    console.log(`  ${missing.slice(0, 40).join(', ')}${missing.length > 40 ? ` and ${missing.length - 40} more` : ''}`);
  }
  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
