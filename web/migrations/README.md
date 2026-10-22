# Database migrations

Wrangler applies the `.sql` files here in name order and records each applied name in the
`d1_migrations` table of the database (`npm run deploy` does this before publishing).

`0001_init.sql` was reconstructed from `worker/index.ts` after the original migration files
were lost. Every statement in it uses `IF NOT EXISTS`, so it is safe on the live database
whatever names its `d1_migrations` table holds. To see what the live database has recorded:

```bash
npx wrangler d1 migrations list mkprod --remote
```

Rules for new migrations:

- Add a new file (`0002_<what>.sql`, …); never edit an applied one.
- Prefer idempotent statements. SQLite has no `ADD COLUMN IF NOT EXISTS`, so when a column is
  needed, add it to `0001_init.sql` as well, so a fresh database gets it in one step, and write
  the `ALTER TABLE … ADD COLUMN` in the new file for databases that already exist.
