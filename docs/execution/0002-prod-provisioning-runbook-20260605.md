# 0002 — PROD Provisioning Runbook (first `dev → main` promotion)

- **Date:** 2026-06-05
- **Promotion PR:** #16 (`dev → main`, draft) — first production release, slices 001–012
- **Scope:** one-time stand-up of PROD (Postgres + Auth + Storage), schema, curated seed, worker, web app
- **Rule:** production merge is **human-only** (`docs/DELIVERY-WORKFLOW.md`). Do every step below, smoke-test, **then** mark PR #16 ready and merge.

> ⚠️ Merging PR #16 deploys the web app to PROD. The app expects the schema migrated, the config seeded, the Storage buckets created, and the worker running. Provision all of that **before** you merge (or wire steps 4–6 into your CD pipeline so they run ahead of the app cutover).

---

## Merge gate — the checklist

- [ ] **1.** Supabase stack (Postgres + Auth + Storage) up on PROD
- [ ] **2.** Env / secrets set (service-role key server-only)
- [ ] **3.** DB snapshot taken (rollback point — migrations don't auto-revert)
- [ ] **4.** Migrations `0000 → 0007` applied
- [ ] **5.** **Curated** seed run (config + admin + buckets — **not** `db:seed:all`)
- [ ] **6.** Worker process deployed and healthy
- [ ] **7.** Web app deployed behind the gateway
- [ ] **8.** PROD smoke test green
- [ ] **9.** PR #16 marked ready, approved, merged (human) → smoke-test PROD again

---

## 0. Assumptions

- This is the **first** PROD deploy — every step runs **once**.
- Commands run from the **repo root** on a host/CI with network access to the PROD Postgres, with the **PROD env loaded**.
- Toolchain: Node ≥ 20, `pnpm@10.23.0`, deps installed: `pnpm install --frozen-lockfile`.
- **Never** commit real secrets. The **service-role key stays server-only** (no `NEXT_PUBLIC_` prefix); never expose Postgres/PostgREST/the gateway publicly (RLS is deferred — auth is enforced in the BFF only).

---

## 1. Stand up the Supabase stack (Postgres + Auth + Storage)

Self-hosted Supabase here = **Postgres + Auth (GoTrue) + Storage only** (no Realtime, no Edge Functions).

1. Create `infra/supabase/.env` from `infra/supabase/.env.example`. Fill **PROD** values:
   - `POSTGRES_PASSWORD` (strong), `POSTGRES_DB=postgres`, `SUPABASE_DB_PORT` (prod port).
   - `API_EXTERNAL_URL`, `SITE_URL`, `ADDITIONAL_REDIRECT_URLS` → your real PROD URLs.
   - `JWT_SECRET` (≥ 32 chars). Generate `ANON_KEY` and `SERVICE_ROLE_KEY` as JWTs signed by that secret (`role=anon` / `role=service_role`).
   - `SMTP_*` → a **real** mail provider (invite + password-recovery emails). The defaults point at the local Mailpit catcher — not valid for PROD.
2. Bring it up:
   ```bash
   docker compose -f infra/supabase/docker-compose.yml --env-file infra/supabase/.env up -d
   ```
3. Verify containers are healthy and the `auth` schema initialized (`infra/supabase/initdb/00-auth-init.sh`). Put the app/gateway behind Caddy (`infra/caddy/`) — the Postgres gateway is **never** public.

---

## 2. Configure env / secrets

Two env files plus the worker's environment.

**`infra/supabase/.env`** (the stack — see step 1).

**`apps/web/.env.local`** (web app **and** the db migrate/seed tooling read these):

| Var | Value |
|---|---|
| `NEXT_PUBLIC_SUPABASE_URL` | PROD gateway URL (e.g. `https://…`) |
| `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` | the `ANON_KEY` from step 1 |
| `SUPABASE_SERVICE_ROLE_KEY` | the `SERVICE_ROLE_KEY` from step 1 — **server-only** |
| `DATABASE_URL` | direct Postgres URL to **PROD** (`postgres://postgres:…@<host>:<port>/postgres`) |
| `SEED_ADMIN_EMAIL` / `SEED_ADMIN_PASSWORD` | first-admin bootstrap (strong temp password) |
| `DOCUMENTS_BUCKET` / `EXPORTS_BUCKET` | `documents` / `billing-exports` |
| `DOCUMENT_MAX_BYTES` | `10485760` (10 MiB) |
| `DOCUMENT_CHECKS_CRON` | `*/5 * * * *` |

> **How the db tooling finds env:** `drizzle.config.ts` and every seed call `import "dotenv/config"`, which loads `.env` from the **current working directory**. With `pnpm --filter @brazil-tms/db …`, cwd = `packages/db`, so either **export** these vars in the deploy shell/CI, or drop a `packages/db/.env` containing at least `DATABASE_URL`, `SUPABASE_URL` (or `NEXT_PUBLIC_SUPABASE_URL`), `SUPABASE_SERVICE_ROLE_KEY`, `SEED_ADMIN_EMAIL`, `SEED_ADMIN_PASSWORD`.

**Worker env:** `DATABASE_URL` (pg-boss queue) **plus** `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY` + the bucket names — the worker runs the `billing.export` and document jobs that read/write Storage.

---

## 3. Snapshot the database (rollback point)

Migrations are **not** auto-reversible. Take a snapshot/backup **before** migrating — this is your only schema rollback.

```bash
# provider snapshot, or:
pg_dump "$DATABASE_URL" -Fc -f prod-pre-0007.dump
```

---

## 4. Apply migrations `0000 → 0007`

```bash
pnpm --filter @brazil-tms/db db:migrate     # drizzle-kit migrate — public schema only; auth.* untouched
```

- Applies all 8 migrations (`packages/db/migrations/0000…0007`).
- Requires `DATABASE_URL`.
- Verify the journal advanced and core tables exist (`customers`, `trips`, `import_templates`, `reason_codes`, `documents`, `export_batches`, …).

---

## 5. Seed — **curated for PROD** (do NOT run `db:seed:all`)

> 🚫 **`db:seed:all` loads demo data** — it chains `master-data-sample`, `import-sample`, `trip-domain-sample`, `sla-rules`, and `rates`, all tied to the **`DEMO-SHOPEE`** demo customer (demo customer, demo trips, a placeholder import template, demo SLA/rate). **Do not run it on PROD.**

Run only the required config + admin + buckets, **in this order** (all idempotent):

```bash
pnpm --filter @brazil-tms/db db:seed:reason-codes    # REQUIRED — empty reason_codes silently breaks the exceptions feature
pnpm --filter @brazil-tms/db db:seed:document-types   # proof-type catalog (POD, CT-e, MDF-e, …) — default scaffolding
pnpm --filter @brazil-tms/db db:seed                  # first Admin (needs SEED_ADMIN_* + Supabase env)
pnpm --filter @brazil-tms/db db:seed:buckets          # Storage buckets: imports, documents, billing-exports (needs Supabase env)
```

**Skip** (real data is entered in-app, not seeded): `db:seed:master-data`, `db:seed:sla-rules`, `db:seed:rates`, `db:seed:import`, `db:seed:trip-domain`. (`sla-rules`/`rates` would no-op anyway without the demo customer.)

> Note: `reason-codes` and `document-types` are **labeled scaffolding** (sensible pt-BR defaults), not final business sign-off — fine to ship and refine later. Real per-customer **import templates, SLA rules, rates** are **PRD §29 gated** inputs: create them in-app after go-live (import templates via the new **Import Templates** admin screen from slice 012).

---

## 6. Deploy the worker (single Node process)

One worker, Postgres-backed queue (pg-boss) — **no Redis/broker**.

```bash
pnpm --filter @brazil-tms/workers start     # tsx index.ts   (or build the infra/worker.Dockerfile image)
```

- On boot it creates the `pgboss` schema + queues and registers the scheduled jobs (`sla.sweep`, `documents.checks`) plus the import/billing handlers.
- Healthy log line: `[worker] import worker started; queues ready.`
- Needs `DATABASE_URL` + Supabase Storage env (step 2).

---

## 7. Deploy the web app

```bash
pnpm build      # next build (or deploy the prebuilt image)
pnpm start      # next start, behind the Caddy gateway
```

- pt-BR UI; timezone `America/Sao_Paulo`; BRL. Gateway/PostgREST/Postgres stay private.

---

## 8. PROD smoke test (before declaring done)

1. Sign in as the seeded admin → it forces a password change (`must_change_password=true`).
2. **Administration:** create a real customer + location + lane.
3. **Import Templates** (slice 012): create a real active template for that customer.
4. **Trip Import:** upload → validate → it lands as a *Received* trip.
5. **Dispatch:** assign a resource.
6. **Execution:** record a milestone + raise an exception (reason-code dropdown is populated ✓).
7. **Documents:** attach a proof doc (upload to the `documents` bucket works ✓).
8. **Billing:** mark Billing-Ready → run a billing export (writes to `billing-exports` ✓).
9. Confirm the **worker** processed the jobs (logs) and the SLA sweep is scheduled.

---

## 9. Promote (human-only)

Only after steps 1–8 are green: mark **PR #16** "Ready for review", get approval, and **merge** it (human maintainer). Then re-smoke-test PROD after the app cutover.

---

## Rollback

- **App:** revert the merge commit on `main`, redeploy the baseline.
- **DB:** restore the step-3 snapshot — applied migrations do **not** auto-revert.
- **Seeds / buckets:** idempotent and harmless; safe to leave in place.
