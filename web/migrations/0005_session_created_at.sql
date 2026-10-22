-- "Signed in on …" for the devices list. Nullable: SQLite can't add a column with a
-- non-constant default, and rows that already exist have no sign-in time.
ALTER TABLE sessions ADD COLUMN created_at TEXT;
