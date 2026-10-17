-- Manual payments by Wise bank transfer, and admin-granted premium periods.
--
-- The receiving account details are admin-editable rows in code_setup (category 'payments'), so they live in the database
-- the owner controls and never in the source. They are empty until the owner fills them in, and Wise transfer is only
-- offered once an account holder and account number are set.
INSERT OR IGNORE INTO code_setup (code, name, description, value, default_value, kind, category) VALUES
  ('WISE_HOLDER', 'Wise account holder', 'Name on the Wise account that receives premium payments. Payers see this.', '', '', 'text', 'payments'),
  ('WISE_BANK', 'Bank name', 'The bank name Wise shows for this account, for example Wise US Inc. Payers see this.', '', '', 'text', 'payments'),
  ('WISE_ACCOUNT', 'Account number or IBAN', 'The account number (or IBAN) of the Wise account, in US dollars. Payers see this.', '', '', 'text', 'payments'),
  ('WISE_ROUTING', 'Routing number, sort code or SWIFT/BIC', 'The routing or SWIFT detail that goes with the account number. Payers see this.', '', '', 'text', 'payments'),
  ('WISE_NOTE', 'Extra note for payers', 'Anything else a payer should know, for example the transfer type to choose. Payers see this.', '', '', 'text', 'payments');

-- One row per bank-transfer attempt. The payer gets a reference to put on the transfer; an admin confirms once the money
-- is seen in Wise. Nothing is granted automatically, because there is no feed from Wise to match against.
CREATE TABLE IF NOT EXISTS manual_payments (
  id           TEXT PRIMARY KEY,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  plan         TEXT NOT NULL,
  amount_minor INTEGER NOT NULL,
  currency     TEXT NOT NULL DEFAULT 'USD',
  reference    TEXT NOT NULL UNIQUE,
  status       TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'claimed', 'confirmed', 'rejected')),
  payer_note   TEXT,
  created_at   TEXT NOT NULL DEFAULT (datetime('now')),
  decided_at   TEXT,
  period_end   TEXT
);
CREATE INDEX IF NOT EXISTS idx_manual_payments_status ON manual_payments(status, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_manual_payments_user ON manual_payments(user_id, created_at DESC);

-- Premium given by an admin for a period, with no payment: a trial or a comp. The users row carries the live state;
-- this is the record of who was given what and when.
CREATE TABLE IF NOT EXISTS premium_grants (
  id         TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind       TEXT NOT NULL CHECK (kind IN ('grant', 'revoke')),
  days       INTEGER,
  expires_at TEXT,
  note       TEXT,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX IF NOT EXISTS idx_premium_grants_user ON premium_grants(user_id, created_at DESC);
