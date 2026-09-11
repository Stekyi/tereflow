-- Canonical trade pipeline: raw, normalised, analytics, opportunities.
--
-- The existing trade_facts table stays exactly as it is. It holds the HS6
-- Comtrade data every chart and ranking in the app is built on, and replacing
-- it would mean rewriting all of that at the same moment as changing where the
-- numbers come from. Two changes at once is how you lose the ability to tell
-- which one broke something.
--
-- What is new here is a parallel, auditable path for national statistics:
--
--   raw_trade_data        what the source actually returned, kept verbatim
--        |
--   trade_observations    normalised, one row per observed cell
--        |
--   opportunity_metrics   deterministic maths, nothing judgemental
--        |
--   opportunities         a ranked signal with its evidence and its limits
--
-- Raw is kept separate from normalised on purpose. When a government API
-- changes shape, the only way to tell a parsing bug from a source change is to
-- have the bytes that arrived.

-- Every attempt to pull from a provider, successful or not.
--
-- The point of this table is the distinction between "latest attempt" and
-- "latest success". A failed run must never blank the dashboard: the app keeps
-- serving the last good dataset and says how old it is.
CREATE TABLE IF NOT EXISTS ingestion_runs (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  started_at TEXT NOT NULL,
  completed_at TEXT,
  -- running, ok, partial, failed. partial means some cells arrived and were
  -- stored, which is worth keeping and worth flagging.
  status TEXT NOT NULL DEFAULT 'running',
  records_received INTEGER NOT NULL DEFAULT 0,
  records_processed INTEGER NOT NULL DEFAULT 0,
  records_rejected INTEGER NOT NULL DEFAULT 0,
  years_requested TEXT,
  partners_requested INTEGER,
  products_requested INTEGER,
  error_message TEXT,
  -- Enough to reproduce the exact request later. A number nobody can re-derive
  -- is a number nobody can check.
  query_json TEXT,
  endpoint TEXT
);
CREATE INDEX IF NOT EXISTS ingestion_runs_country ON ingestion_runs (country_code, started_at DESC);
CREATE INDEX IF NOT EXISTS ingestion_runs_status ON ingestion_runs (country_code, status, completed_at DESC);

-- The response as it arrived, before anything interpreted it.
--
-- Stored compressed-in-spirit: one row per request rather than per cell, since
-- a PXWeb reply covers a whole cube. body_sha256 makes a repeat run visible
-- without comparing megabytes.
CREATE TABLE IF NOT EXISTS raw_trade_data (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL,
  country_code TEXT NOT NULL,
  provider TEXT NOT NULL,
  endpoint TEXT NOT NULL,
  request_json TEXT NOT NULL,
  http_status INTEGER,
  content_type TEXT,
  body TEXT,
  body_bytes INTEGER,
  body_sha256 TEXT,
  retrieved_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES ingestion_runs (id)
);
CREATE INDEX IF NOT EXISTS raw_trade_run ON raw_trade_data (run_id);
CREATE INDEX IF NOT EXISTS raw_trade_hash ON raw_trade_data (country_code, body_sha256);

-- One observed cell, normalised. Country-agnostic by design: adding another
-- statistical office should mean a new provider and a new config, not a new
-- column here.
CREATE TABLE IF NOT EXISTS trade_observations (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  year INTEGER NOT NULL,
  -- 0 means a full year. 1 to 12 is a real month. Keeping both in one column
  -- with a stated meaning beats a nullable month that every query has to guess
  -- about.
  month INTEGER NOT NULL DEFAULT 0,
  trade_flow TEXT NOT NULL,
  classification_system TEXT NOT NULL DEFAULT 'HS',
  classification_level TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_description TEXT,
  partner_country TEXT NOT NULL,
  partner_iso3 TEXT,
  import_value_usd REAL,
  net_weight_kg REAL,
  -- True when the annual figure was summed from months because the source's
  -- own annual cell was empty. Ghana StatBank does exactly this for the most
  -- recent year: twelve months of data and a null total. A pipeline that trusts
  -- the total silently loses its freshest year, so when we derive one we say so
  -- rather than passing it off as reported.
  value_is_derived INTEGER NOT NULL DEFAULT 0,
  months_counted INTEGER,
  source TEXT NOT NULL,
  source_endpoint TEXT,
  run_id TEXT,
  retrieved_at TEXT NOT NULL,
  FOREIGN KEY (run_id) REFERENCES ingestion_runs (id)
);

-- The data grain, stated once. Running the same ingest twice updates rather
-- than duplicates, which is what makes the job safe to retry.
CREATE UNIQUE INDEX IF NOT EXISTS trade_observations_grain
  ON trade_observations (country_code, year, month, trade_flow,
                         classification_system, classification_level,
                         product_code, partner_country, source);
CREATE INDEX IF NOT EXISTS trade_observations_lookup
  ON trade_observations (country_code, trade_flow, product_code, year);
CREATE INDEX IF NOT EXISTS trade_observations_run ON trade_observations (run_id);

-- Deterministic maths over the observations. Nothing here is a judgement:
-- these are the numbers a second person with the same rows would get.
CREATE TABLE IF NOT EXISTS opportunity_metrics (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  trade_flow TEXT NOT NULL,
  classification_system TEXT NOT NULL DEFAULT 'HS',
  classification_level TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_description TEXT,
  latest_year INTEGER NOT NULL,
  years_available INTEGER NOT NULL,
  earliest_year INTEGER,
  import_value_usd REAL,
  net_weight_kg REAL,
  -- Null rather than zero when weight is missing or zero. A unit value of zero
  -- is a claim that the goods were free.
  unit_value_usd_per_kg REAL,
  yoy_value_pct REAL,
  yoy_volume_pct REAL,
  -- Null when there are not enough years. The absence is the finding, and a
  -- zero here would be read as no growth.
  cagr_3y_pct REAL,
  cagr_5y_pct REAL,
  -- growing, stable, declining, volatile, insufficient_data
  trend TEXT NOT NULL,
  volatility_pct REAL,
  top_partner TEXT,
  top_partner_share_pct REAL,
  -- 0 to 1. One supplier is 1. Null when too few partners report to mean
  -- anything.
  supplier_hhi REAL,
  partner_count INTEGER,
  partner_shares_json TEXT,
  -- What could not be computed and why, carried forward to the reader.
  limitations_json TEXT,
  run_id TEXT,
  computed_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunity_metrics_grain
  ON opportunity_metrics (country_code, trade_flow, classification_level, product_code, latest_year);
CREATE INDEX IF NOT EXISTS opportunity_metrics_lookup
  ON opportunity_metrics (country_code, trade_flow, latest_year);

-- A scored signal. Score and confidence are separate columns because they
-- answer different questions: how interesting is this, and how much do we
-- actually know. A product can score 88 on two years of data, and saying so is
-- the honest version.
CREATE TABLE IF NOT EXISTS opportunities (
  id TEXT PRIMARY KEY,
  country_code TEXT NOT NULL,
  metric_id TEXT NOT NULL,
  trade_flow TEXT NOT NULL,
  classification_system TEXT NOT NULL DEFAULT 'HS',
  classification_level TEXT NOT NULL,
  product_code TEXT NOT NULL,
  product_name TEXT NOT NULL,
  opportunity_score REAL NOT NULL,
  score_breakdown_json TEXT NOT NULL,
  -- import_substitution, export_growth, supplier_diversification. What kind of
  -- thing this is, so the reader is not left to infer it from the number.
  signal_type TEXT NOT NULL,
  -- high, medium, low. Derived from years of data, granularity and
  -- completeness, never from the score.
  data_confidence TEXT NOT NULL,
  confidence_reasons_json TEXT,
  explanation TEXT NOT NULL,
  evidence_json TEXT NOT NULL,
  limitations_json TEXT,
  -- true when a traditional-commodity rule matched. Kept rather than deleted so
  -- the filter can be audited and a rule that hides too much is visible.
  is_excluded INTEGER NOT NULL DEFAULT 0,
  excluded_reason TEXT,
  source TEXT NOT NULL,
  source_endpoint TEXT,
  run_id TEXT,
  computed_at TEXT NOT NULL,
  FOREIGN KEY (metric_id) REFERENCES opportunity_metrics (id)
);
CREATE UNIQUE INDEX IF NOT EXISTS opportunities_grain
  ON opportunities (country_code, trade_flow, classification_level, product_code);
CREATE INDEX IF NOT EXISTS opportunities_rank
  ON opportunities (country_code, is_excluded, opportunity_score DESC);
