-- Feedback and feature requests from the floating button.
--
-- Kept deliberately thin. This is a way for somebody using the app to say
-- something is wrong or missing, not a support system, and it should not grow
-- into one without a decision to build one.
--
-- user_id is nullable on purpose: the button is reachable signed out, and
-- requiring an account to report a broken page is how you stop hearing about
-- broken pages. When somebody is signed in it is recorded so a reply is
-- possible.
-- ---------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feedback (
  id          TEXT PRIMARY KEY,
  user_id     TEXT REFERENCES users(id) ON DELETE SET NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('problem','request','other')),
  message     TEXT NOT NULL,
  -- Where they were when they hit the button. Saves asking "which page?".
  path        TEXT,
  -- Only for signed-out reporters who want an answer. Signed-in senders are
  -- reachable through their account instead.
  contact     TEXT,
  status      TEXT NOT NULL DEFAULT 'new' CHECK (status IN ('new','read','done')),
  created_at  TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_feedback_new ON feedback(status, created_at DESC);
