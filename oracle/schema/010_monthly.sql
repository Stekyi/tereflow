-- Monthly totals per product (HS6) for a reporter, for seasonality. Kept apart from tf_trade_facts,
-- which is yearly and per partner; monthly detail is only worth storing at product level.
CREATE TABLE IF NOT EXISTS tf_trade_monthly (
  reporter_iso3 VARCHAR2(3)  NOT NULL,
  flow          VARCHAR2(1)  NOT NULL,
  cmd_code      VARCHAR2(6)  NOT NULL,
  year          NUMBER(4)    NOT NULL,
  month         NUMBER(2)    NOT NULL,
  value_usd     NUMBER(20,2),
  net_weight_kg NUMBER(20,2),
  source        VARCHAR2(24) NOT NULL,
  ingested_at   TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_trade_monthly PRIMARY KEY (reporter_iso3, flow, cmd_code, year, month),
  CONSTRAINT ck_tf_monthly_month CHECK (month BETWEEN 1 AND 12)
)
--;;
CREATE TABLE IF NOT EXISTS tf_monthly_state (
  reporter_iso3 VARCHAR2(3) NOT NULL,
  flow          VARCHAR2(1) NOT NULL,
  year          NUMBER(4)   NOT NULL,
  months        NUMBER(2)   NOT NULL,
  rows_stored   NUMBER(12)  NOT NULL,
  checked_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_monthly_state PRIMARY KEY (reporter_iso3, flow, year)
)
