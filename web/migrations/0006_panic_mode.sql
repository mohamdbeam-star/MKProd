-- Panic mode: the owner can lock a workspace instantly. While `locked_at` is set, only the owner
-- can reach it; every other member, and every supplier link, is refused until the owner unlocks it.
ALTER TABLE workspaces ADD COLUMN locked_at TEXT;
ALTER TABLE workspaces ADD COLUMN locked_by TEXT;
