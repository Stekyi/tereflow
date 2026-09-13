-- A run somebody asked for but nothing has started yet.
--
-- The admin wanted one button. The work behind it is roughly fourteen minutes
-- of sequential calls to a government API: ninety-six chapters at about eight
-- and a half seconds each, measured against Ghana's endpoint. That does not fit
-- in a Worker request and no amount of arranging makes it fit.
--
-- So the button writes a row here and an agent on the operator's machine picks
-- it up. Two consequences worth being explicit about:
--
--   - A queued run is a request, not a promise. If no agent is running, it sits
--     here. The UI says so rather than showing a progress bar that will never
--     move, because a bar at 0% and a bar with nobody behind it look identical.
--   - claimed_at is what stops two agents doing the same work twice. An agent
--     claims a run by stamping it, and the stamp is conditional on the row
--     still being unclaimed.
ALTER TABLE ingestion_runs ADD COLUMN requested_at TEXT;
ALTER TABLE ingestion_runs ADD COLUMN requested_by TEXT;
ALTER TABLE ingestion_runs ADD COLUMN claimed_at TEXT;

-- What to fetch. Held on the run rather than looked up when the agent starts,
-- so a config edited between the request and the run does not silently change
-- what was asked for.
ALTER TABLE ingestion_runs ADD COLUMN trade_flow TEXT;

-- Partial: only queued rows are ever scanned, and there are rarely more than a
-- handful. A full index would be almost entirely runs nobody will look at again.
CREATE INDEX IF NOT EXISTS idx_runs_queued
  ON ingestion_runs (status, requested_at)
  WHERE status = 'queued';
