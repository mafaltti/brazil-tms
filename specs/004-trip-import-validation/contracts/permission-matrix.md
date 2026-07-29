# Contract: Permission Catalog (feature 004)

**Feature**: 004-trip-import-validation | **Source of truth**: `packages/shared/src/auth/permissions.ts`

004 adds **no new permission key**. The `import_trips` key **already exists** in the 001 catalog (granted to `admin` and
`operations_manager`); slice 004 is simply the **first slice to enforce it** (PRD §18: "Import trips" is restricted to
Admin and Ops Manager). Trip *inspection/management* continues to use `manage_trips` (003); **import** uses
`import_trips`. This honors Constitution I (no new key without need — YAGNI).

## No new key

```typescript
// packages/shared/src/auth/permissions.ts — UNCHANGED
export type PermissionKey =
  // … existing 001/002/003 keys …
  | 'import_trips'    // 001 catalog; FIRST ENFORCED in 004: upload/preview/confirm imports + manage import config
  | 'manage_trips';   // 003: trip create/transition/plan-update/cancel + trip inspector
```

## Matrix (✓ = granted; the bracketed slice marks where the key is first **enforced**)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec. Viewer | Owner |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `import_trips` | ✓ | ✓ | | | | | | **004 (enforced)** |
| `manage_trips` | ✓ | ✓ | | | | | | 003 |

Rationale for grants: importing customer trip plans (upload, resolve errors, map unknown locations, configure templates
and status mappings, confirm) is an Operations responsibility — Admin and Ops Manager only (PRD §18). All enforcement is
in the BFF (`requirePermission(ctx, 'import_trips')`); RLS deferred; the Supabase gateway is never exposed.

## Invariants (testable — Vitest, extend `permissions.test.ts`)

- `can('admin', 'import_trips') === true`
- `can('operations_manager', 'import_trips') === true`
- `can('dispatcher', 'import_trips') === false`
- `can('control_tower', 'import_trips') === false`
- `can('finance', 'import_trips') === false`
- `can('executive_viewer', 'import_trips') === false`

Every import endpoint (upload, list, batch status, rows, confirm, error-report, resolve-location, template CRUD,
status-mapping upsert) returns **403** for any role lacking `import_trips`, and **401** with no session.
