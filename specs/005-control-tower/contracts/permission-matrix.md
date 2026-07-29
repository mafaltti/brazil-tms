# Contract: Permission Catalog (feature 005)

**Feature**: 005-control-tower | **Source of truth**: `packages/shared/src/auth/permissions.ts`

005 adds **no new permission key**. The `view_all_trips` key **already exists** in the 001 catalog (declared and granted to all 7 internal roles — Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator, Finance, Executive Viewer) but is **not yet enforced** anywhere: today the trip read endpoints are gated on `manage_trips`, so only Admin and Ops Manager can see trips. Slice 005 is the **first slice to enforce `view_all_trips`** (PRD §18: "View all trips" = all internal roles), and **re-gates** `GET /api/trips` and `GET /api/trips/:id` from `manage_trips` → `view_all_trips`. Operational-field **editing** (`PATCH /api/trips/:id/plan`) uses the existing **`manage_trips`** (003; Admin + Ops Manager — the MVP default; the "Limited" Dispatcher/Control-Tower scope is BLOCKED, PRD §18). This honors Constitution I (no new key without need — YAGNI), mirroring how 004 first-enforced `import_trips`.

> This refines spec FR-034, which named a "new `view_trips`" key before the catalog was inspected. `view_all_trips` is the semantically correct existing key; adding `view_trips` would duplicate it (Constitution V). The spec text is reconciled to `view_all_trips`.

## No new key

```typescript
// packages/shared/src/auth/permissions.ts — UNCHANGED
export type PermissionKey =
  // … existing 001/002/003/004 keys …
  | 'view_all_trips'  // 001 catalog; FIRST ENFORCED in 005: read Control Tower list / Trip Detail / dashboard / CSV export
  | 'manage_trips';   // 003: trip create/transition/plan-update/cancel + (005) operational-field edit
```

## Matrix (✓ = granted; the bracketed slice marks where the key is first **enforced**)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec. Viewer | Owner |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `view_all_trips` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | **005 (enforced)** |
| `manage_trips` | ✓ | ✓ | | | | | | 003 |

Rationale for grants: every internal role needs to **see and filter** trips in the operating board (PRD §18 "View all trips" is *Yes* for all 7 internal roles), so all read surfaces (list, detail, dashboard, export) require `view_all_trips`. **Editing** live planned fields stays Admin + Ops Manager (`manage_trips`) for MVP; Dispatcher/Control-Tower "Limited" edit is undefined in the PRD and BLOCKED. Customer Viewer and customer-scoped row visibility are post-MVP (Decision §30) and not granted here. All enforcement is in the BFF (`requirePermission(ctx, …)`); RLS deferred; the Supabase gateway is never exposed.

## Invariants (testable — Vitest, extend `permissions.test.ts`)

- `can('admin', 'view_all_trips') === true`
- `can('operations_manager', 'view_all_trips') === true`
- `can('dispatcher', 'view_all_trips') === true`
- `can('control_tower', 'view_all_trips') === true`
- `can('fleet_coordinator', 'view_all_trips') === true`
- `can('finance', 'view_all_trips') === true`
- `can('executive_viewer', 'view_all_trips') === true`
- `can('dispatcher', 'manage_trips') === false` and `can('finance', 'manage_trips') === false` (editing plan fields is Admin/Ops only in MVP; the "Limited" scope is BLOCKED — PRD §18)

Every 005 read endpoint (`GET /api/trips`, `GET /api/trips/:id`, `GET /api/trips/export`, `GET /api/dashboard/summary`) returns **403** for any session lacking `view_all_trips` and **401** with no session. `PATCH /api/trips/:id/plan` returns **403** for any role lacking `manage_trips`.
