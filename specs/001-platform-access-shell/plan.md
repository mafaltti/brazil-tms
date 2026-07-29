# Implementation Plan: Platform, Access, and App Shell

**Branch**: `001-platform-access-shell` | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md)

**Input**: Feature specification from `/specs/001-platform-access-shell/spec.md`

## Summary

Deliver the platform foundation: internal users authenticate (Supabase Auth), reach a pt-BR
authenticated app shell, and operate under a role-aware permission model enforced in the BFF — plus a
Users & Roles administration area and a reusable, append-only audit foundation. Technical approach
(from [research.md](./research.md)): Next.js 15 App Router with `@supabase/ssr` cookie sessions and a
server-only `verifySession()`/`requireAuth()` DAL (`getUser()`-based, reads role/status fresh from
Postgres each request); a **static role→permission catalog** in `packages/shared` (`can()`), no DB
permissions table; admin user management via the Supabase Auth Admin API (invite **and** temp-password
onboarding) with app-profile rows in Postgres (Drizzle); an application-level `writeAudit` in the same
transaction as each mutation; `next-intl` v4 (pt-BR, no URL routing) + Luxon/`Intl` for dates/BRL;
TanStack Query polling (no Realtime); react-hook-form + Zod forms sharing schemas with the BFF.
No worker job is needed for this feature.

Primary requirement IDs: **AUTH-001, AUTH-002, AUTH-003, AUTH-005**. Out of scope: SSO (AUTH-006),
Customer Viewer / tenant scoping (AUTH-004), configurable permissions table, direct browser DB access,
Realtime/Edge Functions, and all operational domains (features 002–009).

## Technical Context

**Language/Version**: TypeScript 5.x (strict); Node.js 20 LTS.

**Primary Dependencies**: Next.js 15 (App Router, ≥15.2.3); `@supabase/ssr` + `@supabase/supabase-js`;
Drizzle ORM + Drizzle Kit; `next-intl` v4; TanStack Query v5 (+ TanStack Table where needed); Zod;
react-hook-form + `@hookform/resolvers`; Tailwind CSS + shadcn/ui + lucide-react; Luxon.

**Storage**: self-hosted Supabase — Postgres (app schema: `public.users`, `public.audit_logs`,
`app_role` enum) + GoTrue Auth (`auth.users`, owned by Supabase) + Storage (unused in 001). App-schema
access via Drizzle over a direct, server-only Postgres connection (not PostgREST).

**Testing**: Vitest (unit — `can()`, Zod schemas, last-admin guard, `writeAudit`, status transitions);
Playwright (login, route guard, admin flows, non-admin 403, audit visibility).

**Target Platform**: Linux server via Docker Compose (Supabase, app, worker, Caddy); evergreen browsers.

**Project Type**: Web application — monorepo (`apps/web` + `packages/{shared,db}`). Worker not used here.

**Performance Goals**: no hard targets for this foundation (deferred per spec clarify). Each authed
request adds ~1 GoTrue `getUser()` round-trip + 1 indexed Postgres read, deduplicated per request via
React `cache()`; well within typical web-app interaction norms.

**Constraints**: BFF-only data access; service-role key server-only; Supabase gateway/PostgREST never
public; **NO** Realtime / Edge Functions / Redis-broker / microservices / route optimizer; freshness via
TanStack Query polling; UI pt-BR from day one; timestamps UTC, displayed `America/Sao_Paulo`; currency BRL.

**Scale/Scope**: small internal user base (tens–low hundreds); 3 app data structures; ~6 screens (login,
forgot/set-password, shell home, users list, user detail, audit list) + ~8 BFF endpoints.

*No unresolved NEEDS CLARIFICATION — all spec gaps were resolved in research.md. Deployment items
(GoTrue SMTP, session-timeout env vars on the pinned image, Caddy header strip) are flagged
**[VERIFY AT SETUP]** with chosen defaults and do not block the build.*

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

**Initial check (pre-research): PASS.** **Post-design re-check (after Phase 1): PASS — no new violations.**

- [x] **Simplicity (I)**: static role→permission map + thin `requireAuth()` helper (no framework, no HOF,
  no DB permissions table); no new packages beyond `shared` + `db`; `writeAudit` kept in `apps/web`
  until ≥3 features reuse it. No abstraction introduced without ≥3 repetitions.
- [x] **Scope (II)**: bounded to platform/access/roles/shell/audit/i18n; Customer Viewer & SSO deferred;
  operational permission keys are *declared* (string literals) but *enforced* by later features — not
  marked complete here. No §29 data-input gate applies to 001; Input #7 (scope guard) noted, not
  marked complete.
- [x] **System-of-record (III)**: Postgres owns `users` + `audit_logs`; audit immutable/append-only
  (no update/delete path + `REVOKE`); soft-delete only (disable, never hard delete); `status` is an
  explicit enumerated state machine with declared transitions.
- [x] **Authz & secrets (IV)**: BFF (`requireAuth()` + `can()`) is the single authorization point; RLS
  deferred; service-role key server-only; PostgREST not publicly exposed; user/role/status changes are
  audited.
- [x] **Config over code (V)**: no customer-variation surface in this feature; the fixed role enum is
  intentionally code (not config) per the spec, and no per-customer code is introduced.
- [x] **Tech constraints**: self-hosted Supabase (Postgres/Auth/Storage); polling-only (TanStack Query);
  **no** Realtime, Edge Functions, Redis/BullMQ, microservices, or route optimizer; no worker job needed.
- [x] **Workflow**: feature branch → PR to `dev`; CI gates (lint/typecheck/build/tests) green; PR
  template used; AI does not merge to `main`.

No violations → **Complexity Tracking is empty.**

## Project Structure

### Documentation (this feature)

```text
specs/001-platform-access-shell/
├── plan.md              # This file
├── research.md          # Phase 0 — decisions (auth, authz, audit, i18n, onboarding, db)
├── data-model.md        # Phase 1 — users, app_role enum, audit_logs
├── contracts/
│   ├── bff-endpoints.md     # BFF Route Handler request/response contracts
│   └── permission-matrix.md # static role→permission catalog (from PRD §18)
├── quickstart.md        # Phase 1 — setup/run/verify/test
├── checklists/
│   └── requirements.md  # spec quality checklist (from /speckit-specify)
└── tasks.md             # Phase 2 — created by /speckit-tasks (NOT here)
```

### Source Code (repository root)

Web-application monorepo. Concrete paths this feature touches:

```text
apps/web/
├── app/
│   ├── layout.tsx                         # root: NextIntlClientProvider, QueryClient provider
│   ├── (auth)/login/page.tsx              # /login (outside shell)
│   ├── (auth)/forgot-password/page.tsx
│   ├── (auth)/set-password/page.tsx       # invite landing + forced-change flow
│   ├── (shell)/layout.tsx                 # authed shell (sidebar/topbar); verifySession guard
│   ├── (shell)/page.tsx                   # home/dashboard placeholder
│   ├── (shell)/admin/users/page.tsx       # Users & Roles list (Admin)
│   ├── (shell)/admin/users/[id]/page.tsx  # user detail/edit
│   ├── (shell)/admin/audit/page.tsx       # audit list (Admin)
│   └── api/
│       ├── auth/{sign-in,sign-out,forgot-password,change-password}/route.ts
│       ├── admin/users/route.ts           # GET list, POST create
│       ├── admin/users/[id]/route.ts      # PATCH role/status
│       ├── admin/users/[id]/invite/route.ts
│       └── admin/audit-logs/route.ts      # GET (Admin)
├── lib/
│   ├── supabase/{server.ts,browser.ts,admin.ts}
│   ├── auth/{session.ts,require-auth.ts}  # verifySession (cache()), requireAuth (server-only)
│   ├── audit/write-audit.ts               # writeAudit(tx, entry) — server-only
│   ├── query-client.ts
│   └── nav.ts                             # nav config gated by can()
├── components/{shell/*, ui/* (shadcn), users/*, forms/*}
├── messages/pt-BR.json                    # i18n catalog
├── src/i18n/request.ts                    # next-intl (locale fixed = pt-BR)
├── middleware.ts                          # coarse unauth → /login (UX only)
└── e2e/                                   # Playwright

packages/shared/src/
├── auth/permissions.ts                    # Role, PermissionKey, ROLE_PERMISSIONS, can()
├── schemas/{auth.ts,admin-user.ts}        # Zod (shared by UI + BFF)
├── audit/actions.ts                       # AuditAction union, AuditEntry type
└── formatting.ts                          # Luxon + BRL helpers

packages/db/
├── schema/{enums.ts,users.ts,audit-logs.ts}  # Drizzle schema
├── migrations/                                # drizzle-kit output
├── seed/001-admin.ts                          # bootstrap first Admin
└── drizzle.config.ts

infra/supabase/                            # Docker Compose + GoTrue env (SMTP, session timeouts, JWT)
workers/                                   # present in monorepo, UNUSED by feature 001
```

**Structure Decision**: Web-application monorepo (`apps/web` BFF+UI, `packages/shared` domain/schemas,
`packages/db` migrations/seed) — exactly the two packages mandated by STACK §7 / Constitution; no new
package or service is introduced. The `workers/` package stays empty for this feature (no long-running
work). This is the foundation other features build on, so cross-cutting primitives (auth context,
`can()`, `writeAudit`, formatting, i18n) are placed for reuse without premature abstraction.

## Complexity Tracking

> No Constitution Check violations — this section is intentionally empty.

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| — | — | — |
