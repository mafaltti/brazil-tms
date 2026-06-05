# Security Review

## Architecture Summary

This is a `pnpm` TypeScript monorepo. `apps/web` is a Next.js App Router app and BFF; `packages/db` owns Drizzle schema, migrations, database services, and Supabase Storage helpers; `packages/shared` owns Zod schemas and domain logic; `workers` runs pg-boss background jobs for imports, validation, SLA/document sweeps, and billing exports. `infra` contains self-hosted Supabase, Caddy gateway, and worker Docker configuration.

The intended security model is BFF-only authorization with PostgREST not exposed. Caddy correctly omits `/rest/v1` and strips `x-middleware-subrequest`. Real `.env` files are gitignored; only examples are tracked. The priority issues below are ordered by risk.

## Critical

### Overprivileged runtime database credentials

**Severity:** Critical  
**Location:** `apps/web/.env.local.example:12`, `infra/supabase/docker-compose.yml:93`, `infra/supabase/initdb/00-auth-init.sh:19`

**The Problem:** The app/worker/storage paths are configured around `postgres` superuser connections, and `supabase_auth_admin` is also created as `SUPERUSER`.

**The Risk:** Any BFF, worker, queue, or auth compromise becomes full database compromise, including auth/storage schemas and audit tampering despite append-only `REVOKE` comments.

**Actionable Solution:** Create separate least-privilege roles: migration owner, app BFF role, worker role, auth role, and storage role. Grant only required DML on `public`; never run app/worker as `postgres`; bind Postgres only internally in production.

### E2E seed can reset privileged accounts to public known passwords

**Severity:** Critical  
**Location:** `packages/db/seed/e2e-accounts.ts:27`, `apps/web/e2e/test-config.ts:21`

**The Problem:** `db:seed:e2e` provisions admin and role accounts with tracked default passwords and updates existing auth users.

**The Risk:** If run against staging/production by mistake, it can set known credentials for real privileged accounts.

**Actionable Solution:** Hard-fail unless `ALLOW_E2E_SEED=true` and the DB host is local/test. Remove password fallbacks, require env-provided random credentials, and make e2e email domains clearly non-production.

## High

### Public auth flows trust request Origin and lack explicit throttling

**Severity:** High  
**Location:** `apps/web/app/api/auth/forgot-password/route.ts:18`, `apps/web/lib/users/service.ts:308`, `infra/supabase/docker-compose.yml:65`

**The Problem:** Password reset and invite redirect URLs are built from request headers; sign-in/forgot-password rely on provider defaults with no explicit configured rate limits.

**The Risk:** Header manipulation can produce bad reset/invite targets, and brute-force or reset-email abuse depends on unverified GoTrue defaults.

**Actionable Solution:** Use a canonical `PUBLIC_APP_URL` allowlist, reject untrusted origins, configure GoTrue rate-limit env vars, and add BFF-level IP/user throttling for auth endpoints.

### CSV formula injection in exports

**Severity:** High  
**Location:** `apps/web/lib/trips/export-csv.ts:28`, `workers/jobs/billing-export/index.ts:137`

**The Problem:** Exported customer-controlled fields are CSV-escaped but not spreadsheet-formula neutralized.

**The Risk:** Opening exports in Excel/Sheets can execute malicious formulas embedded in trip IDs, names, locations, or billing fields.

**Actionable Solution:** Prefix cells beginning with `=`, `+`, `-`, `@`, tab, or CR/LF with a safe apostrophe or tab escape, and apply this consistently to trip CSV and billing CSV/XLSX generation.

### Import upload buffers whole files without app-level size cap

**Severity:** High  
**Location:** `apps/web/app/api/imports/route.ts:25`, `apps/web/app/api/imports/route.ts:43`, `infra/caddy/Caddyfile:27`

**The Problem:** The import route calls `formData()` and `arrayBuffer()` before enforcing a route-level size limit, relying on the Caddy template's 50 MB cap.

**The Risk:** Any deployment path that bypasses or misconfigures Caddy can exhaust Next.js memory with large multipart uploads.

**Actionable Solution:** Enforce `IMPORT_MAX_BYTES` in the handler before buffering, reject missing/oversized `content-length`, and consider streaming uploads directly to Storage.

### CI skips core DB-backed integration coverage

**Severity:** High  
**Location:** `.github/workflows/ci.yml:54`, `apps/web/lib/trips/trips-read.test.ts:36`

**The Problem:** The default CI job intentionally runs without `DATABASE_URL`, causing many service, worker, reporting, and authz tests to skip.

**The Risk:** The green CI gate can miss regressions in the main business workflows.

**Actionable Solution:** Add a second CI job that starts the Supabase stack, migrates/seeds test data, runs DB-backed Vitest, and runs critical Playwright authz/workflow specs.

## Medium

### Known vulnerable production dependencies

**Severity:** Medium  
**Location:** `apps/web/package.json:31`, `workers/package.json:17`

**The Problem:** `pnpm audit --prod` reports moderate advisories: `postcss <8.5.10` through `next`, and `uuid <11.1.1` through `exceljs`.

**The Risk:** These become security debt and may block compliance or production release.

**Actionable Solution:** Add `pnpm audit --prod` to CI, upgrade Next/ExcelJS paths where possible, or use verified `pnpm.overrides` after regression testing.

### Reporting and board queries are likely to degrade at scale

**Severity:** Medium  
**Location:** `packages/db/src/trips/on-time.ts:41`, `packages/db/schema/trip-events.ts:41`, `packages/db/src/trips/trips-read.ts:406`

**The Problem:** Reports use repeated correlated `trip_events` subqueries, and board search uses `%ILIKE%` across joined text fields without trigram indexes.

**The Risk:** Polling dashboards and reports will slow as trips/events grow.

**Actionable Solution:** Add composite/partial indexes on `(trip_id, status_after, event_timestamp/created_at)`, add `pg_trgm` indexes for searchable fields, and validate with `EXPLAIN ANALYZE`.

### Worker container is dev-grade

**Severity:** Medium  
**Location:** `infra/worker.Dockerfile:5`

**The Problem:** The worker image copies the whole repo and installs all dependencies in a single stage.

**The Risk:** Larger image, larger attack surface, slower deploys, and more secrets/docs/test artifacts available in the runtime image.

**Actionable Solution:** Use a multi-stage build, prune to production dependencies, copy only needed workspace packages, run as a non-root user, and add image scanning.

## Verification

Ran `pnpm audit --prod`, `pnpm lint`, `pnpm typecheck`, `pnpm test`, and `pnpm build`. Lint/typecheck/build passed. Tests passed with 517 executed and 224 skipped due to missing DB/storage environment; no e2e suite was run.
