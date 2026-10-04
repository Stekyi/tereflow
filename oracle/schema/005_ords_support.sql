-- Country reference for the ORDS API (names for partner labels, validation of ISO3 codes) and an
-- index that lets partner-by-year reads avoid scanning a whole reporter-year.
CREATE TABLE IF NOT EXISTS tf_iso3 (
  iso3 VARCHAR2(3) PRIMARY KEY,
  m49  NUMBER(6)   NOT NULL,
  name VARCHAR2(120) NOT NULL
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_facts_partner
  ON tf_trade_facts (reporter_iso3, partner_iso3, year, flow)
--;;
CREATE TABLE IF NOT EXISTS tf_ords_cache_note (id NUMBER PRIMARY KEY)
