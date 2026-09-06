-- Opportunity signals gain the figures the product-first UI reads directly.
--
-- Before this, a signal carried only its growth and momentum, and every screen
-- that wanted "how big is this, and who buys it" had to join back to
-- trade_facts per row. At HS6 that join runs over thousands of product lines
-- per country instead of ~97, which is slow and, worse, silently returns the
-- wrong year when a product's latest reported year differs from the country's.
--
-- Storing them on the signal keeps one row self-contained and lets the list
-- endpoints stay a single indexed read.
-- ---------------------------------------------------------------------------

ALTER TABLE opportunity_signals ADD COLUMN value_usd REAL;
ALTER TABLE opportunity_signals ADD COLUMN share REAL;
ALTER TABLE opportunity_signals ADD COLUMN year INTEGER;
ALTER TABLE opportunity_signals ADD COLUMN best_market TEXT;
ALTER TABLE opportunity_signals ADD COLUMN best_market_iso3 TEXT;
ALTER TABLE opportunity_signals ADD COLUMN best_market_value_usd REAL;

-- The product-first home page ranks every country's signals together, so the
-- hot path is "best signals overall", not "best signals for one country".
CREATE INDEX IF NOT EXISTS idx_signals_momentum ON opportunity_signals(momentum DESC, cagr_3y DESC);

-- Product detail and the marketplace both look a signal up by HS code across
-- every country at once.
CREATE INDEX IF NOT EXISTS idx_signals_hs ON opportunity_signals(hs_code, flow);
