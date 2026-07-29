---
description: "Task list for feature 001 - Platform, Access, and App Shell"
---

# Tasks: Platform, Access, and App Shell

**Input**: Design documents from `/specs/001-platform-access-shell/`

**Prerequisites**: [plan.md](./plan.md), [spec.md](./spec.md), [research.md](./research.md),
[data-model.md](./data-model.md), [contracts/](./contracts/)

**Tests**: INCLUDED. The constitution's Development Workflow & Quality Gates mandate permission-check
unit tests (Vitest) and critical-flow tests (Playwright); STACK §3.13 lists "permission checks" as a
required test focus. Test tasks are therefore part of each story.

**Organization**: Tasks are grouped by user story (from spec.md) so each story is independently
implementable and testable.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: Can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: US1–US4 (user-story phases only)
- Exact file paths are included in each task

## Path Conventions

Web-application monorepo (per plan.md Structure Decision): `apps/web/` (Next.js BFF + UI),
`packages/shared/` (domain, Zod, permissions, formatting), `packages/db/` (Drizzle schema, migrations,
seed), `infra/` (Supabase + Caddy). `workers/` is unused by this feature.

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Monorepo scaffolding and tooling.

- [X] T001 Initialize the pnpm monorepo at repo root: `pnpm-workspace.yaml`, root `package.json`, shared `tsconfig.base.json` (TypeScript strict), and the package folders `apps/web`, `packages/shared`, `packages/db`, `workers/` (empty placeholder).
- [X] T002 [P] Scaffold the Next.js 15 App Router app (TypeScript strict) in `apps/web/` with Next.js pinned `>=15.2.3` (CVE-2025-29927); create `apps/web/app/layout.tsx` shell root.
- [X] T003 [P] Initialize `packages/shared` (`package.json` as `@brazil-tms/shared`, `tsconfig.json`, `src/index.ts`).
- [X] T004 [P] Initialize `packages/db` with Drizzle ORM + Drizzle Kit: `packages/db/package.json` (`@brazil-tms/db`), `packages/db/drizzle.config.ts`, and `db:migrate`/`db:seed` scripts.
- [X] T005 [P] Configure Tailwind CSS + shadcn/ui + lucide-react in `apps/web` (`apps/web/tailwind.config.ts`, `apps/web/components.json`, base `components/ui/`).
- [X] T006 [P] Configure ESLint + Prettier at repo root, including a no-literal-JSX-string rule scoped to `apps/web/**/*.tsx` to enforce SC-006 (no hard-coded user-facing strings).
- [X] T007 [P] Configure Vitest (`vitest.config.ts` at root and/or per package) for unit tests in `packages/shared` and `apps/web/lib`.
- [X] T008 [P] Configure Playwright in `apps/web/playwright.config.ts` with an `apps/web/e2e/` test dir and a test-env bootstrap.
- [X] T009 Author `infra/supabase/docker-compose.yml` (Postgres + GoTrue Auth + Storage) with GoTrue env (`GOTRUE_JWT_EXP=3600`, refresh-token rotation, `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=8h`, `GOTRUE_SESSIONS_TIMEBOX=720h`, `GOTRUE_MAILER_AUTOCONFIRM=false`, `SMTP_*`), `infra/caddy/` config that strips the `x-middleware-subrequest` header, and `.env.example` files (`apps/web/.env.local.example`, `infra/supabase/.env.example`).

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Core infrastructure every user story depends on.

**⚠️ CRITICAL**: No user story work can begin until this phase is complete.

- [X] T010 Define the Drizzle schema for the `app_role` enum (7 MVP roles + reserved `customer_viewer`) and `public.users` in `packages/db/schema/enums.ts` and `packages/db/schema/users.ts` (per [data-model.md](./data-model.md)).
- [X] T011 Define the Drizzle schema for append-only `public.audit_logs` in `packages/db/schema/audit-logs.ts` (no `updated_at`/soft-delete columns; jsonb previous/new values).
- [X] T012 Generate and apply the initial migration via `drizzle-kit` into `packages/db/migrations/`, including `REVOKE UPDATE, DELETE ON public.audit_logs FROM PUBLIC;` (append-only hardening). Do NOT recreate `auth.users` (owned by GoTrue).
- [X] T013 [P] Create the server-only Drizzle Postgres client in `packages/db/src/client.ts` (reads `DATABASE_URL`; exported for the BFF).
- [X] T014 [P] Create the Supabase clients in `apps/web/lib/supabase/`: `server.ts` (`createServerClient` + cookies), `browser.ts` (`createBrowserClient`, auth-only), `admin.ts` (service-role, `auth.admin.*`, server-only).
- [X] T015 Implement the auth DAL in `apps/web/lib/auth/session.ts` (`verifySession()` — `getUser()` via server client, load `users` profile via Drizzle, wrapped in React `cache()`; checks `status`/`must_change_password`) and `apps/web/lib/auth/require-auth.ts` (`requireAuth()` returning `AuthContext`, with typed `Unauthorized`/`Forbidden` → 401/403). Authentication only (permission assertion added in US2).
- [X] T016 [P] Scaffold next-intl in `apps/web/src/i18n/request.ts` (locale fixed to `pt-BR`), wire `NextIntlClientProvider` in `apps/web/app/layout.tsx`, and create the base `apps/web/messages/pt-BR.json`.
- [X] T017 Set up the TanStack Query client + provider in `apps/web/lib/query-client.ts` and wire it in `apps/web/app/layout.tsx` (polling defaults; no Realtime). Sequenced after T016 (both edit `apps/web/app/layout.tsx`).
- [X] T018 [P] Add date/time + currency formatting helpers (Luxon `America/Sao_Paulo`, UTC storage, `Intl` BRL) in `packages/shared/src/formatting.ts`.
- [X] T019 [P] Implement the coarse auth guard `apps/web/middleware.ts` (redirect unauthenticated requests on protected path prefixes to `/login`; UX-only, not the security boundary).
- [X] T020 Implement the first-Admin seed in `packages/db/seed/001-admin.ts` (`tsx`-run; reads `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`; `auth.admin.createUser({email_confirm:true})` + insert `public.users` profile `role='admin', status='active', must_change_password=true`; idempotent).

**Checkpoint**: Foundation ready — user stories can now proceed.

---

## Phase 3: User Story 1 - Sign in and reach the app (Priority: P1) 🎯 MVP

**Goal**: A user authenticates with email/password and lands on the authenticated pt-BR shell;
unauthenticated requests redirect to login; sign-out works; forgot/set-password flows work.

**Independent Test**: Sign in with valid/invalid credentials; open a protected deep-link while signed
out (→ `/login`); sign out; submit forgot-password for an unknown email (neutral response); complete a
password reset / forced change. (Spec US1, SC-001, SC-007.)

### Tests for User Story 1 ⚠️ (write first, ensure they FAIL)

- [X] T021 [P] [US1] Playwright spec `apps/web/e2e/auth-login.spec.ts`: valid login → shell; invalid → generic error, no session; unauth deep-link → `/login`; sign-out ends session; **disabled user denied at sign-in (no session)** (SC-007/FR-005); **expired session → next protected request redirects to `/login`** (FR-003a).
- [X] T022 [P] [US1] Playwright spec `apps/web/e2e/auth-password.spec.ts`: forgot-password neutral response for unknown email; invite/set-password landing; forced password change on first sign-in.

### Implementation for User Story 1

- [X] T023 [P] [US1] Create the login Zod schema (`loginSchema`, pt-BR messages) in `packages/shared/src/schemas/auth.ts`.
- [X] T024 [US1] Implement `POST /api/auth/sign-in` in `apps/web/app/api/auth/sign-in/route.ts` (`signInWithPassword`, set HttpOnly cookies, promote `pending→active` + stamp `last_login_at`, `must_change_password` redirect signal, `disabled` → 403, generic `401` on bad credentials).
- [X] T025 [US1] Implement `POST /api/auth/sign-out` in `apps/web/app/api/auth/sign-out/route.ts` (`signOut` + clear cookies).
- [X] T026 [US1] Implement `POST /api/auth/forgot-password` in `apps/web/app/api/auth/forgot-password/route.ts` (trigger recovery email; always-neutral response).
- [X] T027 [US1] Implement `POST /api/auth/change-password` in `apps/web/app/api/auth/change-password/route.ts` (set new password, clear `users.must_change_password`).
- [X] T028 [P] [US1] Build the login page (react-hook-form + `zodResolver(loginSchema)`, pt-BR) in `apps/web/app/(auth)/login/page.tsx`.
- [X] T029 [P] [US1] Build the forgot-password page in `apps/web/app/(auth)/forgot-password/page.tsx`.
- [X] T030 [P] [US1] Build the set-password page (invite landing + forced-change) in `apps/web/app/(auth)/set-password/page.tsx`.
- [X] T031 [US1] Build the authenticated shell layout with session guard (calls `verifySession()` → redirect to `/login` if unauthenticated) and a topbar with sign-out in `apps/web/app/(shell)/layout.tsx`.
- [X] T032 [US1] Build the shell home placeholder page in `apps/web/app/(shell)/page.tsx`.
- [X] T033 [P] [US1] Add `Auth` and `Shell` pt-BR strings to `apps/web/messages/pt-BR.json`.

**Checkpoint**: Login, logout, password recovery, and the protected shell work independently (with seeded users).

---

## Phase 4: User Story 2 - Operate under a role-aware permission model (Priority: P1)

**Goal**: Each user has one role; the shell shows only permitted navigation; every protected action/read
is enforced server-side via a single reusable permission capability.

**Independent Test**: Unit-test `can()` across all 7 roles × the §18 matrix; sign in across roles and
confirm role-appropriate nav; call a `manage_users` endpoint as a non-admin directly → `403` with no
state change. (Spec US2, SC-002, SC-003.)

### Tests for User Story 2 ⚠️ (write first, ensure they FAIL)

- [X] T034 [P] [US2] Vitest `packages/shared/src/auth/permissions.test.ts`: `can()` matches [contracts/permission-matrix.md](./contracts/permission-matrix.md) for all 7 roles × all keys; Admin is a superset; `manage_users`/`view_audit_log` are Admin-only; `customer_viewer` is not an assignable role.
- [X] T035 [P] [US2] Playwright `apps/web/e2e/authz.spec.ts`: role-specific nav visibility; non-admin direct `GET /api/admin/users` → `403`, no state change; **a non-admin role still reaches its own permitted area (positive path, 200)** so enforcement is not blanket-deny (SC-002).

### Implementation for User Story 2

- [X] T036 [P] [US2] Implement the static permission catalog (`Role`, `PermissionKey`, `ROLE_PERMISSIONS`, pure `can(role, permission)`) in `packages/shared/src/auth/permissions.ts` per [contracts/permission-matrix.md](./contracts/permission-matrix.md).
- [X] T037 [US2] Add `requirePermission(ctx, key)` (uses `can()`, throws `Forbidden`/403) to `apps/web/lib/auth/require-auth.ts` (depends on T015, T036).
- [X] T038 [P] [US2] Define the role-gated navigation config (items + required permission key) in `apps/web/lib/nav.ts`.
- [X] T039 [P] [US2] Build the role-aware sidebar/nav component that filters items via `can()` in `apps/web/components/shell/app-sidebar.tsx`.
- [X] T040 [US2] Wire the shell layout to pass the current role to the sidebar and render only permitted areas in `apps/web/app/(shell)/layout.tsx` (depends on T031, T038, T039).

**Checkpoint**: The permission model is authoritative server-side and reflected (additively) in the shell.

---

## Phase 5: User Story 3 - Administer users and roles (Priority: P2)

**Goal**: An Admin can list users, create a user (invite or temp-password), assign one role, and
enable/disable users; only `manage_users` roles can access the area; the last active Admin is protected.

**Independent Test**: As Admin create users via both onboarding paths; edit role/status; reject a
duplicate email (409); confirm a non-admin is denied the area (UI + API); confirm the last-admin guard
(409). (Spec US3, SC-004.)

### Tests for User Story 3 ⚠️ (write first, ensure they FAIL)

- [X] T041 [P] [US3] Vitest `packages/shared/src/schemas/admin-user.test.ts`: create/update schemas accept valid input, reject `customer_viewer`, require `tempPassword` (≥8) on the temp-password path, and reject missing required fields.
- [X] T042 [P] [US3] Playwright `apps/web/e2e/admin-users.spec.ts`: create user via invite (→ `pending`) and via temp-password (→ forced change); resend invite for a `pending` user; change role/status; duplicate email → `409`; non-admin denied; last-admin disable/down-role → `409`; **disabling a signed-in user denies their next request (mid-session)**; **a role change is reflected on the user's next request** (spec edge cases).

### Implementation for User Story 3

- [X] T043 [P] [US3] Implement admin-user Zod schemas (`createUserSchema` with `invite|temp_password` discriminated union, `updateUserRoleSchema`, `updateUserStatusSchema`; 7 assignable roles only) in `packages/shared/src/schemas/admin-user.ts`.
- [X] T044 [US3] Implement the user service in `apps/web/lib/users/service.ts`: create (GoTrue-first via `inviteUserByEmail`/`createUser`, then profile insert via Drizzle, compensating `admin.deleteUser` on failure), update role/status (GoTrue `ban_duration` on disable), `pending→active` promotion, and the last-active-Admin guard (`SELECT count(*) … FOR UPDATE` → 409). Depends on T014, T015, T036, T043.
- [X] T045 [US3] Implement `GET`/`POST /api/admin/users` in `apps/web/app/api/admin/users/route.ts` (`requirePermission('manage_users')`; list + create; 400 on validation, 409 on duplicate email).
- [X] T046 [US3] Implement `PATCH /api/admin/users/[id]` in `apps/web/app/api/admin/users/[id]/route.ts` (role/status update via service; last-admin guard; 403/409).
- [X] T047 [US3] Implement `POST /api/admin/users/[id]/invite` (resend invite for `pending` users) in `apps/web/app/api/admin/users/[id]/invite/route.ts`.
- [X] T048 [P] [US3] Build the users list page (TanStack Query + TanStack Table) in `apps/web/app/(shell)/admin/users/page.tsx`; display `last_login_at`/timestamps via the shared Luxon `formatDateTime` helper (America/Sao_Paulo) per FR-022.
- [X] T049 [P] [US3] Build the user create/edit UI (react-hook-form + shared schemas; onboarding-path selector) in `apps/web/app/(shell)/admin/users/[id]/page.tsx` and `apps/web/components/users/`.
- [X] T050 [P] [US3] Add `AdminUsers` pt-BR strings to `apps/web/messages/pt-BR.json`.

**Checkpoint**: Full Users & Roles administration works; Admin-only; last-admin protected.

---

## Phase 6: User Story 4 - Audit foundation for critical actions (Priority: P2)

**Goal**: Critical actions write immutable audit entries (who/what/when/old/new); user/role/status
changes are recorded; only Admin can view audit history; later features reuse the same mechanism.

**Independent Test**: Perform a role change and confirm an Admin-visible audit entry with all required
fields; confirm there is no app path to edit/delete it; confirm a non-admin gets `403` on the audit
view. (Spec US4, SC-005.)

### Tests for User Story 4 ⚠️ (write first, ensure they FAIL)

- [X] T051 [P] [US4] Vitest `apps/web/lib/audit/write-audit.test.ts`: `writeAudit` maps all fields correctly; no update/delete helper is exported (append-only).
- [X] T052 [P] [US4] Playwright `apps/web/e2e/audit.spec.ts`: each of the four audited actions (`user.create`, `user.invite_sent`, `user.role_change`, `user.status_change`) produces a retrievable audit entry with all required fields, visible to Admin (SC-005/US4-AS3); a non-admin gets `403` on `GET /api/admin/audit-logs`.

### Implementation for User Story 4

- [X] T053 [P] [US4] Define the `AuditAction` union (`user.create`, `user.role_change`, `user.status_change`, `user.invite_sent`) and `AuditEntry` type in `packages/shared/src/audit/actions.ts`.
- [X] T054 [US4] Implement `writeAudit(tx, entry)` (same-transaction insert into `audit_logs`; insert-only) in `apps/web/lib/audit/write-audit.ts` (depends on T011, T013, T053).
- [X] T055 [US4] Wire `writeAudit` into the user-service mutations (`user.create`, `user.invite_sent`, `user.role_change`, `user.status_change`) inside the same transaction in `apps/web/lib/users/service.ts` (depends on T044, T054).
- [X] T056 [US4] Implement `GET /api/admin/audit-logs` in `apps/web/app/api/admin/audit-logs/route.ts` (`requirePermission('view_audit_log')`; Admin-only; `created_at DESC`; no write/update/delete endpoints).
- [X] T057 [P] [US4] Build the audit list page (TanStack Query) in `apps/web/app/(shell)/admin/audit/page.tsx`; format `created_at` via the shared Luxon `formatDateTime` helper (America/Sao_Paulo) per FR-022.
- [X] T058 [P] [US4] Add `Audit` pt-BR strings to `apps/web/messages/pt-BR.json`.

**Checkpoint**: All four user stories are independently functional.

---

## Phase 7: Polish & Cross-Cutting Concerns

**Purpose**: Hardening and validation across stories.

- [X] T059 [P] Add Vitest unit tests for `users.status` transitions and `must_change_password` gating in `apps/web/lib/auth/session.test.ts`.
- [X] T060 [P] Verify zero hard-coded user-facing strings across `apps/web` via the i18n ESLint rule (SC-006).
- [ ] T061 Confirm (setup-verify) GoTrue SMTP and `GOTRUE_SESSIONS_*` env vars take effect on the pinned GoTrue image; if the idle timeout is not honored, wire the app-layer `last_active_at` fallback in `apps/web/lib/auth/session.ts` and document it in `infra/supabase/.env.example`. — **[VERIFY AT SETUP — not runnable in this environment]**: requires a live GoTrue image. The env vars are set in `infra/supabase/docker-compose.yml`; chosen defaults + the app-layer fallback decision are documented in `research.md §4` and `infra/supabase/.env.example`. Complete when the stack is stood up.
- [X] T062 [P] Ensure the PR uses the repository PR template (how-to-test section) and reconcile any drift in `specs/001-platform-access-shell/quickstart.md`. (PR template added at `.github/pull_request_template.md`; quickstart commands reconciled against the built scripts.)
- [ ] T063 Run `quickstart.md` manual verification (SC-001–SC-007) and the full quality gate: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e`. — **PARTIAL**: the automated gate `pnpm lint && pnpm typecheck && pnpm build && pnpm test` **PASSES** (154 unit tests). `pnpm test:e2e` and the manual SC-001–SC-007 walkthrough require the running Supabase stack (`docker compose up` + migrate + seed) and are pending that environment.

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (Phase 1)**: no dependencies — start immediately.
- **Foundational (Phase 2)**: depends on Setup — **blocks all user stories**.
- **User Stories (Phases 3–6)**: all depend on Foundational. US1 and US2 are both P1 (start with US1 for
  the MVP; US2 builds on US1's shell). US3 and US4 (P2) depend on Foundational; US4 integrates with US3's
  user-service mutations.
- **Polish (Phase 7)**: depends on the desired stories being complete.

### User story dependencies

- **US1 (P1)**: needs Foundational only. The MVP slice.
- **US2 (P1)**: needs Foundational + T036 (`can()`); the nav-gating task T040 also depends on US1's shell
  layout (T031). US2's *enforcement* (T034/T035/T036/T037) is independently testable without the UI.
- **US3 (P2)**: needs Foundational + US2's `requirePermission`/`can()` (T036/T037) for the `manage_users`
  guard.
- **US4 (P2)**: needs Foundational + T053/T054; T055 integrates into US3's user service (T044). Audit
  read (T056) needs T037.

### Within each story

- Tests are written first and must fail before implementation.
- Shared schemas (`packages/shared`) before services; services before BFF routes; BFF routes before/with
  UI pages; pt-BR strings alongside UI.

### Parallel opportunities

- Setup: T002–T008 are all `[P]` (different files); T001 first, T009 independent.
- Foundational: T013, T014, T016, T018, T019 are `[P]` after T010–T012 (schema/migration); T017 follows T016 (same file).
- Per story, all `[P]` test tasks run together; `[P]` schema/UI/i18n tasks run together (different files).
- After Foundational, US1 and US2 enforcement work can proceed in parallel; US3/US4 can start once
  `can()`/`requirePermission` exist.

---

## Parallel Example: User Story 1

```text
# Tests first (parallel):
T021  Playwright auth-login.spec.ts
T022  Playwright auth-password.spec.ts

# Then parallel implementation (different files):
T023  loginSchema (packages/shared/src/schemas/auth.ts)
T028  login page         T029  forgot-password page    T030  set-password page
T033  pt-BR Auth/Shell strings
# Sequential (shared files / dependencies): T024→T025→T026→T027 (auth routes), then T031→T032 (shell)
```

---

## Implementation Strategy

### MVP first (User Story 1)

1. Phase 1 Setup → 2. Phase 2 Foundational (critical) → 3. Phase 3 US1 → 4. **Validate US1** (login,
shell, redirect, sign-out, password recovery) → demo. This is the smallest viable slice.

### Incremental delivery

Foundational → US1 (MVP) → US2 (role-aware access) → US3 (Users & Roles admin) → US4 (audit) — each a
tested increment that doesn't break the prior one.

### Parallel team strategy

After Foundational: one track drives US1+US2 (access primitives + shell), another prepares US3 schemas
and US4 audit primitives; US3/US4 integrate once `can()`/`requirePermission` land.

---

## Notes

- `[P]` = different files, no incomplete-task dependency. Tasks touching the same file (e.g. multiple
  edits to `apps/web/messages/pt-BR.json` or `app/(shell)/layout.tsx`) are sequenced, not `[P]` together.
- `[Story]` labels (US1–US4) map each task to its spec user story for traceability.
- Auth credentials live in GoTrue (`auth.users`) — never recreated; the app owns `public.users`,
  `public.audit_logs`, `app_role`.
- No worker job is needed for this feature.
- Feature branch → PR to **`dev`** (never `main`); AI must not merge to `main`.
