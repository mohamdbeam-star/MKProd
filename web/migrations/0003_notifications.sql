-- Email notifications: per-user preferences and a send log for de-duplication.

-- JSON, e.g. {"email":true,"taskAssigned":true,"taskUpdates":true,"contractExpiring":true,"approvals":true,"includeDetails":true}
ALTER TABLE users ADD COLUMN notify_prefs TEXT;

CREATE TABLE notify_log (
  workspace_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  dedupe TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id, dedupe)
);
CREATE INDEX notify_log_sent ON notify_log(sent_at);
