-- Tereflow: following people, business posts and saved opportunities.
-- Reuses users and business_cards from 0002; nothing here duplicates them.

CREATE TABLE IF NOT EXISTS follows (
  follower_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  followee_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX IF NOT EXISTS idx_follows_followee ON follows(followee_id);

CREATE TABLE IF NOT EXISTS posts (
  id         TEXT PRIMARY KEY,
  author_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body       TEXT NOT NULL CHECK (length(body) BETWEEN 1 AND 2000),
  hs_code    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_posts_author ON posts(author_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_posts_created ON posts(created_at DESC);

-- A signed-in user's own shortlist of trade opportunities. notes and
-- research_links are private to the owner; every read and write is scoped by user_id.
CREATE TABLE IF NOT EXISTS saved_opportunities (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  country_slug   TEXT NOT NULL,
  partner_iso3   TEXT NOT NULL DEFAULT '',
  hs_code        TEXT NOT NULL DEFAULT '',
  flow           TEXT NOT NULL DEFAULT '' CHECK (flow IN ('', 'import', 'export')),
  title          TEXT NOT NULL,
  status         TEXT NOT NULL DEFAULT 'new'
                   CHECK (status IN ('new','researching','contacted','negotiating','won','dropped')),
  notes          TEXT,
  research_links TEXT,            -- JSON array of http(s) URLs
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at     TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, country_slug, partner_iso3, hs_code, flow)
);
CREATE INDEX IF NOT EXISTS idx_saved_user ON saved_opportunities(user_id, updated_at DESC);
