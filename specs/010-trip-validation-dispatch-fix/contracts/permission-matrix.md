# Permission Matrix — 010 Trip Validation Action & Dispatch Queue Hardening

**No new permission key.** This slice reuses two keys already declared and enforced in earlier slices. (Permissions are a static code catalog — `packages/shared/src/auth/permissions.ts` — there is no DB permissions table.)

## Keys used (all pre-existing)

| Action | Key (existing) | First declared/enforced | Holders |
|--------|----------------|-------------------------|---------|
| **Validate** a trip (`received → validated`) and the `validation_error → received` correction — via `POST /api/trips/:id/status` | **`update_trip_status`** | slice 007 (execution milestones) | Admin, Operations Manager, Dispatcher, Control Tower |
| **Assign / reassign** a trip — via `POST /api/trips/:id/assignment` (incl. the new `NOT_ASSIGNABLE` rejection) | **`assign_resources`** | slice 006 | Admin, Operations Manager, Dispatcher, Fleet Coordinator |
| **Read** the dispatch board / trip list (narrowed queue) | **`view_all_trips`** | slice 005 | all seven internal roles |

## Rationale

- **Validate reuses `update_trip_status`** (R4): it already gates the status-transition route that performs the edge, and its holders (Admin / Ops Manager / Dispatcher / Control Tower) are a **superset** of the PRD §12.1 transition owner "System validation / Operations". Adding a `validate_trip` key would violate Constitution I/IV (new key needs justification) for no benefit. Mirrors 006's reuse-and-first-enforce of `assign_resources`.
- **Least privilege (§21.4)** is preserved: no key is broadened. A role **without** `update_trip_status` (Fleet Coordinator, Finance, Executive Viewer) cannot validate — the `ValidateAction` is not offered to them and a direct `POST /status` is refused `403` by the existing `requirePermission`.

## Authorization behavior to verify (e2e)

| Role | See/Use Validate on a `received` trip? | Assign a `validated` trip? |
|------|----------------------------------------|----------------------------|
| Admin | ✅ | ✅ |
| Operations Manager | ✅ | ✅ |
| Dispatcher | ✅ | ✅ |
| Control Tower | ✅ | ❌ (no `assign_resources`) — read-only on dispatch |
| Fleet Coordinator | ❌ (no `update_trip_status`) | ✅ |
| Finance | ❌ | ❌ |
| Executive Viewer | ❌ | ❌ |

- Holder of `update_trip_status` → validate `2xx`; non-holder → `403` (and the action is not rendered).
- The change adds **no** new audited action type: validate writes the existing `trip.status_change` audit record (the §21.5 list already covers status transitions).
