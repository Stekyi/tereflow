-- Crop production per country from FAOSTAT, for the domestic-production signal. Only the crops listed in
-- shared/production.ts are loaded, and only tonnes produced and hectares harvested.
CREATE TABLE IF NOT EXISTS crop_production (
  iso3      TEXT    NOT NULL,
  fao_item  INTEGER NOT NULL,
  year      INTEGER NOT NULL,
  tonnes    REAL,
  area_ha   REAL,
  flag      TEXT,
  PRIMARY KEY (iso3, fao_item, year)
);
CREATE INDEX IF NOT EXISTS idx_crop_production_item ON crop_production(fao_item, iso3);

CREATE TABLE IF NOT EXISTS crop_production_meta (
  id          INTEGER PRIMARY KEY CHECK (id = 1),
  source_file TEXT NOT NULL,
  file_date   TEXT,
  rows_loaded INTEGER NOT NULL,
  loaded_at   TEXT NOT NULL DEFAULT (datetime('now'))
);
