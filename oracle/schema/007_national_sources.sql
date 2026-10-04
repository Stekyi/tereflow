-- National statistics offices that serve deeper product codes than Comtrade are read first.
-- Their values are in local currency, so the rate used to reach USD is kept with the data it converted.
ALTER TABLE tf_ingest_state MODIFY classification_source VARCHAR2(24)
--;;
CREATE TABLE tf_fx_rate (
  source        VARCHAR2(16) NOT NULL,
  year          NUMBER(4)    NOT NULL,
  flow          VARCHAR2(1)  NOT NULL,
  currency      VARCHAR2(3)  NOT NULL,
  usd_per_unit  NUMBER(14,8) NOT NULL,
  basis         VARCHAR2(200),
  created_at    TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT pk_tf_fx_rate PRIMARY KEY (source, year, flow)
)
