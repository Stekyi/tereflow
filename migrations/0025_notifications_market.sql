-- Tereflow: in-app notifications and Market Square (listings, enquiries, auctions).
-- Enquiries reuse conversations/messages from 0002; bids are written only by
-- the conditional update in worker/routes/market.ts.

CREATE TABLE IF NOT EXISTS notifications (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('message','enquiry','outbid','auction_won','auction_sold','auction_ended')),
  ref_id     TEXT NOT NULL,            -- conversation id, listing id
  body       TEXT NOT NULL,
  read_at    TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_notif_user ON notifications(user_id, read_at, created_at DESC);

CREATE TABLE IF NOT EXISTS listings (
  id                TEXT PRIMARY KEY,
  owner_id          TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind              TEXT NOT NULL CHECK (kind IN ('for_sale','wanted','supplier_request','buyer_request','export_opportunity','partnership','service')),
  title             TEXT NOT NULL CHECK (length(title) BETWEEN 3 AND 140),
  description       TEXT NOT NULL CHECK (length(description) BETWEEN 1 AND 4000),
  hs_code           TEXT NOT NULL DEFAULT '',
  country_iso3      TEXT NOT NULL DEFAULT '',
  price_usd         REAL,
  mode              TEXT NOT NULL DEFAULT 'fixed' CHECK (mode IN ('fixed','auction')),
  status            TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','closed','ended')),
  -- auction fields, set only when mode = 'auction'
  start_price       REAL,
  min_increment     REAL,
  ends_at           TEXT,
  current_bid       REAL,
  current_bidder_id TEXT,
  bid_count         INTEGER NOT NULL DEFAULT 0,
  created_at        TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_listings_status ON listings(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_owner ON listings(owner_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_listings_kind ON listings(kind, status);

CREATE TABLE IF NOT EXISTS enquiries (
  id              TEXT PRIMARY KEY,
  listing_id      TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  from_user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  body            TEXT NOT NULL,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_enq_listing ON enquiries(listing_id, created_at DESC);

CREATE TABLE IF NOT EXISTS bids (
  id         TEXT PRIMARY KEY,
  listing_id TEXT NOT NULL REFERENCES listings(id) ON DELETE CASCADE,
  bidder_id  TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  amount     REAL NOT NULL CHECK (amount > 0),
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  UNIQUE (listing_id, amount)
);
CREATE INDEX IF NOT EXISTS idx_bids_listing ON bids(listing_id, amount DESC);
