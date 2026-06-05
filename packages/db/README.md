# @brazil-tms/db

Drizzle schema, migrations, seeds, and the server-only Postgres client for the BFF.

## Seeding a dev database

After `db:migrate`, seed everything in one shot:

```bash
pnpm --filter @brazil-tms/db db:seed:all
```

This chains every seed in dependency order. All seeds are **idempotent**, so re-running is safe.
The `DATABASE_URL`-only scaffolding/data seeds run first (master-data, reason-codes, document-types,
sla-rules, rates, import), then the seeds that also need Supabase env run last (admin, trip-domain,
buckets) — so a `DATABASE_URL`-only run still seeds all the config scaffolding (an empty `reason_codes`
table, for example, silently breaks the exception feature) before stopping at the admin step.

Env:

- **Always:** `DATABASE_URL` (dev: `postgres://postgres:postgres@localhost:5433/postgres`).
- **`db:seed` (admin) + `db:seed:buckets`:** also `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`),
  `SUPABASE_SERVICE_ROLE_KEY`; admin also needs `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD`.

The individual `db:seed:*` scripts (see `package.json`) remain available to run a single seed —
e.g. `db:seed:reason-codes` to (re)populate just the exception reason codes. `db:seed:e2e` is
separate: it resets the test accounts for Playwright runs and is **not** part of `db:seed:all`.
