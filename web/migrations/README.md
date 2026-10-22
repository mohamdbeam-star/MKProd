# Database migrations

Wrangler applies the `.sql` files here in name order and records each applied name in the
`d1_migrations` table of the database (`npm run deploy` does this before publishing).

The live database holds `0001_init.sql`, `0002_e2e.sql`, `0003_notifications.sql` (the original
schema) and `0004_trust_and_compliance.sql`. All of them must be committed: the root
`.gitignore` used to exclude `*.sql`, which is why they were missing for a while. To see what the
live database has recorded:

```bash
npx wrangler d1 migrations list mkprod --remote
```

Rules for new migrations:

- Add a new file (`0005_<what>.sql`, …); never edit an applied one.
- SQLite has no `ADD COLUMN IF NOT EXISTS`, so a migration that adds columns is not re-runnable;
  keep each one small and test it on a fresh local database first (`Tests/api/run.sh`).
