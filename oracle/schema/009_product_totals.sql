-- All-partner yearly totals per product, so the Trade Sandbox reads them instead of re-aggregating every fact.
-- Same definition as v_sandbox_product_totals (partner_iso3 <> 'WLD'); refreshed after each ingest.
CREATE TABLE tf_product_totals (
  reporter_iso3         VARCHAR2(3)  NOT NULL,
  year                  NUMBER(4)    NOT NULL,
  flow                  VARCHAR2(1)  NOT NULL,
  hs_code               VARCHAR2(12) NOT NULL,
  all_partner_value_usd NUMBER,
  all_partner_weight_kg NUMBER,
  computed_at           TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT pk_tf_product_totals PRIMARY KEY (reporter_iso3, flow, hs_code, year)
)
--;;
GRANT SELECT, INSERT, UPDATE, DELETE ON tf_product_totals TO tereflow_app
