-- A copy of the Oracle product index, so product search, product detail and the product-code typeahead still answer when
-- Oracle (ORDS) is unreachable. Oracle stays the primary source; this is the fallback. Refreshed by
-- `python -m tereflow_oracle sync-index-d1`, which only rewrites a country whose lines changed.
CREATE TABLE IF NOT EXISTS product_index (
  reporter_iso3    TEXT NOT NULL,
  flow             TEXT NOT NULL,
  cmd_code         TEXT NOT NULL,
  level            TEXT,
  product_name     TEXT,
  name_lc          TEXT,
  year             INTEGER NOT NULL,
  value_usd        REAL,
  cagr_3y          REAL,
  yoy_pct          REAL,
  score            REAL NOT NULL,
  confidence       TEXT,
  signal           TEXT,
  top_partner      TEXT,
  top_share_pct    REAL,
  partner_count    INTEGER,
  unit_value_usd_t REAL,
  years_available  INTEGER,
  trend            TEXT,
  PRIMARY KEY (reporter_iso3, flow, cmd_code)
);
CREATE INDEX IF NOT EXISTS idx_product_index_code ON product_index(cmd_code);
CREATE INDEX IF NOT EXISTS idx_product_index_score ON product_index(score DESC);

CREATE TABLE IF NOT EXISTS product_index_meta (
  reporter_iso3 TEXT PRIMARY KEY,
  latest_year   INTEGER NOT NULL,
  export_usd    REAL,
  import_usd    REAL,
  checksum      TEXT,
  synced_at     TEXT NOT NULL DEFAULT (datetime('now'))
);
