/**
 * Market context from the World Bank: who lives in a country, what they earn,
 * what they spend, and what the economy is made of.
 *
 *   npm run ingest:context            every active country
 *   npm run ingest:context -- ghana   one, by slug
 *
 * Publishes over the admin API, like every other pipeline here. The first
 * version wrote straight to the local sqlite file, which worked on the machine
 * running the cron and could not reach a deployed Worker at all: production got
 * its context through a hand-run SQL export, which is not a pipeline.
 *
 * Configure as the other pipelines are:
 *   TEREFLOW_API_URL        defaults to http://127.0.0.1:8787
 *   TEREFLOW_ADMIN_TOKEN    must match the ADMIN_TOKEN secret on the Worker
 *
 * WHY THIS IS NOT A LANGUAGE MODEL READING PDFS
 *
 * The request was to train a local BERT and have it read population,
 * demographics, economic sector and household income out of PDF reports. Every
 * one of those figures is published by the World Bank as structured data, free,
 * without a key, with a decade of history, addressed by ISO code. Extracting
 * them from a PDF instead would add a step that can be wrong in order to reach
 * the same numbers the API hands over exactly, and a model that reads
 * "35,064,272" off a page and returns 35,064 has failed silently with nothing
 * downstream able to notice.
 *
 * So this is deterministic: same country in, same figures out, and each one
 * carries the endpoint it came from so a reader can check it against source.
 *
 * WHAT IT REFUSES TO DO
 *
 * A missing year is left missing. The World Bank returns nulls for years it has
 * not collected, and carrying the previous year forward would produce a chart
 * that looks complete and a figure nobody filed. Nothing is interpolated,
 * back-filled, or estimated.
 */
import { readFileSync, existsSync } from 'node:fs';

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
 * Only manufacturing and agriculture qualify. "Industry" and "services" are
 * aggregates and are recorded as GDP composition above rather than pretending
 * to be a row in sector_definitions.
 */
const SECTORS = [
  ['NV.IND.MANF.ZS', 'manufacturing', 'Manufacturing'],
  ['NV.AGR.TOTL.ZS', 'agriculture', 'Agriculture'],
];

/** Reads local/.env the way the other pipelines do, without adding a dependency. */
function loadEnv() {
  for (const file of ['local/.env', '.env']) {
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
      if (!m) continue;
      // The real environment wins, so a one-off override does not need the file
      // edited and then remembered to be edited back.
      if (process.env[m[1]] == null) process.env[m[1]] = m[2].trim();
    }
  }
}

loadEnv();

const API = (process.env.TEREFLOW_API_URL ?? 'http://127.0.0.1:8787').replace(/\/+$/, '');
const TOKEN = process.env.TEREFLOW_ADMIN_TOKEN ?? '';

if (!TOKEN) {
  console.error(
    'TEREFLOW_ADMIN_TOKEN is not set. Put it in local/.env or the environment.\n' +
      'It must match the ADMIN_TOKEN secret on the Worker.',
  );
  process.exit(1);
}

async function api(path, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${TOKEN}`,
      ...(init.headers ?? {}),
    },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`${init.method ?? 'GET'} ${path} -> ${res.status} ${text.slice(0, 200)}`);
  }
  return text ? JSON.parse(text) : null;
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
  if (!res.ok) return [];
  const body = await res.json();
  if (!Array.isArray(body) || !Array.isArray(body[1])) return [];
  return body[1]
    .filter((r) => r && r.value != null && Number.isFinite(Number(r.value)))
    .map((r) => ({ year: Number(r.date), value: Number(r.value) }));
}

async function main() {
  const slugArg = process.argv[2];

  const { entities } = await api('/api/admin/entities?kind=country');
  const countries = (entities ?? [])
    .filter((e) => e.iso3 && (slugArg ? e.slug === slugArg : e.is_active === 1))
    .sort((a, b) => a.name.localeCompare(b.name));

  if (countries.length === 0) {
    console.log(slugArg ? `No country with slug "${slugArg}".` : 'No active countries.');
    return;
  }

  console.log(
    `Market context for ${countries.length} ${countries.length === 1 ? 'country' : 'countries'}`,
  );
  console.log(`Years ${FROM_YEAR} to ${TO_YEAR}, from ${SOURCE_NAME}`);
  console.log(`Publishing to ${API}\n`);

  let totalRows = 0;
  const missing = [];
  const failed = [];

  for (const country of countries) {
    const indicators = [];
    const sectors = [];
    let absent = 0;

    try {
      for (const [wbCode, code, category, unit] of INDICATORS) {
        const rows = await fetchSeries(country.iso3, wbCode);
        if (rows.length === 0) {
          absent += 1;
          missing.push(`${country.slug}/${code}`);
          continue;
        }
        const src = url(country.iso3, wbCode);
        for (const r of rows) {
          indicators.push({
            indicator_code: code,
            category,
            year: r.year,
            value: r.value,
            unit,
            source_name: SOURCE_NAME,
            source_url: src,
            // The World Bank publishes national accounts compiled from each
            // country's own statistics office. Good, not perfect, and not the
            // same standing as a figure the country filed directly.
            confidence: 0.85,
          });
        }
      }

      for (const [wbCode, sectorCode, sectorName] of SECTORS) {
        const rows = await fetchSeries(country.iso3, wbCode);
        if (rows.length === 0) continue;
        const src = url(country.iso3, wbCode);
        for (const r of rows) {
          sectors.push({
            sector_code: sectorCode,
            sector_name: sectorName,
            year: r.year,
            share_of_gdp: r.value,
            unit: 'percent',
            source_name: SOURCE_NAME,
            source_url: src,
          });
        }
      }

      // Nothing at all means something is wrong with the fetch, not that a
      // country has no population. The endpoint clears by source before it
      // writes, so publishing an empty set would wipe what was there and call
      // it an update.
      if (indicators.length === 0 && sectors.length === 0) {
        throw new Error('no series returned at all');
      }

      const written = await api('/api/admin/ingest/context', {
        method: 'POST',
        body: JSON.stringify({
          slug: country.slug,
          source_ref: SOURCE_REF,
          indicators,
          sectors,
        }),
      });

      const rows = written.indicators + written.sectors;
      totalRows += rows;
      const note = absent ? `, ${absent} of ${INDICATORS.length} series not published` : '';
      console.log(`  ${country.name.padEnd(24)} ${String(rows).padStart(4)} rows${note}`);
    } catch (err) {
      // One country failing must not stop the rest, and it must not be silent.
      failed.push(`${country.slug}: ${err.message}`);
      console.log(`  ${country.name.padEnd(24)}  FAILED  ${err.message}`);
    }
  }

  console.log(`\n${totalRows} rows published.`);

  if (missing.length) {
    // Named rather than counted. "12 series missing" is a number; knowing it was
    // poverty and Gini tells you which questions this country cannot answer.
    console.log('\nNot published for these, so left empty rather than estimated:');
    console.log(
      `  ${missing.slice(0, 40).join(', ')}${
        missing.length > 40 ? ` and ${missing.length - 40} more` : ''
      }`,
    );
  }

  if (failed.length) {
    console.log(`\n${failed.length} country/countries failed and kept their previous data:`);
    for (const f of failed) console.log(`  ${f}`);
    process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
