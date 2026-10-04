-- Tereflow Oracle schema, part 2: analytical tables and views.
-- Everything here is derived from tf_trade_facts and can be rebuilt from it.

-- Sandbox aggregation: GROUP BY year, flow, product. Partner rows only, so the
-- total is the sum of every reported partner and never includes the WLD row
-- twice. Years with no rows simply do not appear: absent is not zero.
CREATE OR REPLACE VIEW v_sandbox_product_totals AS
SELECT reporter_iso3, year, flow, cmd_code AS hs_code, classification_level,
       SUM(value_usd)                       AS all_partner_value_usd,
       SUM(net_weight_kg)                   AS all_partner_weight_kg,
       COUNT(*)                             AS partner_rows,
       COUNT(value_usd)                     AS partner_rows_with_value
FROM tf_trade_facts
WHERE partner_iso3 <> 'WLD'
GROUP BY reporter_iso3, year, flow, cmd_code, classification_level
--;;
-- Specific partner versus all partners, with share. partner_share_pct is NULL
-- when the all-partner total is missing or zero, never 0.
CREATE OR REPLACE VIEW v_market_share AS
SELECT f.reporter_iso3, f.partner_iso3, f.year, f.flow,
       f.cmd_code AS hs_code, f.classification_level,
       f.value_usd AS partner_value_usd,
       t.all_partner_value_usd,
       CASE WHEN t.all_partner_value_usd > 0 AND f.value_usd IS NOT NULL
            THEN ROUND(100 * f.value_usd / t.all_partner_value_usd, 4) END AS partner_share_pct
FROM tf_trade_facts f
JOIN v_sandbox_product_totals t
  ON t.reporter_iso3 = f.reporter_iso3 AND t.year = f.year AND t.flow = f.flow
 AND t.hs_code = f.cmd_code
WHERE f.partner_iso3 <> 'WLD'
--;;
-- Reconciliation: the sum of partners against Comtrade's own World row.
CREATE OR REPLACE VIEW v_world_reconciliation AS
SELECT w.reporter_iso3, w.year, w.flow, w.cmd_code AS hs_code,
       w.value_usd AS world_row_usd,
       t.all_partner_value_usd AS partner_sum_usd,
       CASE WHEN w.value_usd > 0 AND t.all_partner_value_usd IS NOT NULL
            THEN ROUND(100 * (t.all_partner_value_usd - w.value_usd) / w.value_usd, 4) END AS diff_pct
FROM tf_trade_facts w
LEFT JOIN v_sandbox_product_totals t
  ON t.reporter_iso3 = w.reporter_iso3 AND t.year = w.year AND t.flow = w.flow
 AND t.hs_code = w.cmd_code
WHERE w.partner_iso3 = 'WLD'
--;;
-- Deterministic per-product metrics, rebuilt by analytics.refresh_metrics.
-- NULL means "could not be computed", never zero.
CREATE TABLE IF NOT EXISTS tf_product_metrics (
  reporter_iso3        VARCHAR2(3)  NOT NULL,
  flow                 VARCHAR2(1)  NOT NULL,
  cmd_code             VARCHAR2(12) NOT NULL,
  classification_level VARCHAR2(8)  NOT NULL,
  cmd_desc             VARCHAR2(500),
  latest_year          NUMBER(4)    NOT NULL,
  years_available      NUMBER(3)    NOT NULL,
  latest_value_usd     NUMBER(20,2),
  prior_value_usd      NUMBER(20,2),
  yoy_pct              NUMBER(14,4),
  cagr_3y_pct          NUMBER(14,4),
  partner_count        NUMBER(5),
  top_partner_iso3     VARCHAR2(3),
  top_partner_share_pct NUMBER(9,4),
  supplier_hhi         NUMBER(9,6),
  computed_at          TIMESTAMP DEFAULT SYSTIMESTAMP NOT NULL,
  CONSTRAINT pk_tf_product_metrics
    PRIMARY KEY (reporter_iso3, flow, cmd_code, classification_level)
)
--;;
CREATE INDEX IF NOT EXISTS ix_tf_metrics_rank
  ON tf_product_metrics (reporter_iso3, flow, latest_value_usd)
