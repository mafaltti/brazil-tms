# Phase 1 — Data Model: Dispatch Assignment and Conflict Warnings

**Feature**: 006-dispatch-assignment · **Date**: 2026-05-31 · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

> Authoritative DDL is the committed `drizzle-kit generate` output under `packages/db/migrations/`. The block below is the design sketch the schema file (`packages/db/schema/trip-assignments.ts`) produces. **One new table; no new enum; no `trips` column change; no new permission key/package/worker.**

---

## 1. New table — `trip_assignments` (PRD §14.1)

```sql
CREATE TABLE "trip_assignments" (
  "id"                          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id"                     uuid NOT NULL REFERENCES "trips"("id"),
  "driver_id"                   uuid REFERENCES "drivers"("id"),
  "vehicle_id"                  uuid REFERENCES "vehicles"("id"),
  "trailer_id"                  uuid REFERENCES "trailers"("id"),
  "carrier_id"                  uuid REFERENCES "carriers"("id"),
  "assigned_by_user_id"         uuid NOT NULL REFERENCES "users"("id"),
  "assigned_at"                 timestamptz NOT NULL DEFAULT now(),
  "confirmed_by_user_id"        uuid REFERENCES "users"("id"),
  "confirmed_at"                timestamptz,
  "notes"                       text,
  "override_reason"             text,
  "is_current"                  boolean NOT NULL DEFAULT true,
  "superseded_by_assignment_id" uuid REFERENCES "trip_assignments"("id"),
  "superseded_at"               timestamptz,
  "created_at"                  timestamptz NOT NULL DEFAULT now(),
  "updated_at"                  timestamptz NOT NULL DEFAULT now()
);

-- at most one CURRENT assignment per trip (R2; mirrors trips_customer_external_id_uq partial-unique pattern)
CREATE UNIQUE INDEX "trip_assignments_trip_active_uq"
  ON "trip_assignments" ("trip_id") WHERE "is_current";

-- history lookups by trip
CREATE INDEX "trip_assignments_trip_idx" ON "trip_assignments" ("trip_id");

-- conflict-lookup (schedule overlap) — current assignments per resource only
CREATE INDEX "trip_assignments_driver_active_idx"  ON "trip_assignments" ("driver_id")  WHERE "is_current";
CREATE INDEX "trip_assignments_vehicle_active_idx" ON "trip_assignments" ("vehicle_id") WHERE "is_current";
CREATE INDEX "trip_assignments_trailer_active_idx" ON "trip_assignments" ("trailer_id") WHERE "is_current";
CREATE INDEX "trip_assignments_carrier_active_idx" ON "trip_assignments" ("carrier_id") WHERE "is_current";
```

**Drizzle (`packages/db/schema/trip-assignments.ts`)** — mirrors `trips.ts`/`drivers.ts` style (inline FKs, `(table) => [ … ]` index array, `index`/`uniqueIndex`, `.defaultNow()`):

```ts
export const tripAssignments = pgTable(
  "trip_assignments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    driverId: uuid("driver_id").references(() => drivers.id),
    vehicleId: uuid("vehicle_id").references(() => vehicles.id),
    trailerId: uuid("trailer_id").references(() => trailers.id),
    carrierId: uuid("carrier_id").references(() => carriers.id),
    assignedByUserId: uuid("assigned_by_user_id").notNull().references(() => users.id),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).notNull().defaultNow(),
    confirmedByUserId: uuid("confirmed_by_user_id").references(() => users.id),
    confirmedAt: timestamp("confirmed_at", { withTimezone: true }),
    notes: text("notes"),
    overrideReason: text("override_reason"),
    isCurrent: boolean("is_current").notNull().default(true),
    supersededByAssignmentId: uuid("superseded_by_assignment_id"),  // self-FK added via relations / ALTER in migration
    supersededAt: timestamp("superseded_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("trip_assignments_trip_active_uq").on(table.tripId).where(sql`${table.isCurrent}`),
    index("trip_assignments_trip_idx").on(table.tripId),
    index("trip_assignments_driver_active_idx").on(table.driverId).where(sql`${table.isCurrent}`),
    index("trip_assignments_vehicle_active_idx").on(table.vehicleId).where(sql`${table.isCurrent}`),
    index("trip_assignments_trailer_active_idx").on(table.trailerId).where(sql`${table.isCurrent}`),
    index("trip_assignments_carrier_active_idx").on(table.carrierId).where(sql`${table.isCurrent}`),
  ],
);
```

**Rules / invariants**
- **At most one current assignment per trip** — DB partial unique index (R2); a race loses with `409`.
- **Mutable current row, retained history** (R4) — confirm updates `confirmed_*`; reassign updates the prior row (`is_current=false`, `superseded_by_assignment_id`, `superseded_at`) and inserts a new current row, in one tx. **No hard delete; no REVOKE** (rows are updated by design; audit + retained superseded rows give reconstructability — Constitution III).
- **Minimum-required set** (R9, enforced in the service, not a CHECK — it depends on the trip's ownership): driver + vehicle always; carrier when subcontracted; trailer optional.
- Self-FK `superseded_by_assignment_id` is added as an `ALTER TABLE … ADD CONSTRAINT` in the migration (drizzle emits forward self-references this way), matching the cross-table FK-activation convention.

**No `trips` change** (R3): the current assignment is read via `trip_assignments WHERE trip_id=? AND is_current` (one index hit). No `current_assignment_id` column.

---

## 2. Reused tables (read-only — not redefined)

| Table | Used for | Key columns |
|-------|----------|-------------|
| `trips` (003) | assignment target; status transitions via 003's service | `current_status`, `planned_vehicle_type`, `planned_pickup_window_start/_end`, `planned_delivery_window_start/_end`, `customer_id`, `lane_id` |
| `drivers` (002) | candidate + eligibility | `status` (`resource_status`), `ownership_type`, `carrier_id`, `license_expiry`, `archived_at` |
| `vehicles` (002) | candidate + eligibility | `status`, `vehicle_type`, `ownership_type`, `carrier_id`, `document_expiry`, `archived_at` |
| `trailers` (002) | candidate + eligibility | `status`, `ownership_type`, `carrier_id`, `document_expiry`, `archived_at` |
| `carriers` (002) | candidate + eligibility | `contract_status`, `documentation_status`, `archived_at` |
| `trip_events` (003) | append-only `status_change` row for assign/unassign/confirm | `event_type` (reuse `status_change`), `status_before/after`, `source`, `actor_user_id` |
| `audit_logs` (001) | append-only assignment audit | `entity_type`/`entity_id`, `action`, `previous_value`/`new_value`, `actor_user_id`, `reason` |
| `users` (001) | `assigned_by`/`confirmed_by` | `id` |

No new enums: `resource_status`, `vehicle_type`, `trailer_type`, `ownership_type`, `trip_status`, `trip_event_type` all already exist and cover 006.

---

## 3. Domain logic (shared, pure)

### 3.1 Assignment eligibility evaluator — `packages/shared/src/domain/assignment-eligibility.ts` (NEW)

```ts
export type AssignmentCheck =
  | "schedule_conflict" | "resource_status" | "vehicle_type" | "carrier_eligibility" | "documentation";
export type Severity = "block" | "warn";
export interface Finding {
  check: AssignmentCheck;
  resourceKind: "driver" | "vehicle" | "trailer" | "carrier";
  resourceId: string;
  severity: Severity;
  code: string;          // e.g. "driver_blocked", "doc_expired", "type_mismatch", "schedule_overlap"
}

export interface EligibilityContext {
  trip: { plannedVehicleType: VehicleType | null;
          windowStart: Date | null; windowEnd: Date | null; };
  driver?:  { id: string; status: ResourceStatus; licenseExpiry: string | null };
  vehicle?: { id: string; status: ResourceStatus; vehicleType: VehicleType; documentExpiry: string | null };
  trailer?: { id: string; status: ResourceStatus; documentExpiry: string | null };
  carrier?: { id: string; contractStatus: string; documentationStatus: string; archived: boolean };
  overlaps: { resourceKind: "driver"|"vehicle"|"trailer"; resourceId: string }[]; // current assignments whose trip window intersects
  // "resource availability" (Dispatch Board) = per-resource current-assignment load: whether the resource is already on an overlapping / near-term CURRENT assignment — derived from this same `overlaps` set the conflict check uses (no separate availability source).
  now: Date;
}

export function evaluateAssignmentEligibility(
  ctx: EligibilityContext,
  policy: AssignmentPolicy = DEFAULT_ASSIGNMENT_POLICY,
): Finding[];
```

Checks (R6, §19.2): schedule overlap (from `ctx.overlaps`), resource status (`documentExpiryState` not used here — status enum), vehicle-type exact match vs `trip.plannedVehicleType` (skip if null), carrier eligibility (`contract_status`/`documentation_status`/archived), documentation (`documentExpiryState(licenseExpiry|documentExpiry, now)` → `expired`/`expiring`/`ok`; carrier `documentation_status`). Severity from `policy`.

### 3.2 Policy config — confirmed company default (R7)

```ts
export interface AssignmentPolicy { severity: Record<string /* findingCode */, Severity>; }

export const DEFAULT_ASSIGNMENT_POLICY: AssignmentPolicy = {
  severity: {
    driver_inactive: "block", driver_blocked: "block", driver_unavailable: "warn",
    vehicle_inactive: "block", vehicle_blocked: "block", vehicle_maintenance: "block", vehicle_unavailable: "warn",
    trailer_inactive: "block", trailer_blocked: "block", trailer_unavailable: "warn",
    doc_expired: "block", doc_missing: "warn", doc_expiring: "warn",
    carrier_inactive: "block", carrier_contract_expired: "block", carrier_doc_expired: "block",
    carrier_doc_pending: "warn",
    type_mismatch: "warn",
    schedule_overlap: "warn",
  },
};
// resolveSeverity(code, customerPolicy?) — per-customer override seam; no per-customer storage built (R7, YAGNI)
```

### 3.3 Required-resource rule (R9)

`ownership` here is **derived from the assigned resources' `ownership_type`** (drivers/vehicles), not from any `trips` field — a trip has no ownership column. The set is "subcontracted" when the chosen driver/vehicle are `subcontracted` (⇒ carrier required), otherwise "owned".

```ts
export function requiredResourcesFor(ownership: "owned" | "subcontracted"): {
  driver: true; vehicle: true; carrier: boolean; // carrier required iff the assigned resources are subcontracted; trailer optional
};
export const ASSIGNMENT_TURNAROUND_BUFFER_MINUTES = 0; // configurable default (open item; spec Blocked #6)
```

### 3.4 `TRIP_CRITICAL_FIELDS` extension — `packages/shared/src/domain/trip-status.ts` (EXTEND)

Append the assignment reference fields (the file comment reserves this for 006): `"assignedDriverId"`, `"assignedVehicleId"`, `"assignedTrailerId"`, `"assignedCarrierId"`.

### 3.5 Audit actions — `packages/shared/src/audit/actions.ts` (EXTEND)

Add to the `AuditAction` union and `ALL_AUDIT_ACTIONS`: `"trip.assign"`, `"trip.reassign"`, `"trip.unassign"`, `"trip.confirm"`.

---

## 4. Service functions — `packages/db/src/trips/trip-assignments.ts` (NEW)

All mirror `transitionTripStatus`/`cancelTrip` (pre-tx legality check → one `db.transaction` → guarded update + row(s) + `trip_events`(where status changes) + `writeAudit` → return `loadTripDetail(tx, id)`); all errors are `throw new Conflict(CODE, "pt-BR message")`.

```ts
export async function assignTrip(tripId, input: AssignTripInput, actorUserId): Promise<TripDetailView>;
//   validates min-required set (INCOMPLETE_ASSIGNMENT); gathers ctx; evaluate → BLOCK ⇒ ASSIGNMENT_BLOCKED;
//   WARN && !overrideReason ⇒ OVERRIDE_REQUIRED; else: if current assignment exists ⇒ supersede + new row (reassign,
//   no status change); else insert + guarded validated→assigned + status_change event; writeAudit trip.assign/trip.reassign.
export async function unassignTrip(tripId, input, actorUserId): Promise<TripDetailView>;
//   supersede current row; guarded assigned→validated; status_change event; writeAudit trip.unassign.
export async function confirmTripAssignment(tripId, input, actorUserId): Promise<TripDetailView>;
//   re-run evaluate ⇒ unresolved BLOCK ⇒ ASSIGNMENT_BLOCKED; else update current row (confirmed_by/at);
//   guarded assigned→confirmed; status_change event; writeAudit trip.confirm.
export async function checkAssignment(tripId, input): Promise<Finding[]>;
//   read-only: gather ctx + evaluate; no write (powers the dry-run endpoint).
export async function gatherEligibilityContext(tx_or_db, tripId, candidate): Promise<EligibilityContext>;
//   loads trip window/type, the candidate resources, and overlapping CURRENT assignments (joined to active trips).
```

Conflict codes: `INCOMPLETE_ASSIGNMENT`, `ASSIGNMENT_BLOCKED`, `OVERRIDE_REQUIRED`, `STALE_TRANSITION`, `ILLEGAL_TRANSITION`, `NOT_FOUND`. `OVERRIDE_REQUIRED`/`ASSIGNMENT_BLOCKED` carry the `findings` payload.

---

## 5. Read-model extensions — `packages/db/src/trips/trips-read.ts` (EXTEND)

- **`queryTripBoard` / `TripBoardRow`**: LEFT JOIN `trip_assignments` (alias, `is_current`) + `drivers`/`vehicles`/`carriers`; add `isAssigned: boolean`, `assignedDriverName`, `assignedVehiclePlate`, `assignedCarrierName`. New filters: `assigned` (`true`/`false` ⇒ current assignment exists / not), `driverId`, `vehicleId`, `carrierId`.
- **`getTripDetailView` / `TripDetailView`**: add `currentAssignment` (resources + names + notes + override + assigned/confirmed by/at) and `assignmentHistory` (superseded rows, newest-first).
- **`queryDashboardMetrics` / `DashboardSummary`**: replace `unassignedTrips: null` with the **count of active trips having no current assignment** (`isActiveStatus` AND no `trip_assignments WHERE is_current`).
- New: `exportTripRows` inherits the assignment columns automatically (shares the board select).
- **`getTripFilterOptions` / `TripFilterOptions`** (EXTEND): in addition to the existing 005 filter facets, return the **active fleet lists** — active drivers, vehicles, trailers, and carriers as `{ id, label }` — to serve as the resource picker/filter data source for the Trip Detail assignment panel, the Dispatch Board, and the Control Tower assignment filters. These are **loaded server-side** via the page loaders and passed to the client as `resourceOptions`; the pickers do **not** call 002's `/api/master-data/*` fleet endpoints (those are gated `manage_fleet_data`, which the `assign_resources` Dispatcher role does not hold and would `403`). This extension is the data source that resolves that gap.

Join uses the established `alias(...)` pattern (`origin_loc`/`dest_loc`). New named exports added to `packages/db/src/index.ts`; `tripAssignments` added to `packages/db/schema/index.ts`.

---

## 6. State & lifecycle (reused, not redefined)

```
validated --assign-->        assigned        (trip_events status_change; trip.assign)
assigned  --reassign-->      assigned        (no status change; supersede + new row; trip.reassign)
assigned  --unassign-->      validated       (status_change; trip.unassign)
assigned  --confirm-->       confirmed        (re-check; status_change; trip.confirm)
confirmed --reassign-->      confirmed        (no status change; supersede + new row; trip.reassign)
```

All status edges are existing `TRANSITIONS` entries; 006 only triggers them. Reassignment is a pure assignment-row operation (no edge).

---

## 7. Migration `packages/db/migrations/0005_*.sql` (R14)

`CREATE TABLE trip_assignments` + FK constraints (incl. self-FK via `ALTER TABLE … ADD CONSTRAINT`) + the partial unique index + the four conflict-lookup partial indexes. **No** `CREATE TYPE`, **no** REVOKE, **no** `ALTER TABLE trips`. Generated by `drizzle-kit generate` from the edited schema barrel; `meta/_journal.json` updated by the tool.
