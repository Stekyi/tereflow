-- Tereflow: hs_code-first index for cross-country product rankings (Marketplace).
--
-- Existing indexes on trade_facts (see 0001_init.sql) are all entity_id-first,
-- built for "everything about one country". Marketplace asks the opposite
-- question -- "every country for this one product" -- which would otherwise
-- table-scan.

CREATE INDEX IF NOT EXISTS idx_facts_hs_lookup ON trade_facts(hs_code, flow, stream);
