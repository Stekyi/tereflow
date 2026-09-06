-- Whether a signal's "best market" is that product's largest counterpart or
-- just the country's largest counterpart for the whole flow.
--
-- On the keyless Comtrade tier partner detail is only reported per flow, never
-- per product, so most rows fall back to the flow-wide partner. Without this
-- flag every product for one country displays the same "Best market: China",
-- which reads as a per-product finding when it is nothing of the sort.
--
-- Defaults to 0: an existing row was written before the distinction was
-- tracked, so the weaker claim is the only one that can be justified for it.
-- ---------------------------------------------------------------------------

ALTER TABLE opportunity_signals
  ADD COLUMN best_market_product_specific INTEGER NOT NULL DEFAULT 0;
