# Permission Matrix — Execution Events, Exceptions, SLA Risk & Alerts (007)

## No new permission key — first enforcement of three pre-declared 001 keys

007 adds **no** permission key. `update_trip_status`, `create_exceptions`, and `resolve_exceptions` **already exist** in the 001 code-defined catalog (`packages/shared/src/auth/permissions.ts`), declared and granted but **never enforced**. Slice 007 is the **first slice to enforce** all three — exactly the pattern 004 used for `import_trips`, 005 for `view_all_trips`, and 006 for `assign_resources`. Per-customer SLA-rule administration **reuses `manage_commercial_data`** (added **and already enforced** by 002, since SLA rules are per-customer commercial config); **no `configure_sla` key exists or is added** (R0/R12). All **reads** (timeline, exceptions, SLA indicators, alerts, reason codes, SLA-rule listing) stay on `view_all_trips` (005).

All execution-tracking writes are gated in the BFF via `requirePermission(ctx, <key>)` (`apps/web/lib/auth/require-auth.ts`):

- **milestone / status / free-form note** → `update_trip_status`
- **exception create** → `create_exceptions`
- **exception update / transition (Monitoring/Resolved/Cancelled)** → `resolve_exceptions`
- **per-customer SLA-rule create / update** → `manage_commercial_data` (reused, already enforced by 002)

No DB permissions table; RLS deferred (Constitution IV). The service-role key stays server-only; the Supabase gateway is never exposed.

## Catalog grant (verbatim from 001, unchanged)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `update_trip_status` | ✓ | ✓ | ✓ | ✓ | — | — | — |
| `create_exceptions` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `resolve_exceptions` | ✓ | ✓ | ✓ | ✓ | ✓ | — | — |
| `manage_commercial_data` (SLA rules) | ✓ | ✓ | — | — | — | — | — |
| `view_all_trips` (reads) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Source: `ROLE_PERMISSIONS` in `packages/shared/src/auth/permissions.ts`.

- **Milestone / status authority** (`update_trip_status`) = Admin, Operations Manager, Dispatcher, Control Tower.
- **Exception authority** (`create_exceptions` + `resolve_exceptions`) = Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator (all five hold **both** keys in the catalog). The spec's Session-2026-05-31 note describes Fleet Coordinator's resolve as "Limited" (◐); the code-defined catalog has **no partial/◐ concept** — membership in `ROLE_PERMISSIONS` is binary, and `◐` counts as **granted** (the 006 matrix convention), so Fleet Coordinator can both create and resolve. Any genuinely narrower Fleet-Coordinator resolve scope would be a deliberate permission-catalog change, out of scope here.
- **SLA-rule authority** (`manage_commercial_data`) = Admin, Operations Manager only — same grant 002 enforces for commercial master data.
- Finance and Executive Viewer can **view** everything (timeline, exceptions, SLA, alerts) via `view_all_trips` but hold **none** of the 007 write keys; Fleet Coordinator can view + work exceptions but cannot record milestones (`update_trip_status` not granted) or edit SLA rules.

## Reads & alert acknowledgement stay on `view_all_trips`

All 007 read surfaces — the interactive timeline, the Trip-Detail exception list, the Exception Management queue, SLA indicators / the "At risk" view, the alert list/counts, the active reason-code list, and SLA-rule listing — are gated on `view_all_trips` (no new read key). **Alert acknowledgement** (`POST /api/alerts/:id/acknowledge`, state → `acknowledged`) is **also** gated on `view_all_trips`, not a write key: acknowledgement is operator triage of one's own view (the alert row records `acknowledged_by_user_id` / `acknowledged_at`), not a domain mutation, and SC-009 lists only the four write keys (`update_trip_status` / `create_exceptions` / `resolve_exceptions` / `manage_commercial_data`). No `acknowledge_alerts` / `configure_sla` key exists or is added (Constitution V; R12).

## Endpoint → permission

| Endpoint | Method | Permission | Service / read |
|---|---|---|---|
| `/api/trips/:id/status` (or extended transition route) | POST | `update_trip_status` | `transitionTripStatus` (milestone, incl. optional `loading`/`unloading`) + `recomputeTripSla` |
| `/api/trips/:id/events` (free-form note) | POST | `update_trip_status` | `addTripNote` (`note` event, no status change) |
| `/api/trips/:id/exceptions` | POST | `create_exceptions` | `createException` (+ synchronous high-severity alert + `recomputeTripSla`) |
| `/api/exceptions/:id` | PATCH | `resolve_exceptions` | `updateException` (owner / severity / responsible-party / description) |
| `/api/exceptions/:id/transition` | POST | `resolve_exceptions` | `transitionException` (Open↔Monitoring; →Resolved/Cancelled; closure notes + `resolved_at`) |
| `/api/exceptions` | GET | `view_all_trips` | Exception Management list (filters: severity, customer, lane, reason, owner, age) |
| `/api/reason-codes` | GET | `view_all_trips` | active reason-code list (create form) |
| `/api/customer-sla-rules` | GET / POST | GET `view_all_trips` · POST `manage_commercial_data` | list / create |
| `/api/customer-sla-rules/:id` | PATCH | `manage_commercial_data` | update |
| `/api/alerts` | GET | `view_all_trips` | active/acknowledged alert list + counts |
| `/api/alerts/:id/acknowledge` | POST | `view_all_trips` | acknowledge (state → `acknowledged`) |
| `/api/trips` , `/api/trips/:id` , `/api/dashboard/summary` | GET | `view_all_trips` (005) | **extended** reads — `slaStatus`/`slaReasons`, exception/alert arrays, dashboard at-risk / active-exceptions / on-time fills (R14) |

The worker SLA sweep (`workers/jobs/sla-sweep/`) and synchronous high-severity-exception alert generation run server-side with the service-role connection — they are not user-facing endpoints and carry no permission key (background authority is server-side per Constitution III / STACK §6).

## Test focus (Constitution / STACK §3.13)

First-enforcement of all three keys is a required permission-check test set, mirroring 004/005/006:

- An `update_trip_status` holder (e.g. Dispatcher or Control Tower) can record a milestone / note (`200`); a non-holder (e.g. Fleet Coordinator, Finance, Executive Viewer) is refused (`403`) server-side even with a valid body, and the trip is unchanged.
- A `create_exceptions` holder can open an exception (`200`); a non-holder (Finance / Executive Viewer) is refused (`403`).
- A `resolve_exceptions` holder can transition / resolve an exception (`200`); a non-holder is refused (`403`).
- A `manage_commercial_data` holder (Admin / Operations Manager) can create/update a customer SLA rule (`200`); a non-holder (Dispatcher / Control Tower / Fleet Coordinator, despite holding exception keys) is refused (`403`).
- A non-holder of every write key can still **read** the timeline, exceptions, SLA state, and alerts and **acknowledge** an alert via `view_all_trips` (`200`).

Verified in Playwright `e2e/` (route-level 401/403/400/404/409 per the route-HTTP-tests-in-e2e convention) plus shared Vitest over `ROLE_PERMISSIONS` / `can`.
