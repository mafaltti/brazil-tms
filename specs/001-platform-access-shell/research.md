# Phase 0 Research: Platform, Access, and App Shell

**Feature**: 001-platform-access-shell | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

This document resolves the technical unknowns flagged in the spec (Supabase Auth ↔ BFF wiring, i18n
library, audit/permission patterns, onboarding flows) and records the decisions that drive the
Phase 1 design. Each decision is grounded in `docs/STACK.md` / the constitution and confirmed against
current (late-2025/early-2026) library guidance. Items that can only be confirmed against the running
self-hosted stack are marked **[VERIFY AT SETUP]** with a chosen default so they do not block planning.

---

## 1. Supabase Auth ↔ Next.js App Router (session & BFF auth context)

**Decision**: Use **`@supabase/ssr`** with cookie-based sessions. Three server-side clients:
- `lib/supabase/server.ts` — `createServerClient(url, publishableKey, { cookies })` bound to
  `cookies()` from `next/headers`; used to read/refresh the *current user's* session.
- `lib/supabase/browser.ts` — `createBrowserClient(url, publishableKey)`; auth-only (sign-in/out).
- `lib/supabase/admin.ts` — `createClient(url, serviceRoleKey, { auth:{ autoRefreshToken:false,
  persistSession:false } })`; **server-only**, used solely for `auth.admin.*` user-management calls.

Session validation is done with **`supabase.auth.getUser()`** (round-trips to GoTrue and is
authoritative), **never `getSession()`** (reads the cookie without re-validating). The session JWT is
stored in `HttpOnly`, `SameSite=Lax`, `Secure` cookies — the browser never holds the raw token in JS.

**Auth context — the DAL pattern**: a server-only `verifySession()` in `apps/web/lib/auth/session.ts`,
wrapped in React `cache()` so repeated calls in one request hit GoTrue + Postgres once. It (a) calls
`getUser()` via the cookie-bound server client, (b) loads the app `users` profile (role, status) via
Drizzle, (c) returns `{ userId, role, status, user }` or signals unauthenticated. `requireAuth()`
builds on it and throws `Unauthorized`/`Forbidden`. This is the single reusable capability of FR-010.

**Rationale**: `@supabase/ssr` is the official, current package (`auth-helpers-nextjs` is deprecated).
Cookie storage is required for SSR. Reading role/status fresh from Postgres each request (not from the
JWT) makes role changes and disables take effect on the next request (spec edge cases, SC-007).

**Alternatives rejected**: Auth.js/next-auth (adds an abstraction over GoTrue that fights the
admin/invite/ban flows); localStorage JWT + anon-key browser data access (prohibited by STACK §5.1/§5.2).

**Sources**: Supabase "Server-Side Auth for Next.js" & "Creating a client for SSR" docs.

---

## 2. Route protection (defense-in-depth)

**Decision**: Three layers, only the last two are security boundaries:
1. **`middleware.ts`** — coarse, fast UX guard: if no session cookie on a protected path, redirect to
   `/login`. **Not** the security guarantee.
2. **DAL `verifySession()` / `requireAuth()`** — authoritative check in every Route Handler / Server
   Action / sensitive Server Component.
3. **Permission check** — `requireAuth()` then `can(role, permission)`; returns **401** when
   unauthenticated, **403** when authenticated-but-forbidden.

**[VERIFY AT SETUP] CVE-2025-29927**: Next.js middleware could be bypassed via a crafted
`x-middleware-subrequest` header on self-hosted `next start` (patched in Next.js ≥15.2.3). Mitigation:
pin Next.js ≥15.2.3, **never** rely on middleware as the sole auth gate (the DAL pattern is exactly
this), and configure Caddy to strip the `x-middleware-subrequest` header inbound.

**[VERIFY AT SETUP] middleware filename**: a report suggested Next.js 16 renames `middleware.ts` →
`proxy.ts`. **Decision: pin Next.js 15.x (App Router) and use `middleware.ts`.** Re-verify the
filename if/when upgrading to 16.

**Rationale**: layouts can be bypassed by client-side segment navigation, so they are UI-only gates;
server-side enforcement in the BFF is mandatory (FR-009, FR-011, Constitution IV).

**Sources**: WorkOS "Next.js App Router auth 2026"; Datadog CVE-2025-29927 writeup.

---

## 3. Secret isolation (browser vs server)

**Decision**: Browser bundle holds only `NEXT_PUBLIC_SUPABASE_URL` and
`NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY` (the publishable/anon key, used only to reach GoTrue for
sign-in/out — it cannot reach Postgres because PostgREST is not publicly exposed and RLS is deferred).
The **service-role key** (`SUPABASE_SERVICE_ROLE_KEY`, no `NEXT_PUBLIC_` prefix) is server-only and used
exclusively by `lib/supabase/admin.ts`. App-schema data access does **not** use PostgREST at all — it
uses **Drizzle over a direct Postgres connection** (server-only; see §9).

**[NOTE] Supabase key rename (June 2025)**: `anon` → `sb_publishable_…`, `service_role` →
`sb_secret_…`; legacy names valid through end of 2026. Either naming works; keep the publishable key in
`NEXT_PUBLIC_*` and the secret key out of it.

**Rationale**: satisfies Constitution IV / STACK §5.1–§5.2 and FR-023 (no direct browser DB access).

---

## 4. Session lifetime: rolling + idle expiry (FR-003a)

**Decision**: configure GoTrue (self-hosted) env in `infra/supabase/`:
- `GOTRUE_JWT_EXP=3600` (1 h access token; `@supabase/ssr` middleware refreshes ~60 s before expiry →
  rolling behavior while active).
- `GOTRUE_SECURITY_REFRESH_TOKEN_ROTATION_ENABLED=true`, `GOTRUE_SECURITY_REFRESH_TOKEN_REUSE_INTERVAL=10`.
- `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT=8h` (idle window) and `GOTRUE_SESSIONS_TIMEBOX=720h` (30-day
  absolute max) — **configurable defaults** per FR-003a.

**[VERIFY AT SETUP]** `GOTRUE_SESSIONS_INACTIVITY_TIMEOUT` / `GOTRUE_SESSIONS_TIMEBOX` exist in the
GoTrue codebase but are under-documented for self-host; confirm they take effect on the pinned GoTrue
image. **Fallback** if they don't: store `last_active_at` and enforce the idle window inside
`verifySession()` (app-layer). The fallback is only wired if the env vars prove ineffective.

**Sources**: Supabase "User sessions" docs; GoTrue `example.env`; GitHub discussion #34368.

---

## 5. Sign-out & disabled-user / role-change enforcement (FR-005, SC-007)

**Decision**:
- **Sign-out**: `auth.signOut()` revokes the refresh token at GoTrue; clear all session cookies; redirect
  to `/login`.
- **Disable a user**: BFF (admin client) calls `auth.admin.updateUserById(id, { ban_duration:'876600h' })`
  (≈permanent; `'none'` to re-enable). Because issued JWTs are stateless, **the authoritative gate is
  the per-request `verifySession()` check of `users.status`** — a `disabled` profile is rejected
  immediately on the next request (satisfies SC-007 without waiting for JWT expiry). GoTrue ban
  additionally blocks new sign-ins and refreshes.
- **[VERIFY AT SETUP] best-effort global sign-out on disable**: `auth.admin.signOut(jwt, scope)` may
  require the *target user's* JWT (which the BFF does not hold). **Decision: do not depend on it** — the
  per-request `users.status` check + `ban_duration` fully satisfy the spec; treat any working global
  sign-out as optional hardening only.
- **Role change mid-session**: role is read from `users.role` each request, so it applies on the next
  request — no session invalidation needed (spec edge case).

**Sources**: Supabase signOut docs; GitHub discussions #9239, #36612.

---

## 6. User onboarding — both paths (FR-013a)

**Decision**: support both, selected by the admin at creation:
- **Path A — invite email**: `auth.admin.inviteUserByEmail(email, { redirectTo:'/auth/set-password',
  data:{ name } })`. App profile created immediately with `status='pending'`. The user clicks the link,
  lands on `/auth/set-password`, sets a password; on their first authenticated request the BFF promotes
  `pending → active` (idempotent, `WHERE status='pending'`) and stamps `last_login_at`.
- **Path B — admin-set temporary password**: `auth.admin.createUser({ email, password, email_confirm:true,
  user_metadata:{ name }, app_metadata:{ must_change_password:true } })`. Profile starts `status='active'`
  with `must_change_password=true`. `email_confirm:true` lets them sign in immediately.

**Forced password change**: authoritative flag is **`users.must_change_password`** (Postgres column),
checked in `verifySession()` — when true, every route except the change-password flow returns a
`PASSWORD_CHANGE_REQUIRED` signal and the UI routes to `/auth/set-password`. (The `app_metadata` copy is
belt-and-suspenders; the JWT claim alone is stale-unsafe.) Cleared to `false` on successful change.

**[VERIFY AT SETUP] SMTP**: both Path A and forgot-password (FR-004) require GoTrue SMTP. Configure
`SMTP_*` + `SMTP_ADMIN_EMAIL`/`SMTP_SENDER_NAME` and `GOTRUE_MAILER_AUTOCONFIRM=false`. Without SMTP,
`inviteUserByEmail` fails silently. **This is a deployment input to confirm** (a configurable infra
dependency, not a code blocker — Path B works without it).

**Invite expiry**: GoTrue invite tokens expire (default); provide a **"resend invite"** admin action for
`pending` users.

**Sources**: Supabase `inviteUserByEmail` / `createUser` / Auth-SMTP / email-templates / JWT-fields docs.

---

## 7. Profile ↔ auth.users linkage & creation ordering

**Decision**: `public.users.id` **=** `auth.users.id` (same GoTrue UUID; no surrogate key). On create:
1) call GoTrue (invite/createUser) → get `id`; 2) insert the `public.users` profile (Drizzle) with that
`id`; 3) on profile-insert failure, compensate with `auth.admin.deleteUser(id)`; if compensation fails,
log a critical error with the orphaned id for manual cleanup. Email is stored in both places and set
atomically at creation (admin-only; email change is not in scope for this feature).

**Rationale**: no distributed transaction exists; auth-first + compensation minimizes orphan harm (an
auth user with no profile is inert because the BFF always requires a profile row).

---

## 8. Authorization model — static role→permission map (FR-006..FR-011)

**Decision**: a static, code-defined map in **`packages/shared/src/auth/permissions.ts`**:
`Role` (7 MVP roles), `PermissionKey` (union), `ROLE_PERMISSIONS: Record<Role, ReadonlySet<PermissionKey>>`,
and a pure `can(role, permission): boolean`. **No DB permissions table** (FR-008, Constitution V/PRINCIPLES).

- **Roles** (enum values): `admin`, `operations_manager`, `dispatcher`, `control_tower`,
  `fleet_coordinator`, `finance`, `executive_viewer`. `customer_viewer` exists in the DB enum as a
  **reserved, non-assignable** value (FR-007).
- **Permission keys enforced in 001**: `manage_users`, `view_audit_log` (both Admin-only per §18 / FR-020a).
- **Catalog completeness**: the full operational permission keys from the PRD §18 matrix
  (`view_all_trips`, `import_trips`, `edit_trip_plan`, `assign_resources`, `update_trip_status`,
  `cancel_trip`, `mark_completed`, `mark_billing_ready`, `resolve_dispute`, `delete_archive`,
  `create_exceptions`, `resolve_exceptions`, `upload_documents`, `verify_documents`, `edit_rates`,
  `export_billing`) are **declared now** as union members + mapped per the §18 matrix, but their
  *enforcement points* are added by features 002–009. Declaring them is zero-cost (string literals) and
  prevents every later feature from editing this file — satisfying FR-010.
- **Collapse identical roles (YAGNI)**: analysis of the §18 matrix shows **no two MVP roles share an
  identical permission set** (Admin is a superset; Executive Viewer is read-only; the other five diverge
  on import/assign/status/complete/billing/verify). **Decision: collapse nothing** — they already diverge.

**Sources**: PRD §14/§18/§30; STACK §3.8; PRINCIPLES (DRY/YAGNI); Constitution IV.

---

## 9. BFF authz guard + nav gating

**Decision**: thin server-only helper `requireAuth(): Promise<AuthContext>` (built on `verifySession()`)
+ `can()` checks in each Route Handler (401 vs 403 as in §2). The app shell (a Server Component layout)
calls `requireAuth()` once and passes `role` to a nav component that filters items via the **same**
`can()`/permission catalog — UI hiding is additive only; the BFF stays authoritative (FR-011). No HOF
wrapper, decorator, or framework (KISS/YAGNI).

---

## 10. Audit log — append-only table + `writeAudit` helper (FR-017..FR-020a)

**Decision**: application-level audit writes from the BFF (**no DB triggers** — STACK §6.2 makes
audited mutations a BFF responsibility and keeps them testable). Table `public.audit_logs` (see
data-model). The write goes in the **same Drizzle transaction** as the mutation it records, so a
critical change can never be "missing" (SC-005).

- **Helper**: `writeAudit(tx, entry)` in `apps/web/lib/audit/write-audit.ts` (server-only; it needs a DB
  handle, so it does not belong in `packages/shared` yet — move it there once ≥3 features reuse it).
- **Action type**: DB column is `text`; app uses a typed `AuditAction` union in
  `packages/shared/src/audit/actions.ts`, extended per feature. **001 actions**: `user.create`,
  `user.role_change`, `user.status_change`, `user.invite_sent`.
- **previous/new value**: `jsonb` snapshots of only the relevant fields (e.g. `{ role }`), not whole rows.
- **Append-only enforcement**: primarily app-layer (no update/delete code path exists). Add
  `REVOKE UPDATE, DELETE ON public.audit_logs FROM PUBLIC;` in the migration as cheap hardening. A
  dedicated restricted Postgres role is deferred (YAGNI) — recorded as future hardening.
- **Read access**: only `GET /api/admin/audit-logs`, gated by `can(role,'view_audit_log')` → Admin-only
  (FR-020a). Failed last-admin-guard attempts are **not** audited (operation didn't occur; YAGNI).

**Sources**: PRD §14/§21.5; STACK §3.7/§5.4/§6.2; Constitution III/IV.

---

## 11. Last-active-admin guard (FR-016)

**Decision**: enforce in the BFF inside the mutation transaction. Before any update that would either
disable an `admin` or change an `admin`'s role away from admin, run
`SELECT count(*) FROM users WHERE role='admin' AND status='active' AND id <> :targetId FOR UPDATE`;
if `0`, reject with **HTTP 409 `LAST_ADMIN_GUARD`** and do not touch GoTrue. The `FOR UPDATE` lock
prevents a concurrent double-disable race. The UI also disables the control, but the BFF is authoritative.

---

## 12. i18n / localization (FR-021, FR-022, SC-006)

**Decision**: **`next-intl` v4** in **"without i18n routing"** mode (locale fixed server-side in
`src/i18n/request.ts`, clean URLs). Messages in `apps/web/messages/pt-BR.json`, namespaced by
feature/screen. Every user-facing string goes through `t()` (`useTranslations`/`getTranslations`) — zero
hard-coded strings, optionally enforced by an ESLint no-literal-JSX-string rule (SC-006). Adding a locale
later = add `messages/<locale>.json` + resolve locale from user preference in `request.ts` (a known,
low-cost migration point — MVP hardcodes `'pt-BR'`).

**Dates/currency**: **Luxon** with `America/Sao_Paulo` for display, UTC for storage; **`Intl.NumberFormat
('pt-BR',{style:'currency',currency:'BRL'})`** for money. Pure helpers in
`packages/shared/src/formatting.ts` (`fromUtc`, `formatDate`, `formatDateTime`, `formatRelative`,
`toUtcIso`, `formatBRL`). Store monetary amounts as integer centavos. Never use `new Date()` for
user-visible times.

**Validation messages**: inline **pt-BR** strings in the Zod schemas (KISS, single locale). A global
`z.setErrorMap` provides pt-BR defaults. The schema-factory-with-`t()` pattern is deferred until runtime
locale switching is needed.

**Sources**: next-intl v4 docs (App Router, without-routing); Luxon zones docs; TanStack/shadcn refs below.

---

## 13. App shell, data freshness, and forms

**Decision**:
- **Shell**: shadcn/ui `Sidebar` + topbar inside a `(shell)` route group; `/login`,
  `/forgot-password`, `/auth/set-password` live in an `(auth)` group **outside** the shell. The
  `(shell)/layout.tsx` Server Component calls `verifySession()` (getUser-based — **not** `getSession()`)
  and redirects unauthenticated users. Administration → Users & Roles at `/admin/users`; Audit at
  `/admin/audit` (both Admin-only).
- **Freshness**: **TanStack Query v5**, polling only (no Realtime). Global defaults `staleTime≈30s`,
  `refetchOnWindowFocus:true`, `retry:2`. Users/audit lists are low-velocity (no aggressive interval).
- **Forms**: **react-hook-form + `@hookform/resolvers/zod`** (shadcn/ui's documented form integration),
  schemas imported from `packages/shared` so UI and BFF validate identically (DRY).

**Sources**: shadcn/ui Sidebar & Form (react-hook-form) docs; TanStack Query v5 polling/defaults docs.

---

## 14. Database tooling, migrations, seed, testing

**Decision (tooling)**: **Drizzle ORM + Drizzle Kit** for `packages/db` (schema in
`packages/db/schema/`, generated SQL in `packages/db/migrations/`, applied via `drizzle-kit migrate`).
STACK §3.7 says only "Supabase migrations or SQL migration tooling" (no ORM named); Drizzle Kit **is**
SQL migration tooling, gives transactions (needed for §10/§11) and type-safety, talks plain Postgres to
self-hosted Supabase, and matches prior repo usage. **[CONFIRM]** this choice before scaffolding
`packages/db`; the simpler alternative (raw SQL + a minimal runner) remains open if the team prefers it.

**App-schema access** uses Drizzle over a direct, server-only Postgres connection (not PostgREST).
GoTrue's `auth.users` is owned by Supabase — **do not recreate it**; the app only owns `public.users`,
`public.audit_logs`, and the `app_role` enum (see data-model).

**Seed**: `packages/db/seed/001-admin.ts` (run via `tsx`), reads `SEED_ADMIN_EMAIL`/`SEED_ADMIN_PASSWORD`
from env (never hardcoded), idempotently creates the GoTrue auth user (`admin.createUser`,
`email_confirm:true`) + the `public.users` admin profile (`must_change_password:true`). This bootstraps
the only Admin so the system can create the rest.

**Worker — confirmed NOT needed for 001**: all operations are synchronous request/response; pg-boss/
graphile-worker is not set up in this feature (the `workers/` package stays empty here).

**Testing (Constitution gate + STACK §3.13)**:
- **Vitest (unit)**: `can()` across all 7 roles × §18 matrix; Zod schemas (incl. `customer_viewer`
  rejected); last-admin guard; `writeAudit` field mapping & no mutate path; status transitions;
  `must_change_password` gating.
- **Playwright (critical flows)**: login valid/invalid; unauth deep-link → `/login`; sign-out; forgot
  password (neutral response); admin create user (both paths); non-admin denied to Users & Roles
  (UI + direct API 403, no state change); role-specific nav; disabled-user sign-in rejected;
  last-admin guard; audit entry visible after role change (Admin only).

**[VERIFY AT SETUP] DB grant model**: if all app DB access uses a superuser/service connection, the
`REVOKE` on `audit_logs` is cosmetic; the app-layer no-mutate-path is then the real guarantee. A
restricted app role is deferred.

---

## Resolved-unknowns summary

| Spec/clarify item | Resolution |
|---|---|
| Supabase Auth ↔ BFF session | `@supabase/ssr` cookies + `getUser()` DAL (`verifySession`/`requireAuth`) |
| Route protection | middleware (UX) + DAL + `can()` (401/403); Next.js 15, patched |
| Session policy (FR-003a) | GoTrue rolling JWT + rotation + idle/absolute timeouts (defaults 8h/720h) |
| Disable/role-change (SC-007) | per-request `users.status`/`role` check + GoTrue ban |
| Onboarding (FR-013a) | invite (`pending`) **and** temp-password (`must_change_password`) |
| Forced password change | `users.must_change_password` column, checked in DAL |
| Authorization (FR-006..011) | static `ROLE_PERMISSIONS` map + `can()` in `packages/shared` |
| Audit (FR-017..020a) | app-level `writeAudit` in mutation txn; append-only; Admin-only read |
| Last-admin guard (FR-016) | BFF `SELECT … FOR UPDATE` precondition → 409 |
| i18n (FR-021/022, SC-006) | next-intl v4 (pt-BR, no routing) + Luxon + Intl BRL |
| DB tooling | Drizzle ORM + Drizzle Kit (`packages/db`) — confirm |
| Worker | not needed for 001 |

**Deployment inputs to confirm (not code blockers)**: GoTrue SMTP (Path A + forgot-password); GoTrue
session-timeout env vars on the pinned image; Next.js pinned ≥15.2.3; Caddy strips
`x-middleware-subrequest`. None block the build; the temp-password path and all authz/audit work proceed
without them.
