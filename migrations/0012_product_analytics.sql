-- Per-product analytics, computed ahead of time.
--
-- The product modal needs, for one HS6 line: who sells it, who buys it, at what
-- volume, at what price per tonne, how that price compares to everybody else,
-- and which markets are growing. Deriving that on request means scanning
-- trade_facts across every country every time somebody opens a product.
--
-- It is computed once per pipeline run instead, which is also the only place
-- the world median price can be worked out, since that needs every country in
-- view at the same time.
--
-- One row per product per country per flow. The product-level aggregates
-- (world median price, total traded) are recomputed from these rows on read,
-- which is a cheap indexed scan over a few thousand rows rather than a
-- full-table one over eighty thousand.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS product_analytics (
  hs_code            TEXT NOT NULL,
  entity_id          TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  flow               TEXT NOT NULL CHECK (flow IN ('export','import')),
  year               INTEGER NOT NULL,

  value_usd          REAL NOT NULL,
  -- Kilograms, as reported. Null where the source gave a value but no weight.
  qty_kg             REAL,
  -- value_usd / tonnes. Null when qty_kg is null or zero, never zero-filled:
  -- "no price reported" and "a price of nothing" are different claims.
  unit_value_usd_t   REAL,

  -- Growth of this country's trade in this product, percent per year. Null
  -- when the years were not comparable, same rule as everywhere else.
  cagr_pct           REAL,
  -- Share of the country's trade in that direction, 0..1.
  share              REAL,

  -- Set once the whole run has been seen, so it can be compared across
  -- countries: this country's unit value divided by the world median for the
  -- product. Null when either side has no price.
  price_ratio        REAL,

  computed_at        TEXT NOT NULL DEFAULT (datetime('now')),

  PRIMARY KEY (hs_code, entity_id, flow)
);

-- The modal opens on one product and reads both sides of it.
CREATE INDEX IF NOT EXISTS idx_pa_product ON product_analytics(hs_code, flow, value_usd DESC);

-- The country page reads one country's products.
CREATE INDEX IF NOT EXISTS idx_pa_entity ON product_analytics(entity_id, flow, value_usd DESC);
