-- Tereflow: Traditional vs Non-Traditional Export classification.
--
-- SMEs cannot realistically enter capital-intensive, licensed, state- or
-- oligopoly-controlled export categories (oil, mining, precious metals, and
-- -- per country -- a dominant legacy commodity like Ghanaian cocoa). Those
-- are "Traditional Exports". Everything else -- processed and horticultural
-- goods an SME can actually produce and ship -- is a "Non-Traditional Export"
-- (NTE), the same term used by real export-promotion agencies (Ghana's GEPA
-- and its regional equivalents).
--
-- entity_id = '*' is a universal default row (applies to every country unless
-- overridden). A real entities.id row is an admin-curated, sourced override
-- for one specific country, which always wins over '*'.
--
-- '*' is used instead of NULL deliberately: SQLite's UNIQUE constraint treats
-- NULLs as all distinct from one another, so NULL would not actually stop
-- duplicate "default" rows for the same hs_code.

CREATE TABLE IF NOT EXISTS export_classifications (
  id           TEXT PRIMARY KEY,
  entity_id    TEXT NOT NULL DEFAULT '*',
  hs_code      TEXT NOT NULL,
  category     TEXT NOT NULL CHECK (category IN ('traditional','non_traditional')),
  note         TEXT,
  source_url   TEXT,
  source_label TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, hs_code)
);

CREATE INDEX IF NOT EXISTS idx_classifications_hs ON export_classifications(hs_code);

-- Universal defaults: extraction that requires a concession/license and is
-- capital-intensive almost everywhere, regardless of country.
--   26 = Metal ores & ash
--   27 = Mineral fuels & oils
--   71 = Pearls, gems & precious metals
INSERT INTO export_classifications (id, entity_id, hs_code, category, note)
VALUES
  ('cls_default_26', '*', '26', 'traditional', 'Metal ores & ash -- mining concessions, capital-intensive globally.'),
  ('cls_default_27', '*', '27', 'traditional', 'Mineral fuels & oils -- oil/gas, state- or license-controlled globally.'),
  ('cls_default_71', '*', '71', 'traditional', 'Pearls, gems & precious metals -- mining/refining concessions globally.');
