-- Tariffs from UNCTAD TRAINS through the WITS REST API (datasource "trn"), at HS6.
-- One row per reporter, partner group, product, year and tariff type, exactly as the source reports it.
-- Nothing here is estimated. A product with no row is "unavailable", never zero.
CREATE TABLE IF NOT EXISTS tf_tariff (
  reporter_iso3   VARCHAR2(3)   NOT NULL,
  reporter_code   VARCHAR2(4)   NOT NULL,
  partner_code    VARCHAR2(4)   NOT NULL,
  cmd_code        VARCHAR2(6)   NOT NULL,
  year            NUMBER(4)     NOT NULL,
  tariff_type     VARCHAR2(8)   NOT NULL,
  hs_revision     VARCHAR2(4),
  rate_pct        NUMBER(12,4),
  rate_measure    VARCHAR2(16),
  total_lines     NUMBER(8),
  pref_lines      NUMBER(8),
  mfn_lines       NUMBER(8),
  min_rate_pct    NUMBER(12,4),
  max_rate_pct    NUMBER(12,4),
  source          VARCHAR2(40)  DEFAULT 'UNCTAD TRAINS via WITS' NOT NULL,
  source_url      VARCHAR2(400),
  retrieved_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_tariff PRIMARY KEY (reporter_code, partner_code, cmd_code, year, tariff_type)
)
--;;
CREATE TABLE IF NOT EXISTS tf_tariff_state (
  reporter_code VARCHAR2(4)  NOT NULL,
  cmd_code      VARCHAR2(6)  NOT NULL,
  year          NUMBER(4)    NOT NULL,
  status        VARCHAR2(12) NOT NULL,
  detail        VARCHAR2(200),
  checked_at    TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_tariff_state PRIMARY KEY (reporter_code, cmd_code, year)
)
