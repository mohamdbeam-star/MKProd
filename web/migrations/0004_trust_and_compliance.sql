-- Two-factor sign-in, email verification, sign-in alerts, security log, device list,
-- supplier share links and encrypted file attachments.
-- (0001_init.sql does not include these columns on purpose: SQLite has no
-- "ADD COLUMN IF NOT EXISTS", so a fresh database runs the earlier files, then this one.)

ALTER TABLE users ADD COLUMN email_verified INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN verify_hash TEXT;
ALTER TABLE users ADD COLUMN verify_expires TEXT;
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_enabled INTEGER NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN totp_recovery TEXT;
-- Accounts that already exist were created by invitation and are treated as verified.
UPDATE users SET email_verified = 1;

ALTER TABLE sessions ADD COLUMN id TEXT;
ALTER TABLE sessions ADD COLUMN client TEXT;
ALTER TABLE sessions ADD COLUMN ip TEXT;
ALTER TABLE sessions ADD COLUMN location TEXT;
ALTER TABLE sessions ADD COLUMN last_used TEXT;
ALTER TABLE sessions ADD COLUMN mfa_ok INTEGER NOT NULL DEFAULT 1;

ALTER TABLE workspaces ADD COLUMN require_mfa INTEGER NOT NULL DEFAULT 0;

-- Who did what to an account or a workspace (sign-ins, role changes, resets, rotations…).
CREATE TABLE IF NOT EXISTS security_events (
  id           TEXT PRIMARY KEY,
  at           TEXT NOT NULL,
  user_id      TEXT,
  workspace_id TEXT,
  actor_id     TEXT,
  type         TEXT NOT NULL,
  detail       TEXT NOT NULL DEFAULT '',
  ip           TEXT,
  location     TEXT
);
CREATE INDEX IF NOT EXISTS security_events_user ON security_events(user_id, at);
CREATE INDEX IF NOT EXISTS security_events_ws ON security_events(workspace_id, at);

-- Read-only links for suppliers. `blob` is a snapshot encrypted by the client with a key that
-- lives only in the link fragment; the server can't read it. Replies are encrypted the same way.
CREATE TABLE IF NOT EXISTS shares (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  kind         TEXT NOT NULL,
  ref_id       TEXT NOT NULL,
  label        TEXT NOT NULL DEFAULT '',
  blob         TEXT NOT NULL,
  allow_reply  INTEGER NOT NULL DEFAULT 1,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  expires_at   TEXT NOT NULL,
  views        INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS shares_ws ON shares(workspace_id, ref_id);

CREATE TABLE IF NOT EXISTS share_replies (
  id       TEXT PRIMARY KEY,
  share_id TEXT NOT NULL,
  blob     TEXT NOT NULL,
  at       TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS share_replies_share ON share_replies(share_id, at);

-- Encrypted attachments: metadata here, ciphertext in R2 under "<workspace>/<id>".
CREATE TABLE IF NOT EXISTS files (
  id           TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL,
  size         INTEGER NOT NULL,
  key_version  INTEGER NOT NULL,
  created_by   TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS files_ws ON files(workspace_id);
