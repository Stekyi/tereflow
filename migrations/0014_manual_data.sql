-- Manual country data: templates, uploads, validation, import.
--
-- WHAT THIS DOES NOT ADD, ON PURPOSE
--
-- No new table for imports and exports. Those are trade facts and
-- `trade_facts` already holds trade facts, with the shape the analysis engine
-- already reads. A parallel table would mean every query, every chart and
-- every analysis path learning about two sources of the same truth, and the
-- first time they disagreed nobody would know which was right.
--
-- Rows written by an upload are tagged in the existing `source_ref` column as
-- `upload:<id>`, which is what that column is for: which producer wrote this.
-- That also makes a revert a single delete against an index that already
-- exists, with no schema change and no risk to rows the pipeline wrote.
--
-- Demographics, income and investment indicators do NOT go in trade_facts.
-- They are not trade and forcing them in would corrupt every total computed
-- from that table. They get an indicator model below.
--
-- Thresholds are not defined here either. `code_setup` already exists for
-- numbers an administrator may need to change, and it is already read by the
-- pipeline at the start of a run.
-- ---------------------------------------------------------------------------

-- 1. Dataset definitions. Configurable rather than hardcoded, so a dataset can
--    be added or retired without a deploy.
CREATE TABLE IF NOT EXISTS dataset_definitions (
  code          TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  description   TEXT NOT NULL,
  -- Where accepted rows land. 'trade' means trade_facts, and is the reason
  -- this column exists rather than being inferred from the code.
  target        TEXT NOT NULL CHECK (target IN ('trade','indicator','sector')),
  -- How often the publishing body releases it, so the UI can say whether what
  -- is loaded is stale rather than leaving somebody to work it out.
  refresh_hint  TEXT,
  sort_order    INTEGER NOT NULL DEFAULT 0,
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

-- 2. One row per file an administrator uploaded, kept whether or not it was
--    imported. A rejected upload is part of the history of a country's data.
CREATE TABLE IF NOT EXISTS data_uploads (
  id              TEXT PRIMARY KEY,
  entity_id       TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  dataset_code    TEXT NOT NULL REFERENCES dataset_definitions(code),
  filename        TEXT NOT NULL,
  -- SHA-256 of the bytes. The same file uploaded twice is caught here rather
  -- than after it has doubled a country's totals.
  file_hash       TEXT NOT NULL,
  file_bytes      INTEGER NOT NULL DEFAULT 0,
  -- The original text, so a figure can always be traced to the file it came
  -- from. Null when the file was too large to keep, which is recorded rather
  -- than left to look like an empty upload.
  content         TEXT,
  content_stored  INTEGER NOT NULL DEFAULT 0,

  period          TEXT,
  source_name     TEXT,
  source_url      TEXT,
  uploaded_by     TEXT,
  uploaded_at     TEXT NOT NULL DEFAULT (datetime('now')),

  validation_status TEXT NOT NULL DEFAULT 'pending'
    CHECK (validation_status IN ('pending','valid','valid_with_warnings','invalid')),
  import_status     TEXT NOT NULL DEFAULT 'not_imported'
    CHECK (import_status IN ('not_imported','importing','imported','failed','reverted')),
  -- replace_period deletes this dataset's rows for the periods present in the
  -- file before writing. append_period adds without deleting. Never implied.
  import_mode       TEXT NOT NULL DEFAULT 'append_period'
    CHECK (import_mode IN ('replace_period','append_period')),

  row_count       INTEGER NOT NULL DEFAULT 0,
  valid_rows      INTEGER NOT NULL DEFAULT 0,
  error_count     INTEGER NOT NULL DEFAULT 0,
  warning_count   INTEGER NOT NULL DEFAULT 0,
  notice_count    INTEGER NOT NULL DEFAULT 0,
  rows_written    INTEGER NOT NULL DEFAULT 0,
  rows_replaced   INTEGER NOT NULL DEFAULT 0,

  error_report    TEXT,
  imported_at     TEXT,
  reverted_at     TEXT,
  note            TEXT
);

CREATE INDEX IF NOT EXISTS idx_uploads_entity  ON data_uploads(entity_id, uploaded_at DESC);
CREATE INDEX IF NOT EXISTS idx_uploads_dataset ON data_uploads(entity_id, dataset_code);
-- Catches the same bytes being loaded twice into the same dataset. Scoped to
-- entity and dataset because the same file legitimately belongs to one of each.
CREATE UNIQUE INDEX IF NOT EXISTS idx_uploads_hash
  ON data_uploads(entity_id, dataset_code, file_hash)
  WHERE import_status = 'imported';

-- 3. Every issue found, with the row and column that caused it. Stored rather
--    than only returned, so the report on a rejected upload is still there
--    tomorrow when somebody asks why it was rejected.
CREATE TABLE IF NOT EXISTS upload_issues (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  upload_id   TEXT NOT NULL REFERENCES data_uploads(id) ON DELETE CASCADE,
  severity    TEXT NOT NULL CHECK (severity IN ('error','warning','notice')),
  -- 1-based line in the file as the administrator sees it in a spreadsheet,
  -- header included. Null for issues about the file as a whole.
  row_number  INTEGER,
  column_name TEXT,
  code        TEXT NOT NULL,
  message     TEXT NOT NULL,
  -- What was actually in the cell, so the message can be checked against it.
  raw_value   TEXT
);

CREATE INDEX IF NOT EXISTS idx_issues_upload ON upload_issues(upload_id, severity);

-- 4. Indicators. One long table for demographics, income and the investment
--    indicators, because they are all the same shape: a country, a year, a
--    named measure and a number. Separate columns per indicator would need a
--    migration every time somebody wanted to track something new.
CREATE TABLE IF NOT EXISTS indicator_observations (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  indicator_code TEXT NOT NULL,
  indicator_name TEXT,
  category       TEXT,
  year           INTEGER NOT NULL,
  period         TEXT,
  value          REAL NOT NULL,
  unit           TEXT,
  currency       TEXT,
  price_basis    TEXT,

  -- Disaggregation. All optional: a national total carries none of them, and
  -- that is a complete observation rather than a deficient one.
  sex            TEXT,
  age_group      TEXT,
  region         TEXT,
  urban_rural    TEXT,
  income_group   TEXT,

  source_name    TEXT,
  source_url     TEXT,
  -- 0 to 1, as stated by whoever loaded it. Never computed here and never
  -- assumed: a blank means nobody said, not that the figure is certain.
  confidence     REAL,
  notes          TEXT,

  upload_id      TEXT REFERENCES data_uploads(id) ON DELETE SET NULL,
  source_ref     TEXT NOT NULL,
  ingested_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_ind_lookup ON indicator_observations(entity_id, indicator_code, year);
CREATE INDEX IF NOT EXISTS idx_ind_upload ON indicator_observations(upload_id);
CREATE INDEX IF NOT EXISTS idx_ind_cat    ON indicator_observations(entity_id, category, year);

-- 5. Sectors. Kept apart from indicators because a sector row carries several
--    measures at once (share of GDP, growth, employment, trade) and splitting
--    it into one row per measure would lose the fact that they describe the
--    same sector in the same year.
CREATE TABLE IF NOT EXISTS sector_observations (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id        TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  sector_code      TEXT NOT NULL,
  sector_name      TEXT,
  subsector_code   TEXT,
  subsector_name   TEXT,
  year             INTEGER NOT NULL,

  value            REAL,
  unit             TEXT,
  currency         TEXT,
  share_of_gdp     REAL,
  growth_rate      REAL,
  employment       REAL,
  employment_share REAL,
  exports_value    REAL,
  imports_value    REAL,

  source_name      TEXT,
  source_url       TEXT,
  notes            TEXT,

  upload_id        TEXT REFERENCES data_uploads(id) ON DELETE SET NULL,
  source_ref       TEXT NOT NULL,
  ingested_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sector_lookup ON sector_observations(entity_id, year);
CREATE INDEX IF NOT EXISTS idx_sector_upload ON sector_observations(upload_id);

-- 6. Reference lists. In tables rather than in code because the spec is
--    explicit that these are not irreversible business rules, and because a
--    sector list that needs a deploy to change is a sector list nobody
--    maintains.
CREATE TABLE IF NOT EXISTS sector_definitions (
  code       TEXT PRIMARY KEY,
  name       TEXT NOT NULL,
  sort_order INTEGER NOT NULL DEFAULT 0,
  is_active  INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS indicator_definitions (
  code        TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  category    TEXT NOT NULL,
  unit        TEXT,
  -- Bounds the validator checks against. A percentage outside 0 to 100 is
  -- usually a decimal fraction pasted into a percent column, which is a
  -- hundredfold error that reads as normal.
  min_value   REAL,
  max_value   REAL,
  description TEXT,
  is_active   INTEGER NOT NULL DEFAULT 1
);

INSERT OR IGNORE INTO dataset_definitions (code, name, description, target, refresh_hint, sort_order) VALUES
  ('imports', 'Imports',
   'Goods and services bought from abroad, by partner and product. Lands in the same table the trade analysis already reads.',
   'trade', 'Annual, usually published three to nine months after year end', 10),
  ('exports', 'Exports',
   'Goods and services sold abroad, by partner and product. Same structure as imports with the direction reversed.',
   'trade', 'Annual, usually published three to nine months after year end', 20),
  ('demographics', 'Population and demographics',
   'Population, age structure, labour force, education and connectivity. One row per indicator, year and breakdown.',
   'indicator', 'Annual, census years carry the most detail', 30),
  ('income', 'Household income and consumption',
   'Income, spending, poverty, inequality and prices. Carries a currency and a price basis because a nominal figure and a real one are not comparable.',
   'indicator', 'Annual, household surveys often run every three to five years', 40),
  ('sectors', 'Economic sectors',
   'Sector and subsector output, share of GDP, growth, employment and trade. Several measures per sector year.',
   'sector', 'Annual, national accounts', 50),
  ('investment', 'Other investment indicators',
   'Infrastructure, business environment, stability, risk and investment flows. The general indicator sheet for anything the other five do not cover.',
   'indicator', 'Varies by indicator, many are annual', 60);

INSERT OR IGNORE INTO sector_definitions (code, name, sort_order) VALUES
  ('agriculture', 'Agriculture', 10),
  ('mining', 'Mining', 20),
  ('manufacturing', 'Manufacturing', 30),
  ('construction', 'Construction', 40),
  ('energy', 'Energy', 50),
  ('transport', 'Transport and logistics', 60),
  ('retail', 'Wholesale and retail', 70),
  ('finance', 'Financial services', 80),
  ('ict', 'ICT and digital services', 90),
  ('tourism', 'Tourism', 100),
  ('health', 'Healthcare', 110),
  ('education', 'Education', 120),
  ('realestate', 'Real estate', 130),
  ('professional', 'Professional services', 140),
  ('government', 'Government services', 150);

-- Indicator catalogue.
--
-- Seeded rather than left empty so an administrator opening a template sees
-- the codes the analysis understands instead of inventing their own. Bounds
-- are set where a value outside them is a unit mistake rather than a surprise:
-- a percentage above 100 is nearly always a fraction pasted into a percent
-- column, which is a hundredfold error that reads as perfectly normal.
--
-- Anything not on this list is still accepted. It is flagged as unrecognised,
-- which is a warning rather than a rejection: a country may genuinely track
-- something nobody thought of, and refusing it would be worse than noting it.

INSERT OR IGNORE INTO indicator_definitions (code, name, category, unit, min_value, max_value, description) VALUES
  ('POP_TOTAL','Total population','demographics','persons',0,NULL,'Mid-year resident population.'),
  ('POP_GROWTH','Population growth','demographics','percent',-10,20,'Annual change in total population.'),
  ('POP_URBAN','Urban population','demographics','persons',0,NULL,'Residents in areas classed as urban.'),
  ('POP_RURAL','Rural population','demographics','persons',0,NULL,'Residents outside urban areas.'),
  ('POP_URBAN_SHARE','Urban share of population','demographics','percent',0,100,NULL),
  ('POP_DENSITY','Population density','demographics','persons_per_km2',0,NULL,NULL),
  ('AGE_MEDIAN','Median age','demographics','years',0,120,NULL),
  ('AGE_DEPENDENCY','Age dependency ratio','demographics','percent',0,300,'Dependants per hundred working-age people.'),
  ('POP_WORKING_AGE','Working-age population','demographics','persons',0,NULL,'Usually 15 to 64.'),
  ('LFP_RATE','Labour-force participation','labour','percent',0,100,NULL),
  ('EMPLOYMENT','Employment','labour','persons',0,NULL,NULL),
  ('EMPLOYMENT_RATE','Employment rate','labour','percent',0,100,NULL),
  ('UNEMPLOYMENT','Unemployment rate','labour','percent',0,100,NULL),
  ('UNEMPLOYMENT_YOUTH','Youth unemployment rate','labour','percent',0,100,'Usually 15 to 24.'),
  ('LITERACY','Literacy rate','education','percent',0,100,NULL),
  ('SCHOOL_ENROLMENT','School enrolment','education','percent',0,150,'Gross rates can exceed 100 where pupils are outside the official age.'),
  ('EDU_ATTAINMENT','Educational attainment','education','percent',0,100,NULL),
  ('LIFE_EXPECTANCY','Life expectancy at birth','health','years',0,120,NULL),
  ('BIRTH_RATE','Birth rate','health','per_1000',0,100,NULL),
  ('MORTALITY_RATE','Mortality rate','health','per_1000',0,100,NULL),
  ('MIGRATION_NET','Net migration','demographics','persons',NULL,NULL,'Negative where more people leave than arrive.'),
  ('INTERNET_USERS','Internet users','digital','percent',0,100,NULL),
  ('MOBILE_SUBS','Mobile subscriptions','digital','per_100',0,400,'Can exceed 100 where people hold more than one SIM.'),

  ('HH_INCOME_MEDIAN','Median household income','consumer','currency',0,NULL,'State the currency and whether nominal or real.'),
  ('HH_INCOME_MEAN','Mean household income','consumer','currency',0,NULL,NULL),
  ('HH_INCOME_DISPOSABLE','Disposable income','consumer','currency',0,NULL,'After tax and transfers.'),
  ('HH_CONSUMPTION','Household consumption','consumer','currency',0,NULL,NULL),
  ('HH_CONSUMPTION_PC','Consumption per capita','consumer','currency',0,NULL,NULL),
  ('POVERTY_RATE','Poverty rate','consumer','percent',0,100,'State the line used in notes.'),
  ('POVERTY_EXTREME','Extreme poverty rate','consumer','percent',0,100,NULL),
  ('GINI','Gini coefficient','consumer','index',0,100,'Accepts 0 to 1 or 0 to 100. State which in the unit column.'),
  ('INCOME_SHARE','Income share by group','consumer','percent',0,100,'Use income_group to say which group.'),
  ('MIDDLE_CLASS','Middle-class population','consumer','persons',0,NULL,'State the definition in notes, it varies widely.'),
  ('SAVINGS_RATE','Household savings rate','consumer','percent',-50,100,NULL),
  ('FOOD_EXPENDITURE_SHARE','Food expenditure share','consumer','percent',0,100,NULL),
  ('CPI','Consumer price index','macro','index',0,NULL,'State the base year in notes.'),
  ('INFLATION','Inflation','macro','percent',-50,1000,NULL),
  ('PPP_FACTOR','Purchasing power parity factor','macro','ratio',0,NULL,NULL),
  ('EXCHANGE_RATE','Exchange rate','macro','currency_per_usd',0,NULL,'Units of local currency per US dollar.'),

  ('GDP','GDP','macro','currency',0,NULL,NULL),
  ('GDP_PER_CAPITA','GDP per capita','macro','currency',0,NULL,NULL),
  ('GDP_GROWTH','Real GDP growth','macro','percent',-50,100,NULL),
  ('CONSUMER_SPENDING','Consumer spending','macro','currency',0,NULL,NULL),
  ('MARKET_SIZE_SECTOR','Market size by sector','macro','currency',0,NULL,'Use the sector template where a full breakdown is available.'),
  ('IMPORT_DEMAND','Import demand','trade','currency',0,NULL,NULL),
  ('EXPORT_GROWTH','Export growth','trade','percent',-100,500,NULL),

  ('WAGE_AVERAGE','Average wages','labour','currency',0,NULL,'State whether monthly or annual in the unit column.'),
  ('WAGE_MINIMUM','Minimum wage','labour','currency',0,NULL,NULL),
  ('SKILLED_LABOUR','Skilled-labour availability','labour','index',0,100,NULL),
  ('TVET_GRADUATES','Technical and vocational graduates','labour','persons',0,NULL,NULL),
  ('LABOUR_PRODUCTIVITY','Labour productivity','labour','currency_per_worker',0,NULL,NULL),

  ('ELECTRICITY_ACCESS','Electricity access','infrastructure','percent',0,100,NULL),
  ('ELECTRICITY_RELIABILITY','Electricity reliability','infrastructure','index',0,100,'Or outage hours per month, state which.'),
  ('ELECTRICITY_COST','Electricity cost','infrastructure','currency_per_kwh',0,NULL,NULL),
  ('BROADBAND','Broadband penetration','infrastructure','percent',0,100,NULL),
  ('MOBILE_PENETRATION','Mobile penetration','infrastructure','percent',0,200,NULL),
  ('ROAD_DENSITY','Road density','infrastructure','km_per_100km2',0,NULL,NULL),
  ('PORT_CAPACITY','Port capacity','infrastructure','teu',0,NULL,NULL),
  ('AIRPORT_CONNECTIVITY','Airport connectivity','infrastructure','index',0,NULL,NULL),
  ('LOGISTICS_PERFORMANCE','Logistics performance','infrastructure','index',1,5,'World Bank LPI runs 1 to 5.'),
  ('COLD_CHAIN','Warehouse and cold-chain capacity','infrastructure','index',0,100,NULL),

  ('REG_TIME','Company registration time','regulation','days',0,NULL,NULL),
  ('REG_COST','Business formation cost','regulation','currency',0,NULL,NULL),
  ('TAX_CORPORATE','Corporate tax rate','regulation','percent',0,100,NULL),
  ('TAX_VAT','VAT or sales tax','regulation','percent',0,100,NULL),
  ('CUSTOMS_TIME','Customs clearance time','regulation','days',0,NULL,NULL),
  ('TARIFF_IMPORT','Import tariff','regulation','percent',0,200,'Average applied rate.'),
  ('TARIFF_EXPORT','Export tariff','regulation','percent',0,200,NULL),
  ('FINANCE_ACCESS','Access to finance','finance','index',0,100,NULL),
  ('INTEREST_RATE','Interest rate','finance','percent',-10,200,'Lending rate unless stated otherwise.'),
  ('CREDIT_PRIVATE','Credit to private sector','finance','percent_of_gdp',0,300,NULL),

  ('FX_VOLATILITY','Exchange-rate volatility','risk','percent',0,500,NULL),
  ('PUBLIC_DEBT','Public debt','risk','percent_of_gdp',0,500,NULL),
  ('FISCAL_DEFICIT','Fiscal deficit','risk','percent_of_gdp',-100,100,'Negative is a surplus.'),
  ('CURRENT_ACCOUNT','Current-account balance','risk','percent_of_gdp',-100,100,NULL),
  ('POLITICAL_STABILITY','Political stability','governance','index',-3,3,'Worldwide Governance Indicators run about -2.5 to 2.5.'),
  ('RULE_OF_LAW','Rule of law','governance','index',-3,3,NULL),
  ('CORRUPTION_RISK','Corruption risk','governance','index',0,100,NULL),
  ('CONFLICT_RISK','Conflict and security risk','risk','index',0,100,NULL),
  ('REGULATORY_QUALITY','Regulatory quality','governance','index',-3,3,NULL),
  ('CLIMATE_EXPOSURE','Climate and disaster exposure','climate','index',0,100,NULL),

  ('FDI_INFLOW','FDI inflows','investment','currency',NULL,NULL,'Can be negative when disinvestment exceeds new investment.'),
  ('FDI_OUTFLOW','FDI outflows','investment','currency',NULL,NULL,NULL),
  ('FDI_STOCK','Existing investment stock','investment','currency',0,NULL,NULL),
  ('BIT_COUNT','Bilateral investment treaties','investment','count',0,NULL,NULL),
  ('FTA_COUNT','Free-trade agreements','investment','count',0,NULL,NULL),
  ('EXPORT_CONCENTRATION','Export concentration','trade','index',0,1,'Herfindahl style, 0 is diverse and 1 is a single product.'),
  ('IMPORT_CONCENTRATION','Import concentration','trade','index',0,1,NULL),
  ('TRADE_OPENNESS','Trade openness','trade','percent_of_gdp',0,1000,'Exports plus imports over GDP.'),
  ('SEZ_COUNT','Special economic zones','investment','count',0,NULL,NULL),
  ('INVESTMENT_INCENTIVES','Investment incentives','investment','index',0,100,'Describe the scheme in notes.');