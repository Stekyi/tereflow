-- Blue oceans: which country's uncontested-space analysis is visible, and to whom.
--
-- Three states rather than a boolean, because "nobody" and "everybody" are not
-- the only two answers the admin needs. A country whose analysis is still being
-- checked should be showable to paying users without being published to the
-- open web.
--
--   hidden      nobody sees it, including premium. The default: a country that
--               has not been reviewed makes no claim at all.
--   premium     premium subscribers only.
--   registered  any signed-in account. Signed-out visitors never see it, in
--               either case, which is the rule the whole feature was asked for.
ALTER TABLE entities ADD COLUMN blue_ocean_visibility TEXT NOT NULL DEFAULT 'hidden';

-- Who last changed it and when. An access decision with no author is one nobody
-- can question later.
ALTER TABLE entities ADD COLUMN blue_ocean_set_by TEXT;
ALTER TABLE entities ADD COLUMN blue_ocean_set_at TEXT;

CREATE INDEX IF NOT EXISTS idx_entities_blue_ocean ON entities (blue_ocean_visibility);
