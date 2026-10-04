-- Tereflow Oracle schema, part 1: reference data, ingestion control, trade facts.
-- Statements are separated by a line containing only "--;;".
-- Every statement is idempotent so the migration runner is safe to re-run.

CREATE TABLE IF NOT EXISTS tf_country (
  iso3        VARCHAR2(3)   PRIMARY KEY,
  m49         NUMBER(6)     NOT NULL,
  name        VARCHAR2(120),
  slug        VARCHAR2(80),
  is_active   NUMBER(1)     DEFAULT 1 NOT NULL,
  synced_at   TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL
)
--;;
CREATE TABLE IF NOT EXISTS tf_ingest_run (
  run_id      VARCHAR2(36)  PRIMARY KEY,
  kind        VARCHAR2(20)  NOT NULL,
  started_at  TIMESTAMP     DEFAULT SYSTIMESTAMP NOT NULL,
  finished_at TIMESTAMP,
  status      VARCHAR2(12)  NOT NULL,
  dry_run     NUMBER(1)     DEFAULT 0 NOT NULL,
  detail      VARCHAR2(4000)
)
--;;
-- What Comtrade says it holds. Refreshed on a schedule, never per user request.
CREATE TABLE IF NOT EXISTS tf_comtrade_availability (
  reporter_iso3     VARCHAR2(3)  NOT NULL,
  year              NUMBER(4)    NOT NULL,
  dataset           VARCHAR2(12) NOT NULL,   -- FINAL (HS6) or TARIFFLINE
  classification_code VARCHAR2(12),
  length_cmd_code   NUMBER(2),
  total_records     NUMBER(12),
  dataset_checksum  VARCHAR2(64),
  last_released     VARCHAR2(40),
  checked_at        TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_avail PRIMARY KEY (reporter_iso3, year, dataset)
)
--;;
-- One row per reporter/year/flow: the unit of resumable work.
-- status: PENDING, RUNNING, SUCCESS, FAILED, NO_DATA, SKIPPED
CREATE TABLE IF NOT EXISTS tf_ingest_state (
  reporter_iso3        VARCHAR2(3)  NOT NULL,
  year                 NUMBER(4)    NOT NULL,
  flow                 VARCHAR2(1)  NOT NULL,   -- X export, M import
  classification_level VARCHAR2(8),             -- HS6, HS8, HS10 ...
  classification_source VARCHAR2(12),           -- FINAL or TARIFFLINE
  status               VARCHAR2(10) NOT NULL,
  records              NUMBER(12)   DEFAULT 0 NOT NULL,
  dataset_checksum     VARCHAR2(64),
  last_released        VARCHAR2(40),
  run_id               VARCHAR2(36),
  retry_count          NUMBER(4)    DEFAULT 0 NOT NULL,
  error_message        VARCHAR2(2000),
  started_at           TIMESTAMP,
  finished_at          TIMESTAMP,
  updated_at           TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_ingest_state PRIMARY KEY (reporter_iso3, year, flow)
)
--;;
CREATE TABLE IF NOT EXISTS tf_ingest_error (
  id            NUMBER GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  run_id        VARCHAR2(36),
  reporter_iso3 VARCHAR2(3),
  year          NUMBER(4),
  flow          VARCHAR2(1),
  classification_level VARCHAR2(8),
  endpoint      VARCHAR2(400),
  error_message VARCHAR2(2000),
  retry_count   NUMBER(4) DEFAULT 0,
  created_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL
)
--;;
-- Raw trade facts at the deepest classification Comtrade reports for the
-- reporter. value_usd is NULL when the source gave no value: unavailable is
-- not the same as a reported zero. partner_iso3 = 'WLD' is Comtrade's own
-- all-partner row, kept for reconciliation.
CREATE TABLE IF NOT EXISTS tf_trade_facts (
  reporter_iso3        VARCHAR2(3)  NOT NULL,
  partner_iso3         VARCHAR2(3)  NOT NULL,
  year                 NUMBER(4)    NOT NULL,
  flow                 VARCHAR2(1)  NOT NULL,
  cmd_code             VARCHAR2(12) NOT NULL,
  classification_level VARCHAR2(8)  NOT NULL,
  cmd_desc             VARCHAR2(500),
  value_usd            NUMBER(20,2),
  net_weight_kg        NUMBER(20,2),
  qty                  NUMBER(20,2),
  qty_unit             VARCHAR2(20),
  last_released        VARCHAR2(40),
  run_id               VARCHAR2(36) NOT NULL,
  ingested_at          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_trade_facts
    PRIMARY KEY (reporter_iso3, year, flow, cmd_code, partner_iso3)
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_facts_product
  ON tf_trade_facts (reporter_iso3, flow, cmd_code, year)
--;;
-- Staging table for atomic year replacement. Loaded in batches, then swapped
-- into tf_trade_facts in a single transaction.
CREATE TABLE IF NOT EXISTS tf_trade_stage (
  reporter_iso3        VARCHAR2(3)  NOT NULL,
  partner_iso3         VARCHAR2(3)  NOT NULL,
  year                 NUMBER(4)    NOT NULL,
  flow                 VARCHAR2(1)  NOT NULL,
  cmd_code             VARCHAR2(12) NOT NULL,
  classification_level VARCHAR2(8)  NOT NULL,
  cmd_desc             VARCHAR2(500),
  value_usd            NUMBER(20,2),
  net_weight_kg        NUMBER(20,2),
  qty                  NUMBER(20,2),
  qty_unit             VARCHAR2(20),
  last_released        VARCHAR2(40),
  run_id               VARCHAR2(36) NOT NULL
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_stage_run ON tf_trade_stage (run_id, reporter_iso3, year, flow)
