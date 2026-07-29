# Phase 1 Data Model: Platform, Access, and App Shell

**Feature**: 001-platform-access-shell | **Date**: 2026-05-29 | **Spec**: [spec.md](./spec.md) ·
**Research**: [research.md](./research.md)

Scope: the three application data structures this feature owns. Authentication credentials live in
Supabase **GoTrue** (`auth.users`) and are **not** modeled here (do not recreate that table). The app
schema (`public.*`) is accessed only via the BFF using Drizzle over a server-only Postgres connection.

DDL below is a **design sketch** (final SQL is produced by Drizzle migrations in `packages/db`).
Timestamps are `timestamptz`, stored in UTC (displayed in `America/Sao_Paulo`).

---

## Entity: Role (enum `app_role`)

A closed enumeration. Seven MVP roles are assignable; `customer_viewer` is **reserved** (FR-007) — it
exists so the system can recognize and explicitly reject it, but Zod/BFF never allow assigning it.

```sql
CREATE TYPE app_role AS ENUM (
  'admin',
  'operations_manager',
  'dispatcher',
  'control_tower',
  'fleet_coordinator',
  'finance',
  'executive_viewer',
  'customer_viewer'   -- RESERVED, post-MVP; not assignable (FR-007)
);
```

Permissions are **not** stored against roles in the DB — the role→permission mapping is a static code
catalog (`packages/shared/src/auth/permissions.ts`); see [contracts/permission-matrix.md](./contracts/permission-matrix.md).
Traceability: AUTH-002, PRD §18/§30.

---

## Entity: User profile (`public.users`)

The application profile + role binding for a person who can sign in. `id` mirrors `auth.users.id`.

| Field | Type | Rules |
|---|---|---|
| `id` | `uuid` PK | = `auth.users.id` (GoTrue UUID); FK `REFERENCES auth.users(id) ON DELETE CASCADE` |
| `name` | `text` | required; 2–120 chars (Zod) |
| `email` | `text` | required; **UNIQUE** (FR-015); login identifier; mirrors `auth.users.email` |
| `role` | `app_role` | required; exactly one (FR-006); assignment restricted to the 7 MVP roles (FR-007) |
| `status` | `text` | `CHECK (status IN ('pending','active','disabled'))` (FR-005, FR-013a) |
| `must_change_password` | `boolean` | NOT NULL DEFAULT `false`; `true` for temp-password onboarding (FR-013a) |
| `last_login_at` | `timestamptz` | nullable; set on each successful authenticated request |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` |
| `updated_at` | `timestamptz` | NOT NULL DEFAULT `now()` (touched on update) |

```sql
CREATE TABLE public.users (
  id            uuid PRIMARY KEY REFERENCES auth.users(id) ON DELETE CASCADE,
  name          text NOT NULL,
  email         text NOT NULL UNIQUE,
  role          app_role NOT NULL,
  status        text NOT NULL CHECK (status IN ('pending','active','disabled')),
  must_change_password boolean NOT NULL DEFAULT false,
  last_login_at timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX users_role_idx ON public.users (role);
```

Notes: no surrogate key (the GoTrue UUID is the single identity). No hard delete — disabling sets
`status='disabled'` (Constitution III, soft-delete). Email is duplicated here for fast app queries and
audit attribution; set atomically with GoTrue at creation. Traceability: AUTH-001/002, PRD §14.

### State transitions (`status`)

```
            invite path (Path A)
(none) ───────────────────────────▶ pending
                                       │ first successful sign-in (BFF, idempotent WHERE status='pending')
                                       ▼
(none) ─── temp-password (Path B) ──▶ active ◀───────────────┐
                                       │  admin disables       │ admin re-enables
                                       ▼                       │
                                    disabled ──────────────────┘
```

- `pending`: created via invite; cannot use the app except the set-password flow. → `active` on first
  sign-in.
- `active`: normal access (subject to `must_change_password`, which forces the change flow first).
- `disabled`: blocked at `verifySession()` on the next request (SC-007); GoTrue ban also blocks new
  sign-ins/refresh. Reversible by an admin (→ `active`).
- **Guard (FR-016)**: a transition that disables the last `active` admin, or moves the last `active`
  admin off `admin`, is rejected (HTTP 409) before any write.

`must_change_password`: `true` on temp-password creation (and on the seeded admin); set `false` after a
successful password change.

---

## Entity: Audit Log (`public.audit_logs`)

Immutable, append-only record of a critical action (AUTH-005, FR-017–FR-020a, PRD §14).

| Field | Type | Rules |
|---|---|---|
| `id` | `uuid` PK | DEFAULT `gen_random_uuid()` |
| `entity_type` | `text` | required; e.g. `'user'` |
| `entity_id` | `uuid` | required; the affected record |
| `action` | `text` | required; typed `AuditAction` in app code (001: `user.create`, `user.role_change`, `user.status_change`, `user.invite_sent`) |
| `previous_value` | `jsonb` | nullable (null on create) — snapshot of relevant fields only |
| `new_value` | `jsonb` | nullable (null on delete/disable) — snapshot of relevant fields only |
| `actor_user_id` | `uuid` | required; FK `REFERENCES public.users(id)` — who performed it |
| `created_at` | `timestamptz` | NOT NULL DEFAULT `now()` |
| `reason` | `text` | optional note (FR-017) |

```sql
CREATE TABLE public.audit_logs (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  entity_type    text NOT NULL,
  entity_id      uuid NOT NULL,
  action         text NOT NULL,
  previous_value jsonb,
  new_value      jsonb,
  actor_user_id  uuid NOT NULL REFERENCES public.users(id),
  created_at     timestamptz NOT NULL DEFAULT now(),
  reason         text
);
CREATE INDEX audit_logs_entity_idx  ON public.audit_logs (entity_type, entity_id);
CREATE INDEX audit_logs_actor_idx   ON public.audit_logs (actor_user_id);
CREATE INDEX audit_logs_created_idx ON public.audit_logs (created_at DESC);

-- Append-only hardening (defense-in-depth; app writes no UPDATE/DELETE path):
REVOKE UPDATE, DELETE ON public.audit_logs FROM PUBLIC;
```

Append-only: no `updated_at`/`deleted_at`; the app exposes only insert + select; the `REVOKE` is cheap
hardening (a restricted DB role is deferred, YAGNI). Written inside the **same transaction** as the
mutation it records (SC-005). Read access is Admin-only (FR-020a). Traceability: AUTH-005, PRD §14/§21.5,
STACK §5.4, Constitution III/IV.

### Audit entries emitted by this feature

| `action` | Trigger | `previous_value` | `new_value` |
|---|---|---|---|
| `user.create` | admin creates a user (either path) | `null` | `{ name, email, role, status }` |
| `user.invite_sent` | admin sends/resends an invite | `null` | `{ email }` |
| `user.role_change` | admin changes a user's role | `{ role: old }` | `{ role: new }` |
| `user.status_change` | admin enables/disables a user | `{ status: old }` | `{ status: new }` |

---

## Relationships

```
auth.users (GoTrue, not modeled)
   │ 1:1 (shared UUID)
   ▼
public.users ──1:N── public.audit_logs   (actor_user_id → users.id; entity_id may also reference a user)
```

- `users.id = auth.users.id` (1:1). Deleting the GoTrue user cascades the profile (but the app never
  hard-deletes; it disables).
- Each audit row is attributed to one actor (`actor_user_id`). For user-management actions, `entity_type
  = 'user'` and `entity_id` is the affected user's id.

---

## Validation rules (enforced at the BFF boundary via shared Zod schemas)

- **Create user**: `name` 2–120; `email` valid + unique (DB UNIQUE + pre-check); `role` ∈ 7 MVP roles
  (reject `customer_viewer`); onboarding = `invite` **or** `temp_password` (+ `tempPassword` ≥ 8 chars).
- **Update role**: `role` ∈ 7 MVP roles; subject to last-admin guard.
- **Update status**: `status` ∈ {`active`,`disabled`} (admins do not set `pending` directly); optional
  `reason`; subject to last-admin guard.
- **Audit**: never updated or deleted via the app.

Schemas live in `packages/shared/src/schemas/` and are imported by both the BFF Route Handlers and the
React forms (DRY). See [contracts/bff-endpoints.md](./contracts/bff-endpoints.md).
