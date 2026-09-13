-- Progress for a running ingest, and the config a discovered country was saved with.
--
-- PROGRESS
--
-- The provider already works one HS chapter at a time. Nothing recorded how far
-- through it was, so the only honest thing the UI could show was a spinner: a
-- spinner says "something is happening" and cannot distinguish a run on chapter
-- 84 of 96 from one that died on chapter 3.
--
-- Nullable rather than defaulted to zero. A run that predates this migration,
-- or a source that has no chapters to count (a single PDF), genuinely has no
-- progress to report, and zero-of-zero would render as a bar stuck at the start
-- rather than as an absence.
ALTER TABLE ingestion_runs ADD COLUMN chapters_done INTEGER;
ALTER TABLE ingestion_runs ADD COLUMN chapters_total INTEGER;

-- What the run is doing right now, for the line under the bar. "Chapter 84 of
-- 96" is progress; "Fetching chapter 84: Nuclear reactors" is progress somebody
-- can act on when it stalls.
ALTER TABLE ingestion_runs ADD COLUMN current_step TEXT;

-- DISCOVERED CONFIGS
--
-- A country config worked out from its PXWeb metadata, stored only after an
-- admin has confirmed it. Never written by discovery itself: the whole point of
-- the confirm step is that a guess does not reach a live request.
--
-- The config is kept as JSON rather than spread across columns because it is
-- consumed whole by the provider and is the exact shape CountryConfig already
-- defines. Splitting it would mean two representations that have to agree.
CREATE TABLE IF NOT EXISTS country_configs (
  entity_id       TEXT PRIMARY KEY,
  endpoint        TEXT NOT NULL,
  provider_type   TEXT NOT NULL DEFAULT 'pxweb',
  config_json     TEXT NOT NULL,
  -- The discovery output that produced it: every guess, its certainty and its
  -- reason. Kept so that when a figure looks wrong later, the decision that led
  -- to it can be read rather than reconstructed.
  discovery_json  TEXT,
  confirmed_by    TEXT,
  confirmed_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at      TEXT NOT NULL DEFAULT (datetime('now')),
  FOREIGN KEY (entity_id) REFERENCES entities(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_runs_status ON ingestion_runs (country_code, status, started_at);
