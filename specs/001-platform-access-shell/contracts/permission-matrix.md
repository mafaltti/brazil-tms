# Contract: Permission Catalog (static role→permission map)

**Feature**: 001-platform-access-shell | **Source of truth in code**:
`packages/shared/src/auth/permissions.ts` | **Derived from**: PRD §18 matrix, FR-006–FR-011, FR-020a.

This is a **fixed, code-defined** catalog (no DB table — FR-008, Constitution V/PRINCIPLES). It is the
single source of truth consumed by both the BFF (`requireAuth()` + `can()`) and the app-shell nav
(FR-010, FR-011). Feature 001 **enforces** only `manage_users` and `view_audit_log`; all other keys are
**declared now** (zero-cost string literals, mapped per §18) so features 002–009 add enforcement points
without editing this catalog.

## Types (sketch)

```ts
export const Role = {
  Admin: 'admin', OperationsManager: 'operations_manager', Dispatcher: 'dispatcher',
  ControlTower: 'control_tower', FleetCoordinator: 'fleet_coordinator',
  Finance: 'finance', ExecutiveViewer: 'executive_viewer',
} as const;
export type Role = typeof Role[keyof typeof Role];
// 'customer_viewer' is a reserved DB enum value, NOT a member of assignable Role (FR-007).

export type PermissionKey =
  // enforced in 001:
  | 'manage_users' | 'view_audit_log'
  // declared now, enforced by later features (002–009):
  | 'view_all_trips' | 'import_trips' | 'edit_trip_plan' | 'assign_resources'
  | 'update_trip_status' | 'cancel_trip' | 'mark_completed' | 'mark_billing_ready'
  | 'resolve_dispute' | 'delete_archive' | 'create_exceptions' | 'resolve_exceptions'
  | 'upload_documents' | 'verify_documents' | 'edit_rates' | 'export_billing';

export function can(role: Role, permission: PermissionKey): boolean; // pure: ROLE_PERMISSIONS[role].has(permission)
```

## Matrix (✓ = granted; ◐ = granted but "Limited" — constraint owned by the feature that owns the action)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec. Viewer | Owner feature |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `manage_users` | ✓ | | | | | | | **001** |
| `view_audit_log` | ✓ | | | | | | | **001** |
| `view_all_trips` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | 005 |
| `import_trips` | ✓ | ✓ | | | | | | 004 |
| `edit_trip_plan` | ✓ | ✓ | ◐ | ◐ | | | | 005 |
| `assign_resources` | ✓ | ✓ | ✓ | | ✓ | | | 006 |
| `update_trip_status` | ✓ | ✓ | ✓ | ✓ | | | | 007 |
| `cancel_trip` | ✓ | ✓ | ◐ | | | | | 005 |
| `mark_completed` | ✓ | ✓ | | ✓ | | | | 008 |
| `mark_billing_ready` | ✓ | | | | | ✓ | | 008 |
| `resolve_dispute` | ✓ | ✓ | | | | ✓ | | 008 |
| `delete_archive` | ✓ | | | | | | | 003/005 |
| `create_exceptions` | ✓ | ✓ | ✓ | ✓ | ✓ | | | 007 |
| `resolve_exceptions` | ✓ | ✓ | ✓ | ✓ | ◐ | | | 007 |
| `upload_documents` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | | 008 |
| `verify_documents` | ✓ | ✓ | | | | ✓ | | 008 |
| `edit_rates` | ✓ | | | | | ✓ | | 008 |
| `export_billing` | ✓ | | | | | ✓ | | 008 |

Notes:
- **`view_audit_log`** is not in the PRD §18 matrix; it is added by this feature (FR-020a) and is
  Admin-only. Broader operational audit views are owned by feature 009.
- **"View own customer trips"** (§18) is the tenant-scoped Customer Viewer capability — **post-MVP**
  (AUTH-004, deferred); not represented as an internal permission key here.
- **◐ "Limited"** keys are granted in the catalog; the precise constraint (e.g. which fields a Dispatcher
  may edit) is finalized by the owning feature (spec Assumptions).
- **Collapse-identical-roles (YAGNI)**: no two MVP roles share an identical set, so none are collapsed
  (research §8).
- **Forward note (feature 002)**: the "declared now… without editing this catalog" intent holds for the
  trip-centric keys above, but §18 has no master-data *create/edit* row, so feature 002 **adds** two keys to
  this catalog — `manage_commercial_data` (Admin, Ops Mgr) and `manage_fleet_data` (Admin, Ops Mgr, Fleet
  Coord) — and reuses Admin-only `delete_archive` for master-data archive
  (see `specs/002-master-data-config/contracts/permission-matrix.md`).

## Invariants (testable — Vitest)

- `can('admin', k)` is `true` for every key (Admin is a superset).
- `can(role, 'manage_users')` and `can(role,'view_audit_log')` are `true` **only** for `admin`.
- `can('executive_viewer', k)` is `true` only for `view_all_trips`.
- `customer_viewer` is never an assignable `Role` (rejected by Zod before reaching `can`).
- The catalog matches this table for all 7 roles × all keys.
