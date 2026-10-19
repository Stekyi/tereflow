-- One flat, indexed row per product line in each country's cached product feed. The cross-country product search runs
-- against this table inside Oracle, so the Worker receives a few hundred matching rows instead of parsing every
-- country's multi-megabyte feed (which exceeds the Cloudflare Worker CPU limit). Rebuilt with the feed in
-- dashboard.refresh_dashboard, so it always holds exactly what the feed holds.
CREATE TABLE IF NOT EXISTS tf_product_index (
  reporter_iso3     VARCHAR2(3)   NOT NULL,
  flow              VARCHAR2(1)   NOT NULL,
  cmd_code          VARCHAR2(12)  NOT NULL,
  classification_level VARCHAR2(8),
  product_name      VARCHAR2(500),
  name_lc           VARCHAR2(500),
  latest_year       NUMBER(4)     NOT NULL,
  value_usd         NUMBER,
  cagr_3y           NUMBER,
  yoy_pct           NUMBER,
  score             NUMBER(6,1)   NOT NULL,
  confidence        VARCHAR2(8),
  signal            VARCHAR2(30),
  top_partner       VARCHAR2(3),
  top_share_pct     NUMBER,
  partner_count     NUMBER,
  unit_value_usd_t  NUMBER,
  years_available   NUMBER,
  trend             VARCHAR2(30),
  name_norm         VARCHAR2(520),
  CONSTRAINT pk_tf_product_index PRIMARY KEY (reporter_iso3, flow, cmd_code)
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_pindex_rank ON tf_product_index (score)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_pindex_code ON tf_product_index (cmd_code)
