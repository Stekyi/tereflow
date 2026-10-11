-- Product names for 6-digit headings, so deeper national codes (HS8) can show a name when their own feed carries none.
CREATE TABLE tf_hs6_name (
  code        VARCHAR2(6)   NOT NULL,
  name        VARCHAR2(500) NOT NULL,
  updated_at  TIMESTAMP DEFAULT SYSTIMESTAMP,
  CONSTRAINT pk_tf_hs6_name PRIMARY KEY (code)
)
--;;
INSERT INTO tf_hs6_name (code, name)
SELECT cmd_code, MAX(cmd_desc) KEEP (DENSE_RANK LAST ORDER BY year)
  FROM tf_trade_facts WHERE cmd_desc IS NOT NULL AND LENGTH(cmd_code) = 6 GROUP BY cmd_code
--;;
GRANT SELECT, INSERT, UPDATE, DELETE ON tf_hs6_name TO tereflow_app
