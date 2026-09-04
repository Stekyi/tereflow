-- TradeAtlas: the network layer (free registration, business cards, DMs, ratings)
-- and the premium subscription layer.

-- ---------------------------------------------------------------------------
-- users
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
  id             TEXT PRIMARY KEY,
  email          TEXT NOT NULL UNIQUE,
  email_verified INTEGER NOT NULL DEFAULT 0,
  password_hash  TEXT NOT NULL,          -- PBKDF2 via WebCrypto
  password_salt  TEXT NOT NULL,
  full_name      TEXT NOT NULL,
  country_iso3   TEXT,
  role           TEXT NOT NULL DEFAULT 'member'
                   CHECK (role IN ('member','admin')),
  tier           TEXT NOT NULL DEFAULT 'free'
                   CHECK (tier IN ('free','premium')),
  tier_expires_at TEXT,
  created_at     TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen_at   TEXT
);

CREATE INDEX IF NOT EXISTS idx_users_country ON users(country_iso3);

CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_sessions_user ON sessions(user_id);

-- ---------------------------------------------------------------------------
-- business_cards: the profile other users search and contact.
-- Deliberately shallow so registration stays a couple of screens.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS business_cards (
  id            TEXT PRIMARY KEY,
  user_id       TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
  display_name  TEXT NOT NULL,
  company       TEXT,
  headline      TEXT,                   -- "Moringa grower, Northern Ghana"
  bio           TEXT,
  country_iso3  TEXT NOT NULL,
  city          TEXT,
  website       TEXT,
  whatsapp      TEXT,
  avatar_url    TEXT,
  -- what they are here to do
  intents       TEXT NOT NULL,          -- JSON array: buyer|seller|supplier|distributor|partner|agent|logistics|financier
  sectors       TEXT,                   -- JSON array of free-text sectors
  hs_codes      TEXT,                   -- JSON array of HS codes they deal in
  target_markets TEXT,                  -- JSON array of ISO3 they want to trade with
  is_published  INTEGER NOT NULL DEFAULT 0,
  is_verified   INTEGER NOT NULL DEFAULT 0,
  rating_avg    REAL NOT NULL DEFAULT 0,
  rating_count  INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_cards_country   ON business_cards(country_iso3);
CREATE INDEX IF NOT EXISTS idx_cards_published ON business_cards(is_published);

-- free-text search over cards
CREATE VIRTUAL TABLE IF NOT EXISTS business_cards_fts USING fts5(
  card_id UNINDEXED,
  display_name,
  company,
  headline,
  bio,
  sectors,
  hs_codes,
  tokenize = 'porter'
);

-- ---------------------------------------------------------------------------
-- conversations + messages (DMs)
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS conversations (
  id           TEXT PRIMARY KEY,
  a_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  b_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject      TEXT,
  last_message_at TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (a_user_id, b_user_id)
);

CREATE TABLE IF NOT EXISTS messages (
  id              TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  sender_id       TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  read_at         TEXT,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_messages_conv ON messages(conversation_id, created_at);

-- ---------------------------------------------------------------------------
-- ratings: peer feedback after a dealing. One rating per rater per subject.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS ratings (
  id          TEXT PRIMARY KEY,
  rater_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  score       INTEGER NOT NULL CHECK (score BETWEEN 1 AND 5),
  dealt_in    TEXT,                    -- product / service the dealing covered
  comment     TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (rater_id, subject_id),
  CHECK (rater_id <> subject_id)
);

CREATE INDEX IF NOT EXISTS idx_ratings_subject ON ratings(subject_id);

-- ---------------------------------------------------------------------------
-- subscriptions: premium feature C. A user follows a product / sector / market
-- and the weekly run drops analysis into their feed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS subscriptions (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('product','sector','country','hs_code')),
  value      TEXT NOT NULL,
  label      TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (user_id, kind, value)
);

CREATE INDEX IF NOT EXISTS idx_subs_user ON subscriptions(user_id);

-- ---------------------------------------------------------------------------
-- feed_items: fanned out by the weekly run against subscriptions.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS feed_items (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,            -- signal | trend | partner_shift | playbook | message
  title      TEXT NOT NULL,
  body       TEXT,
  payload    TEXT,                     -- JSON
  entity_id  TEXT REFERENCES entities(id) ON DELETE SET NULL,
  premium_only INTEGER NOT NULL DEFAULT 0,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feed_user ON feed_items(user_id, created_at DESC);

-- ---------------------------------------------------------------------------
-- playbooks: premium feature B. Curated "how to start" guidance, attributed.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS playbooks (
  id            TEXT PRIMARY KEY,
  slug          TEXT NOT NULL UNIQUE,
  title         TEXT NOT NULL,
  sector        TEXT,
  hs_code       TEXT,
  country_iso3  TEXT,
  summary       TEXT,
  body_md       TEXT NOT NULL,
  author_name   TEXT,
  author_credential TEXT,
  source_url    TEXT,
  premium_only  INTEGER NOT NULL DEFAULT 1,
  published_at  TEXT,
  created_at    TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_playbooks_sector ON playbooks(sector);
