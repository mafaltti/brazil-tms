# Contract: Permission Catalog additions (feature 003)

**Feature**: 003-trip-domain-lifecycle | **Source of truth in code**:
`packages/shared/src/auth/permissions.ts` | **Derived from**: PRD §18, spec FR (authz behavior), Constitution IV/V.

Feature 003 **extends** the single, code-defined catalog from features 001/002 (no DB permissions table —
Constitution V). It adds exactly **one** new `PermissionKey` covering trip-domain access this slice needs
(create/transition/plan-update/cancel via the service layer, and the read-only inspector endpoints). Finer-
grained operational keys (e.g., `transition_trip_status`, `assign_trip`, `cancel_trip` split out for
Dispatcher / Control Tower) are intentionally deferred to the slices that own those workflows (005/006/007);
introducing them now would be speculative (Constitution I, ≥3 rule).

## New key

```typescript
export type PermissionKey =
  // … existing 001/002 keys …
  | 'manage_trips';   // 003: create/transition/plan-update/cancel trips + read trip inspector
```

## Matrix (003 row; ✓ = granted)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec. Viewer | Owner |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `manage_trips` | ✓ | ✓ | | | | | | **003** |

Rationale for grants: trips are the operations system-of-record; **Admin** and **Operations Manager** own the
durable model in this foundational slice. Dispatcher / Control Tower / Finance gain their workflow-specific
trip permissions in later slices (006 dispatch, 005/007 execution, 008 billing), which will extend this matrix.

## Invariants (testable — Vitest, extend `permissions.test.ts`)

- `can('admin', 'manage_trips') === true`.
- `can('operations_manager', 'manage_trips') === true`.
- `can('dispatcher', 'manage_trips') === false` and `can('finance', 'manage_trips') === false`
  (their trip permissions arrive in later slices).
- `can('customer_viewer', 'manage_trips') === false`.
