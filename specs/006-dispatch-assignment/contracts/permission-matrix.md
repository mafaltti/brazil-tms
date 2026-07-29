# Permission Matrix — Dispatch Assignment (006)

## No new permission key — first enforcement of `assign_resources`

006 adds **no** permission key. `assign_resources` **already exists** in the 001 code-defined catalog (`packages/shared/src/auth/permissions.ts`), declared and granted but **never enforced**. Slice 006 is the **first slice to enforce `assign_resources`** — exactly the pattern 004 used for `import_trips` and 005 used for `view_all_trips`.

All assignment writes (assign / reassign / unassign / confirm / dry-run check) are gated on `assign_resources` in the BFF via `requirePermission(ctx, "assign_resources")` (`apps/web/lib/auth/require-auth.ts`). The trip **reads** that surface assignment data (board, detail, dashboard) stay on `view_all_trips` (005). No DB permissions table; RLS deferred (Constitution IV).

## Catalog grant (verbatim from 001, unchanged)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `assign_resources` | ✓ | ✓ | ✓ | — | ✓ | — | — |
| `view_all_trips` (reads) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Source: `ROLE_PERMISSIONS` in `packages/shared/src/auth/permissions.ts`. **Assign authority** = Admin, Operations Manager, Dispatcher, Fleet Coordinator. Control Tower, Finance, and Executive Viewer can **view** assignments but cannot create/change them.

## Override authority (DISP-008 — resolved by clarification)

Any holder of `assign_resources` may **override a WARN** finding by supplying a non-empty `overrideReason` (persisted on the assignment + audited). **No role may override a BLOCK** (BLOCK is an absolute hard-stop). This uses **only** the existing `assign_resources` key — no second permission concept, no new key (Constitution V). A future senior-only BLOCK-override would be a deliberate permission-catalog change, out of scope here.

## Endpoint → permission

| Endpoint | Method | Permission |
|---|---|---|
| `/api/trips/:id/assignment` | POST (assign/reassign), DELETE (unassign) | `assign_resources` |
| `/api/trips/:id/assignment/confirm` | POST | `assign_resources` |
| `/api/trips/:id/assignment/check` | POST (dry-run) | `assign_resources` |
| `/api/trips` , `/api/trips/:id` , `/api/dashboard/summary` | GET (assignment fields) | `view_all_trips` (005) |

## Test focus (Constitution / STACK §3.13)

`assign_resources` enforcement is a required permission-check test: an `assign_resources` holder (e.g. Dispatcher) can assign (`200`); a non-holder (e.g. Finance / Control Tower) is refused (`403`) server-side even with a valid body; a non-holder can still read assignment data via `view_all_trips` (`200`). Verified in Playwright `e2e/` plus shared unit tests over `ROLE_PERMISSIONS`/`can`.
