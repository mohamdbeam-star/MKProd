-- Reference only (not applied by wrangler): the schema as reconstructed from worker/index.ts before the
-- original migrations (0001_init, 0002_e2e, 0003_notifications) were committed. Tests/api/run.sh uses it
-- when web/migrations has no 0001.
-- MK Prod sync schema (Cloudflare D1 / SQLite).
--
-- Reconstructed from worker/index.ts. Every statement is idempotent (IF NOT EXISTS) so
-- applying this file to the live database, where these tables already exist, changes nothing.
-- Columns added by later migrations (0002, 0003) are included here so a fresh database gets the
-- full schema in one step; those files are no-ops on it.

-- Accounts. The server never sees passwords: pw_hash = SHA-256(pw_salt ‖ client-derived auth key).
CREATE TABLE IF NOT EXISTS users (
  id                  TEXT PRIMARY KEY,
  email               TEXT NOT NULL UNIQUE,
  name                TEXT NOT NULL DEFAULT '',
  color               TEXT NOT NULL DEFAULT '#7B68EE',
  pw_hash             TEXT NOT NULL,
  pw_salt             TEXT NOT NULL,
  pw_iter             INTEGER NOT NULL DEFAULT 0,
  pw_scheme           INTEGER NOT NULL DEFAULT 2,
  public_key          TEXT,
  enc_private_key     TEXT,
  rec_hash            TEXT,
  rec_salt            TEXT,
  enc_private_key_rec TEXT,
  notify_prefs        TEXT,
  created_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- Sessions store only the SHA-256 of the random token. kind: 'normal' | 'recovery'.
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY,
  user_id    TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at TEXT NOT NULL,
  kind       TEXT NOT NULL DEFAULT 'normal',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions(user_id);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions(expires_at);

CREATE TABLE IF NOT EXISTS workspaces (
  id          TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  created_by  TEXT NOT NULL REFERENCES users(id),
  key_version INTEGER NOT NULL DEFAULT 0,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
);

-- role: 'owner' | 'admin' | 'member' | 'viewer'
CREATE TABLE IF NOT EXISTS members (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role         TEXT NOT NULL DEFAULT 'member',
  joined_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (workspace_id, user_id)
);
CREATE INDEX IF NOT EXISTS members_user ON members(user_id);

-- One pending invite per (workspace, email); code_hash = SHA-256 of the one-time code.
CREATE TABLE IF NOT EXISTS invites (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  email        TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member',
  invited_by   TEXT NOT NULL REFERENCES users(id),
  code_hash    TEXT NOT NULL,
  expires_at   TEXT,
  created_at   TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
  PRIMARY KEY (workspace_id, email)
);
CREATE INDEX IF NOT EXISTS invites_email ON invites(email);

-- Synced objects. `data` is ciphertext ({"enc":..,"v":n}) once the workspace has a key version.
-- `seq` is a per-workspace change counter; clients pull everything after their cursor.
CREATE TABLE IF NOT EXISTS records (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  kind         TEXT NOT NULL,
  id           TEXT NOT NULL,
  data         TEXT NOT NULL DEFAULT '{}',
  deleted      INTEGER NOT NULL DEFAULT 0,
  seq          INTEGER NOT NULL,
  updated_at   TEXT NOT NULL,
  updated_by   TEXT NOT NULL,
  PRIMARY KEY (workspace_id, kind, id)
);
CREATE INDEX IF NOT EXISTS records_seq ON records(workspace_id, seq);

CREATE TABLE IF NOT EXISTS counters (
  workspace_id TEXT PRIMARY KEY REFERENCES workspaces(id) ON DELETE CASCADE,
  seq          INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS presence (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewing      TEXT NOT NULL DEFAULT '',
  client       TEXT NOT NULL DEFAULT '',
  last_seen    TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id)
);

-- Workspace key, wrapped (ECDH + AES-GCM) for one member, one row per key version.
CREATE TABLE IF NOT EXISTS workspace_keys (
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  user_id      TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  version      INTEGER NOT NULL,
  wrapped      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id, version)
);

-- Brute-force protection.
CREATE TABLE IF NOT EXISTS login_failures (
  email TEXT NOT NULL,
  at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS login_failures_email ON login_failures(email, at);

CREATE TABLE IF NOT EXISTS rate_events (
  bucket TEXT NOT NULL,
  at     TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rate_events_bucket ON rate_events(bucket, at);

-- Email de-duplication (one row per notification actually sent).
CREATE TABLE IF NOT EXISTS notify_log (
  workspace_id TEXT NOT NULL,
  user_id      TEXT NOT NULL,
  dedupe       TEXT NOT NULL,
  sent_at      TEXT NOT NULL,
  PRIMARY KEY (workspace_id, user_id, dedupe)
);
CREATE INDEX IF NOT EXISTS notify_log_sent ON notify_log(sent_at);
