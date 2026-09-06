-- Tereflow: let the weekly pipeline skip a country when the source has no new
-- data, instead of paying the full fetch+analyse+publish cost every Friday
-- regardless. See local/pipeline.ts and worker/agent/adapters/comtrade.ts's
-- probeComtrade().

ALTER TABLE entities ADD COLUMN last_fingerprint TEXT;
ALTER TABLE entities ADD COLUMN last_checked_at TEXT;
ALTER TABLE analysis_runs ADD COLUMN entities_skipped INTEGER NOT NULL DEFAULT 0;
