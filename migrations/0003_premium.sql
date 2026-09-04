-- TradeAtlas Phase 3: premium — playbook sourcing, billing records, feed tuning.

-- Playbooks need multiple citations, not one source_url. Every claim in a
-- playbook is attributed to a real institutional publication.
ALTER TABLE playbooks ADD COLUMN sources TEXT;          -- JSON array of {title,url,publisher}
ALTER TABLE playbooks ADD COLUMN reading_minutes INTEGER NOT NULL DEFAULT 5;
ALTER TABLE playbooks ADD COLUMN updated_at TEXT;

CREATE INDEX IF NOT EXISTS idx_playbooks_country ON playbooks(country_iso3);
CREATE INDEX IF NOT EXISTS idx_playbooks_hs      ON playbooks(hs_code);

-- ---------------------------------------------------------------------------
-- billing: an append-only record of what happened, so entitlement can always
-- be rebuilt from events rather than trusting a mutable flag.
-- ---------------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS billing_events (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  provider    TEXT NOT NULL DEFAULT 'stub'
                CHECK (provider IN ('stub','stripe','paystack','flutterwave')),
  kind        TEXT NOT NULL
                CHECK (kind IN ('checkout_started','activated','renewed','cancelled','expired','refunded','failed')),
  plan        TEXT,
  amount_minor INTEGER,
  currency    TEXT,
  provider_ref TEXT,
  period_end  TEXT,
  raw         TEXT,
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_billing_user ON billing_events(user_id, created_at DESC);
CREATE UNIQUE INDEX IF NOT EXISTS idx_billing_provider_ref
  ON billing_events(provider, provider_ref) WHERE provider_ref IS NOT NULL;

-- ---------------------------------------------------------------------------
-- The weekly fan-out writes one feed item per user per matched signal. This
-- key stops a re-run from duplicating a user's feed.
-- ---------------------------------------------------------------------------
ALTER TABLE feed_items ADD COLUMN dedupe_key TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_feed_dedupe
  ON feed_items(user_id, dedupe_key) WHERE dedupe_key IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_feed_unread ON feed_items(user_id, read_at);
