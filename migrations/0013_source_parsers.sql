-- Machine-readable national statistical sources.
-- `fmt` describes the payload; `endpoint_type` describes how it is reached.
-- `config_json` contains the field mapping for that country's publication.
ALTER TABLE entity_sources ADD COLUMN endpoint_type TEXT NOT NULL DEFAULT 'file';
ALTER TABLE entity_sources ADD COLUMN parser_key TEXT NOT NULL DEFAULT 'auto';
ALTER TABLE entity_sources ADD COLUMN config_json TEXT NOT NULL DEFAULT '{}';

CREATE TABLE IF NOT EXISTS source_attempts (
  id            TEXT PRIMARY KEY,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  source_id     TEXT,
  source_ref    TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('primary','fallback','validator')),
  parser_key    TEXT NOT NULL,
  url           TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('ok','failed','partial')),
  rows_written  INTEGER NOT NULL DEFAULT 0,
  note          TEXT,
  attempted_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_source_attempts_entity
  ON source_attempts(entity_id, attempted_at);