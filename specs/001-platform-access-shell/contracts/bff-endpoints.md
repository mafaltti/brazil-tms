# Contract: BFF Endpoints (feature 001)

**Feature**: 001-platform-access-shell | **Spec**: [../spec.md](../spec.md) ·
**Data model**: [../data-model.md](../data-model.md)

The interface this feature exposes is the **BFF** — Next.js App Router Route Handlers under
`apps/web/app/api/*`. The browser never talks to Postgres/PostgREST directly (FR-023); all data access
goes through these handlers. Every handler validates input with shared Zod schemas, enforces auth via
`requireAuth()` + `can()`, and audits critical mutations.

**Conventions**
- **AuthZ**: `401` = no valid/active session; `403` = authenticated but lacks the permission;
  `409` = business-rule conflict (e.g. last-admin guard, duplicate email); `400` = Zod validation error;
  `422` reserved for semantic validation if needed.
- **AuthN context**: handlers call `requireAuth()` (server-only DAL, `getUser()`-based) → `{ userId,
  role, status, user }`. A `must_change_password` user is restricted to the change-password endpoint.
- **Bodies**: JSON. Timestamps returned as UTC ISO 8601 strings (formatted to `America/Sao_Paulo` in UI).
- All responses for forbidden/denied actions cause **no state change** (SC-003).

---

## Auth

### `POST /api/auth/sign-in`
- **Permission**: public.
- **Body**: `{ email: string, password: string }` (Zod `loginSchema`).
- **Behavior**: `auth.signInWithPassword` via the cookie-bound server client; sets HttpOnly session
  cookies. On first successful sign-in of a `pending` user → promote to `active`, stamp `last_login_at`.
- **Responses**: `200 { redirectTo }` (→ `/auth/set-password` if `must_change_password`, else `/`);
  `401` invalid credentials (generic, non-revealing — FR-004/edge case); `403` user `disabled`.
- Traceability: AUTH-001, FR-001, FR-002, FR-005, US1.

### `POST /api/auth/sign-out`
- **Permission**: authenticated.
- **Behavior**: `auth.signOut()` (revokes refresh token) + clears cookies.
- **Responses**: `204`.
- Traceability: FR-003, US1.

### `POST /api/auth/forgot-password`
- **Permission**: public.
- **Body**: `{ email: string }`.
- **Behavior**: triggers GoTrue password recovery email (requires SMTP). **Always** returns the same
  neutral response regardless of whether the email exists (no account disclosure).
- **Responses**: `200 { ok: true }` (neutral).
- Traceability: FR-004, US1 (acceptance 4–5).

### `POST /api/auth/change-password`
- **Permission**: authenticated (also the only route allowed while `must_change_password=true`).
- **Body**: `{ newPassword: string (min 8) }`.
- **Behavior**: sets the new password; clears `users.must_change_password=false` (and `app_metadata`).
- **Responses**: `200 { ok: true }`; `400` weak password.
- Traceability: FR-013a (forced change), US3.

---

## Admin — Users & Roles (permission `manage_users`, Admin-only)

### `GET /api/admin/users`
- **Permission**: `manage_users`.
- **Query**: optional `?status=`, `?role=`, `?q=` (search), pagination params.
- **Responses**: `200 { users: UserProfile[] }`; `401`; `403`.
- Traceability: FR-012, FR-014, US3.

### `POST /api/admin/users`
- **Permission**: `manage_users`.
- **Body** (`createUserSchema`):
  ```jsonc
  {
    "name": "string (2–120)",
    "email": "string (email, unique)",
    "role": "one of 7 MVP roles (customer_viewer rejected)",
    "onboarding": { "method": "invite" }
      // OR
      // { "method": "temp_password", "tempPassword": "string (min 8)" }
  }
  ```
- **Behavior**: create GoTrue user first (`inviteUserByEmail` for `invite` → profile `status='pending'`;
  `createUser({email_confirm:true, app_metadata:{must_change_password:true}})` for `temp_password` →
  `status='active', must_change_password=true`), then insert `public.users` (Drizzle, same UUID); on
  profile-insert failure compensate with `admin.deleteUser`. Writes audit `user.create` (+ `user.invite_sent`
  for invite) in the same transaction.
- **Responses**: `201 { user }`; `400` validation (incl. `customer_viewer`); `409` duplicate email.
- Traceability: FR-007, FR-013, FR-013a, FR-015, FR-017/FR-018, US3, US4.

### `PATCH /api/admin/users/:id`
- **Permission**: `manage_users`.
- **Body**: `{ role? }` (`updateUserRoleSchema`) and/or `{ status?, reason? }` (`updateUserStatusSchema`).
- **Behavior**: in one transaction — enforce **last-admin guard** (`SELECT … FOR UPDATE`, reject 409 if
  it would remove the last active admin), apply the change, write audit `user.role_change` /
  `user.status_change`. For `status='disabled'` also call GoTrue `ban_duration`; for re-enable set `'none'`.
- **Responses**: `200 { user }`; `400`; `403`; `409 LAST_ADMIN_GUARD`.
- Traceability: FR-013, FR-016, FR-017/018, US3 (acceptance 2,6), US4.

### `POST /api/admin/users/:id/invite`
- **Permission**: `manage_users`.
- **Behavior**: resend the invite/set-password email for a `pending` user (handles expired invites).
  Writes audit `user.invite_sent`.
- **Responses**: `200 { ok: true }`; `409` if user is not `pending`.
- Traceability: FR-013a (invite path), research §6.

---

## Admin — Audit (permission `view_audit_log`, Admin-only)

### `GET /api/admin/audit-logs`
- **Permission**: `view_audit_log` (Admin-only — FR-020a).
- **Query**: optional `?entity_type=`, `?entity_id=`, `?action=`, `?actor=`, date range, pagination.
- **Responses**: `200 { entries: AuditLog[] }` (ordered `created_at DESC`); `401`; `403`.
- **No write/update/delete endpoints exist for audit logs** (append-only, FR-019).
- Traceability: AUTH-005, FR-017, FR-019, FR-020a, US4 (acceptance 1–4).

---

## Shared types (returned shapes)

```ts
type UserProfile = {
  id: string; name: string; email: string;
  role: Role;                       // 7 MVP roles
  status: 'pending' | 'active' | 'disabled';
  mustChangePassword: boolean;
  lastLoginAt: string | null;       // UTC ISO
  createdAt: string; updatedAt: string;
};

type AuditLog = {
  id: string; entityType: string; entityId: string;
  action: AuditAction;              // 'user.create' | 'user.role_change' | 'user.status_change' | 'user.invite_sent'
  previousValue: Record<string, unknown> | null;
  newValue: Record<string, unknown> | null;
  actorUserId: string; createdAt: string; reason: string | null;
};
```
