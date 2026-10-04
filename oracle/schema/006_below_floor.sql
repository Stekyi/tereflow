-- below_floor marks lines too small to be a market (or a total line). It is separate from is_excluded,
-- which also carries the per-country chapter exclusions: the app now takes chapter exclusions from the
-- admin classification (D1) instead, so the browse feeds need to know about size only.
ALTER TABLE tf_opportunity ADD below_floor NUMBER(1) DEFAULT 0 NOT NULL
