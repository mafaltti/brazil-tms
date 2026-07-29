# Contract: Permission Catalog additions (feature 002)

**Feature**: 002-master-data-config | **Source of truth in code**:
`packages/shared/src/auth/permissions.ts` | **Derived from**: PRD §18, Clarification Q1 (2026-05-29),
spec FR-025/FR-027/FR-029.

Feature 002 **extends** the single, code-defined catalog established by feature 001 (no DB permissions table —
Constitution V). It adds **two** new `PermissionKey`s and **reuses** the existing Admin-only `delete_archive`
for archive. The 001 matrix comment ("features add enforcement without editing this catalog") assumed the
declared trip-centric keys would suffice; §18 has no master-data create/edit row and no existing key matches
the clarified role split, so two new keys are the minimum correct extension (R2).

## New keys

```ts
export type PermissionKey =
  // … existing 001 keys …
  | 'manage_commercial_data'   // 002: create/edit/read customers, locations, lanes
  | 'manage_fleet_data';       // 002: create/edit/read drivers, vehicles, trailers, carriers
```

Add to `ALL_PERMISSIONS` and to `ROLE_PERMISSIONS` (Admin already gets both via `ADMIN_PERMISSIONS`):
- `operations_manager`: add `manage_commercial_data`, `manage_fleet_data`.
- `fleet_coordinator`: add `manage_fleet_data`.

## Matrix (002 rows; ✓ = granted)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec. Viewer | Owner |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `manage_commercial_data` | ✓ | ✓ | | | | | | **002** |
| `manage_fleet_data` | ✓ | ✓ | | | ✓ | | | **002** |
| `delete_archive` *(reused; archive of master data)* | ✓ | | | | | | | **001/002/003/005** |

Mapping rationale (Clarification Q1): commercial data → Admin + Ops Manager; fleet data → Admin + Ops Manager +
Fleet Coordinator; **archive** of any record → Admin only (PRD §18 "Delete / archive records").

## Read policy

Reads of a master-data area require that area's **manage** permission (no separate `view_master_data` key — R2).
Downstream features (006 dispatch, 008 billing, …) read the same tables through **their own** permissions/
services (SC-011); they do not depend on a 002 read permission.

## Invariants (testable — Vitest, extend `permissions.test.ts`)

- `can('admin', 'manage_commercial_data') === true` and `can('admin', 'manage_fleet_data') === true`.
- `can('operations_manager', 'manage_commercial_data') === true` and `can('operations_manager',
  'manage_fleet_data') === true`.
- `can('fleet_coordinator', 'manage_fleet_data') === true` **and** `can('fleet_coordinator',
  'manage_commercial_data') === false`.
- `manage_commercial_data` and `manage_fleet_data` are granted to **no other** role (dispatcher, control_tower,
  finance, executive_viewer all `false`).
- `can(role, 'delete_archive')` is `true` **only** for `admin` (unchanged from 001).
- Admin remains a superset of every key (matrix invariant preserved after the additions).
