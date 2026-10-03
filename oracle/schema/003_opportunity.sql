-- Scored opportunities, rebuilt per reporter by opportunity.refresh_opportunities.
-- metrics_json holds every metric the score was computed from, so a result can
-- be traced back to the facts and recomputed.
CREATE TABLE IF NOT EXISTS tf_opportunity (
  reporter_iso3        VARCHAR2(3)  NOT NULL,
  flow                 VARCHAR2(1)  NOT NULL,
  cmd_code             VARCHAR2(12) NOT NULL,
  classification_level VARCHAR2(8)  NOT NULL,
  product_name         VARCHAR2(500),
  latest_year          NUMBER(4)    NOT NULL,
  opportunity_score    NUMBER(6,1)  NOT NULL,
  score_breakdown_json CLOB,
  signal_type          VARCHAR2(30) NOT NULL,
  data_confidence      VARCHAR2(8)  NOT NULL,
  confidence_reasons_json CLOB,
  explanation          CLOB,
  evidence_json        CLOB,
  limitations_json     CLOB,
  is_excluded          NUMBER(1)    DEFAULT 0 NOT NULL,
  excluded_reason      VARCHAR2(1000),
  metrics_json         CLOB,
  computed_at          TIMESTAMP    DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_opportunity PRIMARY KEY (reporter_iso3, flow, cmd_code, classification_level)
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_opp_rank ON tf_opportunity (reporter_iso3, is_excluded, opportunity_score)
