-- End-to-end encryption, invite codes, recovery codes and rate limiting.

-- pw_scheme 1 = legacy server-side PBKDF2 of the raw password.
-- pw_scheme 2 = SHA-256(salt ‖ authKey); the client stretches the password (see SECURITY.md).
ALTER TABLE users ADD COLUMN pw_scheme INTEGER NOT NULL DEFAULT 1;
ALTER TABLE users ADD COLUMN public_key TEXT;
ALTER TABLE users ADD COLUMN enc_private_key TEXT;
ALTER TABLE users ADD COLUMN rec_hash TEXT;
ALTER TABLE users ADD COLUMN rec_salt TEXT;
ALTER TABLE users ADD COLUMN enc_private_key_rec TEXT;

-- 0 = not encrypted yet; otherwise the current workspace key version.
ALTER TABLE workspaces ADD COLUMN key_version INTEGER NOT NULL DEFAULT 0;

-- Workspace keys, wrapped (encrypted) separately for each member and version.
CREATE TABLE workspace_keys (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  wrapped TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (workspace_id, user_id, version)
);

-- Invites now need a one-time code; only its hash is stored.
ALTER TABLE invites ADD COLUMN code_hash TEXT;
ALTER TABLE invites ADD COLUMN expires_at TEXT;

-- 'normal' sessions, or short-lived 'recovery' sessions that may only reset the password.
ALTER TABLE sessions ADD COLUMN kind TEXT NOT NULL DEFAULT 'normal';

CREATE TABLE rate_events (
  bucket TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE INDEX rate_events_bucket ON rate_events(bucket, at);
