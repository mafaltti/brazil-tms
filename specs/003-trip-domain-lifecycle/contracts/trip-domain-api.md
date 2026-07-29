# Contract: Trip Domain / Service API (feature 003) — the reuse contract

**Feature**: 003-trip-domain-lifecycle | **Source of truth in code**:
`packages/shared/src/domain/trip-status.ts` (status set, transitions, projection, critical fields) and
`apps/web/lib/trips/*` (service functions). **Derived from**: spec FR-008..FR-023, clarification 2026-05-29.

This is the **single shared definition** that slices 004–009 MUST consume rather than redefine (FR-023). It is
not an HTTP contract — it is the in-process domain API. Later slices' route handlers call these functions; they
do not re-implement the status machine, the projection, or the audit semantics.

## Status set + transition table (`packages/shared/src/domain/trip-status.ts`)

```typescript
export const TRIP_STATUSES = [
  "received","validation_error","validated","assigned","confirmed",
  "at_origin","loading","loaded","in_transit","at_destination","unloading","unloaded",
  "completed","billing_pending","billing_ready","billed","cancelled","disputed",
] as const;
export type TripStatus = (typeof TRIP_STATUSES)[number];

// The ONE legal-transition table (clarification 2026-05-29: cancellable through at_destination).
export const TRANSITIONS: Record<TripStatus, readonly TripStatus[]> = {
  received:         ["validated","validation_error","cancelled"],
  validation_error: ["received"],
  validated:        ["assigned","cancelled"],
  assigned:         ["confirmed","validated","cancelled"],     // validated = unassign
  confirmed:        ["at_origin","cancelled"],
  at_origin:        ["loading","in_transit","cancelled"],
  loading:          ["loaded","cancelled"],
  loaded:           ["in_transit","cancelled"],
  in_transit:       ["at_destination","cancelled"],
  at_destination:   ["unloading","unloaded","cancelled"],
  unloading:        ["unloaded"],
  unloaded:         ["completed"],
  completed:        ["billing_pending","disputed"],
  billing_pending:  ["billing_ready","disputed"],
  billing_ready:    ["billed","disputed"],
  billed:           ["disputed"],
  disputed:         [/* dynamic: disputed_from_status */ "cancelled"],
  cancelled:        [],
};

export function canTransition(from: TripStatus, to: TripStatus): boolean;
// disputed → its disputed_from_status is allowed in addition to 'cancelled' (resolved from the trip row).

export type BillingStatus = "billing_pending" | "billing_ready" | "billed" | "disputed" | null;
export function billingStatus(s: TripStatus): BillingStatus; // projection (R3); no stored column.

export const TRIP_CRITICAL_FIELDS: readonly string[];  // labeled documented default (R9, FR-016)
```

## Service functions (`apps/web/lib/trips/*`) — called by later slices' handlers

Each runs in **one DB transaction** and writes the row change + (for transitions) a `trip_event` + an
`audit_logs` row. All take an `actorUserId` and assume the caller has already enforced
`requirePermission(ctx, 'manage_trips')` (or a finer key a later slice adds).

```typescript
// create from an imported/seeded plan; captures immutable original_plan; status starts 'received'
createTrip(input: CreateTripInput, actorUserId: string): Promise<TripDetail>      // audit: trip.create

// status-guarded, atomic transition (R7); writes trip_events(status_change) + audit
transitionTripStatus(
  tripId: string,
  args: { toStatus: TripStatus; expectedFromStatus: TripStatus;
          eventTimestamp?: Date; source?: TripEventSource; notes?: string },
  actorUserId: string,
): Promise<TripDetail>
// throws Conflict('ILLEGAL_TRANSITION') | Conflict('STALE_TRANSITION') | Conflict('NOT_FOUND')

// accepted customer update to live planned_* fields; original_plan untouched; per-field audit
updateTripPlan(
  tripId: string,
  changes: Partial<TripPlanFields>,
  args: { authorizedReview?: boolean },     // required when current_status is past 'confirmed' (FR-005)
  actorUserId: string,
): Promise<TripDetail>                       // audit: trip.plan_update | throws Conflict('REVIEW_REQUIRED')

// cancellation with the five required inputs; validates reason/billing-impact vs cancellation_options
cancelTrip(
  tripId: string,
  input: { reasonCode: string; cancellationTimestamp?: Date;
           responsibleParty: ResponsibleParty; billingImpact: string },
  actorUserId: string,
): Promise<TripDetail>                       // audit: trip.cancel
// throws Conflict('CANCELLATION_NOT_CONFIGURED') | Conflict('NOT_CANCELLABLE') | ZodError(400)
```

## Reuse rules (FR-023, Constitution III)

- Slices 004–009 **import** `TRIP_STATUSES`, `TRANSITIONS`, `canTransition`, `billingStatus`,
  `TRIP_CRITICAL_FIELDS` from `@brazil-tms/shared` and **call** the service functions above. They MUST NOT
  declare a parallel status set, a second billing state machine, or a private transition table.
- New statuses or event types are added by migration + the shared table in the same PR (PR review enforces it).
- New audit actions extend the shared `AuditAction` union; assignment-change auditing is added by 006.
