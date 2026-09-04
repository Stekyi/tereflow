-- Tereflow initial schema
-- D1 / SQLite

-- ---------------------------------------------------------------------------
-- entities: countries, international organisations, regional bodies.
-- One table so the admin form and the activation toggle work identically
-- whether the record is Ghana, the OECD, or ECOWAS.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entities (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  name          TEXT NOT NULL,
  kind          TEXT NOT NULL CHECK (kind IN ('country','intl_org','regional_body')),
  continent     TEXT,
  iso3          TEXT,
  iso2          TEXT,
  agency_name   TEXT,
  homepage      TEXT,
  api_notes     TEXT,
  -- activation: when 1, the weekly agent ingests and analyses this entity
  is_active     INTEGER NOT NULL DEFAULT 0,
  -- how much we trust / how complete the source coverage is (set by the agent)
  coverage_score REAL NOT NULL DEFAULT 0,
  last_ingest_at TEXT,
  last_error     TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_entities_kind      ON entities(kind);
CREATE INDEX IF NOT EXISTS idx_entities_active    ON entities(is_active);
CREATE INDEX IF NOT EXISTS idx_entities_continent ON entities(continent);
CREATE INDEX IF NOT EXISTS idx_entities_iso3      ON entities(iso3);

-- ---------------------------------------------------------------------------
-- entity_sources: the three link columns per category.
-- category = export | import | commerce
-- slot     = 1 | 2 | 3   (overflow links land in slots 2 and 3)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS entity_sources (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  category    TEXT NOT NULL CHECK (category IN ('export','import','commerce')),
  slot        INTEGER NOT NULL CHECK (slot BETWEEN 1 AND 3),
  url         TEXT NOT NULL,
  label       TEXT,
  fmt         TEXT NOT NULL DEFAULT 'html'
                CHECK (fmt IN ('html','csv','json','api','sdmx','xlsx','pdf')),
  -- health checked by the agent so dead links surface in admin
  last_status INTEGER,
  last_checked_at TEXT,
  tls_warning INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, category, slot)
);

CREATE INDEX IF NOT EXISTS idx_sources_entity ON entity_sources(entity_id);

-- ---------------------------------------------------------------------------
-- trade_facts: the normalised numbers the dashboard sits on.
-- One row = one country / year / flow / partner / product line.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS trade_facts (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_id     TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  year          INTEGER NOT NULL,
  flow          TEXT NOT NULL CHECK (flow IN ('export','import')),
  -- 'goods' or 'services'; services rows carry an EBOPS-style sector instead of HS
  stream        TEXT NOT NULL DEFAULT 'goods' CHECK (stream IN ('goods','services')),
  partner_iso3  TEXT,               -- NULL = all partners / world total
  partner_name  TEXT,
  hs_code       TEXT,               -- NULL = all products
  product_name  TEXT,
  sector        TEXT,
  value_usd     REAL NOT NULL,
  qty           REAL,
  qty_unit      TEXT,
  source_ref    TEXT NOT NULL,      -- which adapter produced this
  ingested_at   TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_facts_lookup  ON trade_facts(entity_id, year, flow, stream);
CREATE INDEX IF NOT EXISTS idx_facts_partner ON trade_facts(entity_id, partner_iso3);
CREATE INDEX IF NOT EXISTS idx_facts_hs      ON trade_facts(entity_id, hs_code);

-- ---------------------------------------------------------------------------
-- analysis_runs: one row per weekly cron execution.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysis_runs (
  id              TEXT PRIMARY KEY,
  started_at      TEXT NOT NULL DEFAULT (datetime('now')),
  finished_at     TEXT,
  trigger         TEXT NOT NULL DEFAULT 'cron' CHECK (trigger IN ('cron','manual','backfill')),
  status          TEXT NOT NULL DEFAULT 'running'
                    CHECK (status IN ('running','ok','partial','failed')),
  entities_total  INTEGER NOT NULL DEFAULT 0,
  entities_ok     INTEGER NOT NULL DEFAULT 0,
  entities_failed INTEGER NOT NULL DEFAULT 0,
  facts_written   INTEGER NOT NULL DEFAULT 0,
  log             TEXT
);

-- ---------------------------------------------------------------------------
-- analysis_results: the computed payloads the dashboard reads.
-- kind: overview | top_exports | top_imports | partners_export | partners_import
--     | yearly_trend | services | concentration | opportunities | recommendations
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS analysis_results (
  id          TEXT PRIMARY KEY,
  entity_id   TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  run_id      TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  payload     TEXT NOT NULL,          -- JSON
  computed_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (entity_id, kind)
);

CREATE INDEX IF NOT EXISTS idx_results_entity ON analysis_results(entity_id);

-- ---------------------------------------------------------------------------
-- opportunity_signals: powers the premium "early adopter" tier.
-- A product with rising momentum that is NOT yet a top export.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS opportunity_signals (
  id             TEXT PRIMARY KEY,
  entity_id      TEXT NOT NULL REFERENCES entities(id) ON DELETE CASCADE,
  hs_code        TEXT,
  product_name   TEXT NOT NULL,
  flow           TEXT NOT NULL CHECK (flow IN ('export','import')),
  cagr_3y        REAL,
  momentum       REAL,               -- 0..1 composite
  current_rank   INTEGER,
  projected_rank INTEGER,
  horizon_years  INTEGER NOT NULL DEFAULT 4,
  confidence     REAL,
  rationale      TEXT,
  run_id         TEXT REFERENCES analysis_runs(id) ON DELETE SET NULL,
  computed_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_signals_entity ON opportunity_signals(entity_id, momentum DESC);
