-- A premium user's saved Problem to Supply runs. The result is stored as it was computed, so a saved run keeps showing the
-- figures it was saved with instead of changing underneath a comparison. Every read and write is scoped by user_id.
CREATE TABLE IF NOT EXISTS guide_runs (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_slug  TEXT NOT NULL,
  hs_code       TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('supply', 'procurement')),
  budget_usd    REAL,
  title         TEXT NOT NULL,
  result_json   TEXT NOT NULL,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_guide_runs_user ON guide_runs(user_id, created_at DESC);
