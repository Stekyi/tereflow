-- Tereflow: the pipeline moves off Workers and onto a machine you control.
--
-- Fetching and analysing now happens locally, then the results are pushed to
-- this database. Runs produced that way are recorded with trigger = 'local'.
--
-- SQLite cannot alter a CHECK constraint in place, so the table is rebuilt.

CREATE TABLE analysis_runs_new (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  trigger         TEXT NOT NULL DEFAULT 'local'
                    CHECK (trigger IN ('cron','manual','backfill','local')),
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','partial','failed')),
  entities_total  INTEGER NOT NULL DEFAULT 0,
  entities_ok     INTEGER NOT NULL DEFAULT 0,
  entities_failed INTEGER NOT NULL DEFAULT 0,
  facts_written   INTEGER NOT NULL DEFAULT 0,
  log             TEXT
);

INSERT INTO analysis_runs_new
  (id, started_at, finished_at, trigger, status,
   entities_total, entities_ok, entities_failed, facts_written, log)
SELECT
  id, started_at, finished_at, trigger, status,
  entities_total, entities_ok, entities_failed, facts_written, log
FROM analysis_runs;

DROP TABLE analysis_runs;
ALTER TABLE analysis_runs_new RENAME TO analysis_runs;
