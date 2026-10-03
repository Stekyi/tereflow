-- Precomputed dashboard payloads, rebuilt after each ingest so requests never aggregate raw facts.
CREATE TABLE IF NOT EXISTS tf_dashboard_cache (
  reporter_iso3 VARCHAR2(3)  NOT NULL,
  kind          VARCHAR2(20) NOT NULL,
  payload       CLOB         NOT NULL,
  computed_at   TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_dashboard_cache PRIMARY KEY (reporter_iso3, kind)
)
