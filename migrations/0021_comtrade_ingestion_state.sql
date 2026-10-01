-- Persistent Comtrade dataset state.
-- One row represents the exact reporter/year dataset that Tereflow ingested.
-- The checksum/release metadata lets the pipeline skip unchanged years while
-- still detecting revised data, new partners, and changed product observations.
CREATE TABLE IF NOT EXISTS comtrade_ingestion_state (
  entity_id              TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  year                   INTEGER NOT NULL,
  classification_code    TEXT,
  length_cmd_code        INTEGER,
  total_records          INTEGER,
  dataset_checksum       TEXT,
  last_released          TEXT,
  source_kind             TEXT NOT NULL DEFAULT 'final',
  ingested_rows          INTEGER NOT NULL DEFAULT 0,
  checked_at             TEXT NOT NULL DEFAULT (datetime('now')),
  ingested_at             TEXT,
  PRIMARY KEY (entity_id, year)
);

CREATE INDEX IF NOT EXISTS idx_comtrade_state_entity
  ON comtrade_ingestion_state(entity_id, year);
