-- Product and by-product knowledge base.
-- One row per relationship between a parent product and something made from it or left over from it.
-- Nothing is hardcoded in a page: the Worker reads this table. Confidence is computed from checks, not asserted:
--   verified   both HS codes exist in the official nomenclature AND its own wording states the derivation
--   plausible  both HS codes exist and the wording names the commodity, or it is standard processing knowledge
--              that is not yet tied to a cited source
--   unverified no HS code to check, or a code that could not be found
--   rejected   a relationship that was in an earlier list and is not supported; kept so it is not re-added
CREATE TABLE IF NOT EXISTS kb_relationship (
  id                    TEXT PRIMARY KEY,
  parent_name           TEXT NOT NULL,
  parent_code            TEXT,
  byproduct_name        TEXT NOT NULL,
  byproduct_code         TEXT,
  kind                  TEXT NOT NULL CHECK (kind IN ('processed', 'residue', 'byproduct', 'downstream')),
  process_method        TEXT,
  applications          TEXT,
  -- 0 means the process and applications text is not yet tied to a cited source.
  detail_sourced        INTEGER NOT NULL DEFAULT 0,
  status                TEXT NOT NULL CHECK (status IN ('established', 'possible', 'rejected')),
  confidence            TEXT NOT NULL CHECK (confidence IN ('verified', 'plausible', 'unverified', 'rejected')),
  parent_hs_official    TEXT,
  byproduct_hs_official TEXT,
  hs_codes_checked      INTEGER NOT NULL DEFAULT 0,
  derivation_checked    INTEGER NOT NULL DEFAULT 0,
  trade_evidence_usd    REAL,
  trade_evidence_year   INTEGER,
  trade_evidence_note   TEXT,
  evidence_note         TEXT,
  source_name           TEXT,
  source_url            TEXT,
  verified_at           TEXT NOT NULL,
  created_at            TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_kb_parent ON kb_relationship (parent_code, status);
CREATE INDEX IF NOT EXISTS idx_kb_byproduct ON kb_relationship (byproduct_code);
