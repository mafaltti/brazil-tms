# Quickstart: Platform, Access, and App Shell (feature 001)

**Feature**: 001-platform-access-shell | **Spec**: [spec.md](./spec.md) ·
**Plan**: [plan.md](./plan.md) · **Research**: [research.md](./research.md)

How to stand up, run, and verify this feature. Host is Windows + PowerShell; the stack runs in Docker.
This feature is the platform foundation — it scaffolds the monorepo, the Next.js app shell, Supabase Auth
wiring, the BFF auth context, the permission catalog, the audit foundation, and pt-BR i18n.

## Prerequisites

- Node.js 20 LTS, pnpm (monorepo), Docker Desktop, `tsx`.
- Self-hosted Supabase stack (Postgres + GoTrue Auth + Storage) via Docker Compose in `infra/supabase/`.
- **Next.js pinned ≥ 15.2.3** (CVE-2025-29927). App Router; `middleware.ts`.

## Environment variables

**App / server (`apps/web/.env.local`)** — secret key must NOT have `NEXT_PUBLIC_`:
```
NEXT_PUBLIC_SUPABASE_URL=http://localhost:8000
NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY=<anon/publishable key>   # browser-safe (auth only)
SUPABASE_SERVICE_ROLE_KEY=<service/secret key>                # SERVER ONLY (admin.* ops)
DATABASE_URL=postgres://<user>:<pass>@localhost:5432/postgres # Drizzle (server-only, direct PG)
```

**GoTrue / Supabase (`infra/supabase/.env`)**:
```
GOTRUE_JWT_EXP=3600
GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true
GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10
GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=8h     # [VERIFY] on pinned image; else app-layer fallback
GOTRUE_SESSIONS_TIMEBOX=720h              # 30-day absolute max
GOTRUE_MAILER_AUTOCONFIRM=false
SMTP_HOST=...                             # required for invite + forgot-password
SMTP_PORT=587
SMTP_USER=...
SMTP_PASS=...
SMTP_ADMIN_EMAIL=noreply@braziltransports.com.br
SMTP_SENDER_NAME=Brazil Transports TMS
```

**Seed (never commit)**:
```
SEED_ADMIN_EMAIL=admin@braziltransports.com.br
SEED_ADMIN_PASSWORD=<strong temp password>
```

## Set up & run

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
# Wait for GoTrue to be healthy (it runs its migrations on first boot):
#   curl http://localhost:8000/auth/v1/health   # -> 200
pnpm --filter @brazil-tms/db db:migrate                      # apply migrations (users, audit_logs, app_role)
pnpm --filter @brazil-tms/db db:seed                         # bootstrap the first Admin (idempotent)
pnpm --filter @brazil-tms/web dev                            # Next.js on http://localhost:3000
```

> Verified locally (stack up + `pnpm test:e2e` green, 27/27). Notes: if host port 5432 is taken, set
> `SUPABASE_DB_PORT=5433` in `infra/supabase/.env` and point `DATABASE_URL` at it. Invite/recovery
> emails are caught by Mailpit (UI at http://localhost:8025). GoTrue is pinned to v2.151.0 — see the
> compose header for the migration-compatibility rationale ([VERIFY AT SETUP] on upgrade).

First login: sign in as the seeded admin → forced password change (`must_change_password=true`) → land
on the app shell. From **Administração → Usuários e Perfis**, create the remaining users.

## Manual verification (maps to spec Success Criteria)

1. **Unauthenticated guard (SC-001)**: open `/admin/users` while signed out → redirected to `/login`.
2. **Login (US1)**: valid credentials → shell; invalid → generic error, no session.
3. **Forgot password (US1)**: submit a non-existent email → neutral response (no disclosure).
4. **Onboarding both paths (FR-013a)**: create one user via **invite** (appears `pending`, gets email,
   becomes `active` on first sign-in) and one via **temp password** (signs in, forced to change).
5. **Role-aware shell (US2, SC-002)**: sign in as Finance → only permitted nav visible; Admin-only areas
   hidden.
6. **Server-side enforcement (SC-003)**: as a non-admin, call `GET /api/admin/users` directly → `403`,
   no data. As a non-admin, call `GET /api/admin/audit-logs` → `403`.
7. **Audit (US4, SC-005)**: as Admin, change a user's role → an `audit_logs` row exists with
   prev/new/actor/timestamp; confirm there is no app path to edit/delete it.
8. **Last-admin guard (FR-016)**: with one active admin, try to disable/down-role it → `409`.
9. **Disable (SC-007)**: disable a signed-in user → their next request is rejected.
10. **pt-BR (SC-006)**: every screen renders in Portuguese; no hard-coded strings.

## Automated tests

```powershell
pnpm test           # Vitest: can() x §18 matrix, Zod schemas (customer_viewer rejected),
                    #         last-admin guard, writeAudit mapping, status transitions
pnpm test:e2e       # Playwright: login (valid/invalid), unauth redirect, sign-out, forgot-pw,
                    #         create user (both paths), non-admin denied (UI + API 403),
                    #         role-specific nav, disabled sign-in, last-admin guard, audit visible
```

Quality gate before PR (Constitution / DELIVERY-WORKFLOW): `pnpm lint && pnpm typecheck && pnpm build &&
pnpm test`. Feature branch → PR to **`dev`** (never `main`).
