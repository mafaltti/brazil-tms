import { and, eq, inArray, isNotNull, lt, gt, ne, or, type SQL } from "drizzle-orm";
import { db, type DB } from "../client";
import {
  carriers,
  drivers,
  tripAssignments,
  tripEvents,
  trailers,
  trips,
  vehicles,
} from "../../schema";
import {
  ACTIVE_TRIP_STATUSES,
  DEFAULT_ASSIGNMENT_POLICY,
  canTransition,
  evaluateAssignmentEligibility,
  requiredResourcesFor,
  type AssignTripInput,
  type CheckAssignmentInput,
  type ConfirmAssignmentInput,
  type EligibilityContext,
  type Finding,
  type OwnershipType,
  type ResourceStatus,
  type VehicleType,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";
import { recomputeTripSla } from "./sla";
import { loadTripDetail, type TripDetail } from "./trip-dto";

/**
 * Feature 006 — Dispatch assignment service layer (data-model.md §4; research §5/§6/§8/§9; contract
 * contracts/bff-endpoints.md §1–§4). The dispatch WRITE surface over the 003 trip domain: it drives
 * the EXISTING status machine (`received→assigned` / `assigned→confirmed` / `assigned→received`; slice
 * 015 retargeted assign/unassign off the removed `validated` state onto `received`), never redefines it,
 * and binds a driver/vehicle/trailer/carrier to a trip through `trip_assignments`.
 *
 * Every mutation mirrors `transitionTripStatus` / `cancelTrip` EXACTLY: pre-tx legality/eligibility
 * (so a refused action changes NO state, SC-003) → one `db.transaction` doing the status-guarded
 * `UPDATE trips ... WHERE current_status = expected` (0 rows ⇒ `STALE_TRANSITION`), the assignment
 * row(s), a `trip_events` `status_change` row (only when status actually changes — reassignment does
 * not), and a single resource-rich `writeAudit(...)`, then returns `loadTripDetail(tx, id)`. All
 * conflicts throw `Conflict(CODE, "pt-BR message")`; `ASSIGNMENT_BLOCKED` / `OVERRIDE_REQUIRED` carry
 * the `Finding[]` in `Conflict.details` so the BFF can return the conflicting findings.
 *
 * Conflict/eligibility authority is server-side and lives in the PURE shared evaluator
 * (`evaluateAssignmentEligibility`); this layer only GATHERS the context and ENFORCES the outcome
 * (`block` ⇒ refuse, `warn` ⇒ require an override reason — Constitution III).
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Anything that can run a `select` — the live `db` or a transaction handle (`tx`). */
type Querier = Pick<DB, "select">;

/** The candidate resource ids being considered for an assignment (any subset may be provided). */
interface Candidate {
  driverId?: string;
  vehicleId?: string;
  trailerId?: string;
  carrierId?: string;
}

/**
 * Find the resources flagged `block` / `warn` in a finding set. `block` is absolute (never
 * overridable); `warn` may proceed only with a recorded `overrideReason` (R7/R9).
 */
function partitionFindings(findings: Finding[]): { blocks: Finding[]; warns: Finding[] } {
  return {
    blocks: findings.filter((f) => f.severity === "block"),
    warns: findings.filter((f) => f.severity === "warn"),
  };
}

/**
 * Derive the assignment's ownership from the chosen driver/vehicle `ownership_type` — a trip has no
 * ownership column (data-model.md §3.3). The set is `subcontracted` (⇒ carrier required) when EITHER
 * the chosen driver or vehicle is subcontracted, otherwise `owned`.
 */
function deriveOwnership(
  driverOwnership: OwnershipType | undefined,
  vehicleOwnership: OwnershipType | undefined,
): "owned" | "subcontracted" {
  return driverOwnership === "subcontracted" || vehicleOwnership === "subcontracted"
    ? "subcontracted"
    : "owned";
}

// ---------------------------------------------------------------------------
// Eligibility context gathering (data-model.md §4 · research §6)
// ---------------------------------------------------------------------------

/**
 * Load the {@link EligibilityContext} the pure evaluator needs: the trip's planned vehicle type +
 * window (pickup-start → delivery-end), each PROVIDED candidate resource (status / type / expiry /
 * ownership / carrier / archived), and the schedule overlaps — OTHER current assignments of the same
 * driver/vehicle/trailer whose trip window intersects this trip's window and whose trip is still
 * active (not cancelled/terminal). Also returns the raw resource ownerships so the service can derive
 * the minimum-required set without a second query.
 *
 * Overlap detection uses a half-open interval intersection (`a.start < b.end AND b.start < a.end`)
 * with this trip's [windowStart, windowEnd]; a null window on either side is treated as
 * non-overlapping (no schedule conflict can be asserted without both windows). Turnaround buffer is
 * `ASSIGNMENT_TURNAROUND_BUFFER_MINUTES` (0 by default) — folded in by the evaluator's policy, not
 * here, so this stays a pure interval test.
 */
export async function gatherEligibilityContext(
  executor: Querier,
  tripId: string,
  candidate: Candidate,
): Promise<{
  context: EligibilityContext;
  ownership: { driver?: OwnershipType; vehicle?: OwnershipType };
}> {
  const tripRows = await executor
    .select({
      plannedVehicleType: trips.plannedVehicleType,
      windowStart: trips.plannedPickupWindowStart,
      windowEnd: trips.plannedDeliveryWindowEnd,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const trip = tripRows[0];
  if (!trip) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  const windowStart = trip.windowStart;
  const windowEnd = trip.windowEnd;

  // --- Candidate resources (only the provided ones are loaded + evaluated). ---
  const ownership: { driver?: OwnershipType; vehicle?: OwnershipType } = {};

  let driverCtx: EligibilityContext["driver"];
  if (candidate.driverId) {
    const rows = await executor
      .select({
        id: drivers.id,
        status: drivers.status,
        licenseExpiry: drivers.licenseExpiry,
        ownershipType: drivers.ownershipType,
        archivedAt: drivers.archivedAt,
      })
      .from(drivers)
      .where(eq(drivers.id, candidate.driverId))
      .limit(1);
    const d = rows[0];
    if (d) {
      driverCtx = {
        id: d.id,
        status: d.status as ResourceStatus,
        licenseExpiry: d.licenseExpiry,
        archived: d.archivedAt != null,
      };
      ownership.driver = d.ownershipType as OwnershipType;
    }
  }

  let vehicleCtx: EligibilityContext["vehicle"];
  if (candidate.vehicleId) {
    const rows = await executor
      .select({
        id: vehicles.id,
        status: vehicles.status,
        vehicleType: vehicles.vehicleType,
        documentExpiry: vehicles.documentExpiry,
        ownershipType: vehicles.ownershipType,
        archivedAt: vehicles.archivedAt,
      })
      .from(vehicles)
      .where(eq(vehicles.id, candidate.vehicleId))
      .limit(1);
    const v = rows[0];
    if (v) {
      vehicleCtx = {
        id: v.id,
        status: v.status as ResourceStatus,
        vehicleType: v.vehicleType as VehicleType,
        documentExpiry: v.documentExpiry,
        archived: v.archivedAt != null,
      };
      ownership.vehicle = v.ownershipType as OwnershipType;
    }
  }

  let trailerCtx: EligibilityContext["trailer"];
  if (candidate.trailerId) {
    const rows = await executor
      .select({
        id: trailers.id,
        status: trailers.status,
        documentExpiry: trailers.documentExpiry,
        archivedAt: trailers.archivedAt,
      })
      .from(trailers)
      .where(eq(trailers.id, candidate.trailerId))
      .limit(1);
    const t = rows[0];
    if (t) {
      trailerCtx = {
        id: t.id,
        status: t.status as ResourceStatus,
        documentExpiry: t.documentExpiry,
        archived: t.archivedAt != null,
      };
    }
  }

  let carrierCtx: EligibilityContext["carrier"];
  if (candidate.carrierId) {
    const rows = await executor
      .select({
        id: carriers.id,
        contractStatus: carriers.contractStatus,
        documentationStatus: carriers.documentationStatus,
        archivedAt: carriers.archivedAt,
      })
      .from(carriers)
      .where(eq(carriers.id, candidate.carrierId))
      .limit(1);
    const c = rows[0];
    if (c) {
      carrierCtx = {
        id: c.id,
        contractStatus: c.contractStatus,
        documentationStatus: c.documentationStatus,
        archived: c.archivedAt != null,
      };
    }
  }

  // --- Schedule overlaps: OTHER current assignments of the same physical resource whose trip's
  //     planned window intersects this trip's window AND whose trip is still active. ---
  const overlaps: EligibilityContext["overlaps"] = [];
  if (windowStart && windowEnd) {
    const resourceFilters: SQL[] = [];
    if (candidate.driverId) resourceFilters.push(eq(tripAssignments.driverId, candidate.driverId));
    if (candidate.vehicleId)
      resourceFilters.push(eq(tripAssignments.vehicleId, candidate.vehicleId));
    if (candidate.trailerId)
      resourceFilters.push(eq(tripAssignments.trailerId, candidate.trailerId));

    if (resourceFilters.length > 0) {
      const resourceMatch = or(...resourceFilters);

      const overlapRows = await executor
        .select({
          driverId: tripAssignments.driverId,
          vehicleId: tripAssignments.vehicleId,
          trailerId: tripAssignments.trailerId,
        })
        .from(tripAssignments)
        .innerJoin(trips, eq(tripAssignments.tripId, trips.id))
        .where(
          and(
            eq(tripAssignments.isCurrent, true),
            ne(tripAssignments.tripId, tripId),
            resourceMatch,
            // The other trip must still be live (cancelled/terminal trips never conflict).
            inArray(trips.currentStatus, [...ACTIVE_TRIP_STATUSES]),
            // Half-open interval intersection: other.start < this.end AND this.start < other.end.
            isNotNull(trips.plannedPickupWindowStart),
            isNotNull(trips.plannedDeliveryWindowEnd),
            lt(trips.plannedPickupWindowStart, windowEnd),
            gt(trips.plannedDeliveryWindowEnd, windowStart),
          ),
        );

      // One `overlaps` entry per overlapping CURRENT assignment, per matching resource kind.
      for (const r of overlapRows) {
        if (candidate.driverId && r.driverId === candidate.driverId) {
          overlaps.push({ resourceKind: "driver", resourceId: candidate.driverId });
        }
        if (candidate.vehicleId && r.vehicleId === candidate.vehicleId) {
          overlaps.push({ resourceKind: "vehicle", resourceId: candidate.vehicleId });
        }
        if (candidate.trailerId && r.trailerId === candidate.trailerId) {
          overlaps.push({ resourceKind: "trailer", resourceId: candidate.trailerId });
        }
      }
    }
  }

  const context: EligibilityContext = {
    trip: {
      plannedVehicleType: trip.plannedVehicleType as VehicleType | null,
      windowStart,
      windowEnd,
    },
    driver: driverCtx,
    vehicle: vehicleCtx,
    trailer: trailerCtx,
    carrier: carrierCtx,
    overlaps,
    now: new Date(),
  };

  return { context, ownership };
}

// ---------------------------------------------------------------------------
// checkAssignment — read-only dry-run (T039 · contract §4)
// ---------------------------------------------------------------------------

/**
 * Read-only eligibility dry-run (data-model.md §4; contract §4): gather the context for the candidate
 * resources + run the pure evaluator, returning every {@link Finding}. Writes NOTHING — powers the
 * inline warnings in the assignment panel / Dispatch Board so the UI DISPLAYS, but never owns,
 * conflict authority. Throws `NOT_FOUND` if the trip is missing.
 */
export async function checkAssignment(
  tripId: string,
  input: CheckAssignmentInput,
): Promise<Finding[]> {
  const { context } = await gatherEligibilityContext(db, tripId, {
    driverId: input.driverId,
    vehicleId: input.vehicleId,
    trailerId: input.trailerId,
    carrierId: input.carrierId,
  });
  return evaluateAssignmentEligibility(context, DEFAULT_ASSIGNMENT_POLICY);
}

// ---------------------------------------------------------------------------
// assignTrip — received → assigned (T027 · contract §1, assign path)
// ---------------------------------------------------------------------------

/**
 * Assign driver + vehicle (+ optional trailer/carrier) to a `received` trip, transitioning it to
 * `assigned` (data-model.md §4; research §5/§9; contract §1; slice 015 retargeted the source from the
 * removed `validated` state to `received`). Mirrors `transitionTripStatus`:
 *
 *   1. enforce the minimum-required set (`requiredResourcesFor` by derived ownership) →
 *      `INCOMPLETE_ASSIGNMENT`;
 *   2. gather context + run the evaluator: any `block` ⇒ `ASSIGNMENT_BLOCKED` (findings attached, not
 *      overridable); any `warn` without `input.overrideReason` ⇒ `OVERRIDE_REQUIRED` (findings
 *      attached); a `warn` WITH a reason proceeds (the reason is persisted + audited);
 *   3. one transaction: guarded `UPDATE trips ... WHERE current_status='received'` (0 rows ⇒
 *      `STALE_TRANSITION`), INSERT the `is_current` assignment row, INSERT a `status_change`
 *      `trip_events` row, `writeAudit("trip.assign", ... reason)`.
 *
 * Returns the freshly-written detail + the overridden WARN findings (empty when clean).
 */
export async function assignTrip(
  tripId: string,
  input: AssignTripInput,
  actorUserId: string,
): Promise<{ trip: TripDetail; findings: Finding[] }> {
  const candidate: Candidate = {
    driverId: input.driverId,
    vehicleId: input.vehicleId,
    trailerId: input.trailerId,
    carrierId: input.carrierId,
  };

  const { context, ownership } = await gatherEligibilityContext(db, tripId, candidate);

  // Minimum-required set (R9): driver+vehicle always; carrier when the chosen resources are
  // subcontracted. Derived from the resources' ownership_type, not from any trips column.
  const required = requiredResourcesFor(deriveOwnership(ownership.driver, ownership.vehicle));
  if (!input.driverId || !input.vehicleId || (required.carrier && !input.carrierId)) {
    throw new Conflict(
      "INCOMPLETE_ASSIGNMENT",
      "Atribuição incompleta: motorista e veículo são obrigatórios; transportadora é obrigatória para recursos subcontratados.",
    );
  }

  const findings = evaluateAssignmentEligibility(context, DEFAULT_ASSIGNMENT_POLICY);
  const { blocks, warns } = partitionFindings(findings);
  if (blocks.length > 0) {
    throw new Conflict(
      "ASSIGNMENT_BLOCKED",
      "Atribuição bloqueada por restrições de elegibilidade.",
      blocks,
    );
  }
  if (warns.length > 0 && !input.overrideReason) {
    throw new Conflict(
      "OVERRIDE_REQUIRED",
      "Há avisos de elegibilidade; informe o motivo da exceção para prosseguir.",
      warns,
    );
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    // Optimistic-concurrency guard: only assign a trip still in `received` (slice 015; was `validated`).
    const updated = await tx
      .update(trips)
      .set({ currentStatus: "assigned", updatedAt: now })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, "received")))
      .returning();
    if (updated.length === 0) {
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    await tx.insert(tripAssignments).values({
      tripId,
      driverId: input.driverId,
      vehicleId: input.vehicleId,
      trailerId: input.trailerId ?? null,
      carrierId: input.carrierId ?? null,
      assignedByUserId: actorUserId,
      notes: input.notes ?? null,
      overrideReason: input.overrideReason ?? null,
      isCurrent: true,
    });

    await tx.insert(tripEvents).values({
      tripId,
      eventType: "status_change",
      statusBefore: "received",
      statusAfter: "assigned",
      source: "operator_manual",
      actorUserId,
      notes: input.notes ?? null,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.assign",
      previousValue: { currentStatus: "received" },
      newValue: {
        currentStatus: "assigned",
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        trailerId: input.trailerId ?? null,
        carrierId: input.carrierId ?? null,
      },
      actorUserId,
      reason: input.overrideReason ?? null,
    });

    // Feature 007 — assignment/confirmation changes clear/fire the missing_assignment /
    // missed_confirmation SLA reasons immediately (read-only inputs to the evaluator, FR-017/FR-019).
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return { trip: detail, findings: warns };
  });
}

// ---------------------------------------------------------------------------
// reassignTrip — supersede the current assignment, no status change (T048 · contract §1, reassign)
// ---------------------------------------------------------------------------

/**
 * Re-assign an already-`assigned`/`confirmed` trip to different resources (data-model.md §4/§6;
 * research §5 note; contract §1 reassign path). Reassignment is a PURE assignment-row operation: the
 * trip's `current_status` is UNCHANGED and NO `trip_events` row is written (FR-008). It re-runs the
 * evaluator (BLOCK ⇒ `ASSIGNMENT_BLOCKED`; WARN without `overrideReason` ⇒ `OVERRIDE_REQUIRED`), then
 * in one transaction inserts the new `is_current` row and supersedes the prior one (`is_current=false`,
 * `superseded_by_assignment_id`, `superseded_at`) so EXACTLY ONE current row remains and history is
 * retained (never deleted). Audited as `trip.reassign` (reason = the override reason when present).
 *
 * Guard: a missing current assignment ⇒ `STALE_TRANSITION` (nothing to supersede; the caller likely
 * lost a race to an unassign).
 */
export async function reassignTrip(
  tripId: string,
  input: AssignTripInput,
  actorUserId: string,
): Promise<{ trip: TripDetail; findings: Finding[] }> {
  // Reassign is legal ONLY while the trip is `assigned` or `confirmed` (data-model §6 / contract §1).
  // Reject any other expected status up front: the route sends EVERY non-`received` expectedFromStatus
  // here, and the in-tx status guard below only verifies the trip is STILL in `expectedFromStatus` —
  // so without this an in-flight/terminal status (e.g. in_transit) whose expectedFromStatus matched
  // would slip through. This is the authoritative gate that keeps reassignment off executing trips.
  if (input.expectedFromStatus !== "assigned" && input.expectedFromStatus !== "confirmed") {
    throw new Conflict(
      "ILLEGAL_TRANSITION",
      "Reatribuição só é permitida em viagem atribuída ou confirmada.",
    );
  }

  const candidate: Candidate = {
    driverId: input.driverId,
    vehicleId: input.vehicleId,
    trailerId: input.trailerId,
    carrierId: input.carrierId,
  };

  const { context, ownership } = await gatherEligibilityContext(db, tripId, candidate);

  const required = requiredResourcesFor(deriveOwnership(ownership.driver, ownership.vehicle));
  if (!input.driverId || !input.vehicleId || (required.carrier && !input.carrierId)) {
    throw new Conflict(
      "INCOMPLETE_ASSIGNMENT",
      "Atribuição incompleta: motorista e veículo são obrigatórios; transportadora é obrigatória para recursos subcontratados.",
    );
  }

  const findings = evaluateAssignmentEligibility(context, DEFAULT_ASSIGNMENT_POLICY);
  const { blocks, warns } = partitionFindings(findings);
  if (blocks.length > 0) {
    throw new Conflict(
      "ASSIGNMENT_BLOCKED",
      "Atribuição bloqueada por restrições de elegibilidade.",
      blocks,
    );
  }
  if (warns.length > 0 && !input.overrideReason) {
    throw new Conflict(
      "OVERRIDE_REQUIRED",
      "Há avisos de elegibilidade; informe o motivo da exceção para prosseguir.",
      warns,
    );
  }

  return db.transaction(async (tx) => {
    const now = new Date();

    // Optimistic status guard (atomic; mirrors assignTrip / confirmTripAssignment): reassign only a
    // trip STILL in the expected reassignable status — 0 rows ⇒ it moved out (STALE_TRANSITION). This
    // is a no-op status pin (a reassignment does NOT change current_status — FR-008); it row-locks and
    // verifies in one statement, closing the TOCTOU race with a concurrent transition/unassign.
    const pinned = await tx
      .update(trips)
      .set({ updatedAt: now })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, input.expectedFromStatus)))
      .returning({ id: trips.id });
    if (pinned.length === 0) {
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    // Supersede the PRIOR current row FIRST (retained, never deleted). The partial-unique
    // `(trip_id) WHERE is_current` index is NON-deferred — it rejects a second is_current row at
    // INSERT time, not at commit — so the prior row must release the slot before the new current row
    // can be inserted. `superseded_by_assignment_id` is backfilled once the new row's id exists.
    const superseded = await tx
      .update(tripAssignments)
      .set({ isCurrent: false, supersededAt: now, updatedAt: now })
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)))
      .returning({ id: tripAssignments.id });
    if (superseded.length === 0) {
      // No prior current assignment existed — nothing to reassign (lost a race to unassign).
      throw new Conflict("STALE_TRANSITION", "Não há atribuição atual para substituir.");
    }

    // Insert the new current row (the partial-unique slot is now free).
    const insertedRows = await tx
      .insert(tripAssignments)
      .values({
        tripId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        trailerId: input.trailerId ?? null,
        carrierId: input.carrierId ?? null,
        assignedByUserId: actorUserId,
        notes: input.notes ?? null,
        overrideReason: input.overrideReason ?? null,
        isCurrent: true,
      })
      .returning({ id: tripAssignments.id });
    const newId = insertedRows[0]?.id;
    if (!newId) throw new Conflict("STALE_TRANSITION", "Falha ao criar a nova atribuição.");

    // Backfill the history chain: point the row(s) just superseded at the new current row.
    await tx
      .update(tripAssignments)
      .set({ supersededByAssignmentId: newId, updatedAt: now })
      .where(
        inArray(
          tripAssignments.id,
          superseded.map((r) => r.id),
        ),
      );

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.reassign",
      previousValue: { supersededAssignmentId: superseded[0]?.id ?? null },
      newValue: {
        assignmentId: newId,
        driverId: input.driverId,
        vehicleId: input.vehicleId,
        trailerId: input.trailerId ?? null,
        carrierId: input.carrierId ?? null,
      },
      actorUserId,
      reason: input.overrideReason ?? null,
    });

    // Feature 007 — assignment/confirmation changes clear/fire the missing_assignment /
    // missed_confirmation SLA reasons immediately (read-only inputs to the evaluator, FR-017/FR-019).
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return { trip: detail, findings: warns };
  });
}

// ---------------------------------------------------------------------------
// unassignTrip — assigned → received (T049 · contract §2)
// ---------------------------------------------------------------------------

/**
 * Un-assign an `assigned` trip, transitioning it back to `received` (data-model.md §4/§6; contract §2;
 * slice 015 retargeted the unassign target from the removed `validated` state to `received`). The
 * current assignment row is SUPERSEDED (retained as history, never deleted). Mirrors
 * `transitionTripStatus`: legality is checked with `canTransition("assigned","received")` BEFORE the
 * transaction; inside one transaction the guarded `UPDATE trips ... WHERE current_status='assigned'`
 * (0 rows ⇒ `STALE_TRANSITION`) runs with a `status_change` `trip_events` row and a `trip.unassign`
 * audit. No eligibility evaluation (unassigning is always allowed from `assigned`).
 */
export async function unassignTrip(
  tripId: string,
  input: { expectedFromStatus: string; notes?: string | null },
  actorUserId: string,
): Promise<{ trip: TripDetail; findings: Finding[] }> {
  const currentRows = await db
    .select({ currentStatus: trips.currentStatus })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  // Legality against the status machine — `assigned→received` is the unassign edge (slice 015; was
  // `assigned→validated`).
  if (!canTransition("assigned", "received")) {
    throw new Conflict("ILLEGAL_TRANSITION", "Transição de status não permitida.");
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(trips)
      .set({ currentStatus: "received", updatedAt: now })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, "assigned")))
      .returning();
    if (updated.length === 0) {
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    // Supersede the current assignment (retained — set is_current=false + superseded_at; no delete).
    await tx
      .update(tripAssignments)
      .set({ isCurrent: false, supersededAt: now, updatedAt: now })
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));

    await tx.insert(tripEvents).values({
      tripId,
      eventType: "status_change",
      statusBefore: "assigned",
      statusAfter: "received",
      source: "operator_manual",
      actorUserId,
      notes: input.notes ?? null,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.unassign",
      previousValue: { currentStatus: "assigned" },
      newValue: { currentStatus: "received" },
      actorUserId,
    });

    // Feature 007 — assignment/confirmation changes clear/fire the missing_assignment /
    // missed_confirmation SLA reasons immediately (read-only inputs to the evaluator, FR-017/FR-019).
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return { trip: detail, findings: [] };
  });
}

// ---------------------------------------------------------------------------
// confirmTripAssignment — assigned → confirmed (T028 · contract §3)
// ---------------------------------------------------------------------------

/**
 * Confirm the current assignment, transitioning the trip `assigned → confirmed` (data-model.md §4;
 * research §9; contract §3). RE-RUNS the evaluator against the CURRENT assignment's resources to catch
 * drift since assignment (e.g. a doc expired) — any unresolved `block` refuses with
 * `ASSIGNMENT_BLOCKED` (findings attached). WARNs already overridden at assignment do NOT block
 * confirm. On success, one transaction updates the current assignment row (`confirmed_by/at`), runs
 * the guarded `UPDATE trips ... WHERE current_status='assigned'` (0 rows ⇒ `STALE_TRANSITION`), inserts
 * a `status_change` `trip_events` row, and audits `trip.confirm`.
 */
export async function confirmTripAssignment(
  tripId: string,
  input: ConfirmAssignmentInput,
  actorUserId: string,
): Promise<{ trip: TripDetail; findings: Finding[] }> {
  // The trip must exist before we judge its assignment state — a missing trip is NOT_FOUND (contract
  // §3), not STALE_TRANSITION.
  const tripRows = await db
    .select({ currentStatus: trips.currentStatus })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  if (!tripRows[0]) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  // Load the CURRENT assignment's resources to re-evaluate eligibility (drift check).
  const currentAssignmentRows = await db
    .select({
      id: tripAssignments.id,
      driverId: tripAssignments.driverId,
      vehicleId: tripAssignments.vehicleId,
      trailerId: tripAssignments.trailerId,
      carrierId: tripAssignments.carrierId,
    })
    .from(tripAssignments)
    .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)))
    .limit(1);
  const assignment = currentAssignmentRows[0];
  if (!assignment) {
    // No current assignment to confirm — the trip cannot be in a confirmable assigned state.
    throw new Conflict("STALE_TRANSITION", "Não há atribuição atual para confirmar.");
  }

  const { context } = await gatherEligibilityContext(db, tripId, {
    driverId: assignment.driverId ?? undefined,
    vehicleId: assignment.vehicleId ?? undefined,
    trailerId: assignment.trailerId ?? undefined,
    carrierId: assignment.carrierId ?? undefined,
  });
  const findings = evaluateAssignmentEligibility(context, DEFAULT_ASSIGNMENT_POLICY);
  const { blocks } = partitionFindings(findings);
  if (blocks.length > 0) {
    throw new Conflict(
      "ASSIGNMENT_BLOCKED",
      "Confirmação bloqueada: restrições de elegibilidade não resolvidas.",
      blocks,
    );
  }

  return db.transaction(async (tx) => {
    const now = new Date();
    const updated = await tx
      .update(trips)
      .set({ currentStatus: "confirmed", updatedAt: now })
      .where(and(eq(trips.id, tripId), eq(trips.currentStatus, "assigned")))
      .returning();
    if (updated.length === 0) {
      throw new Conflict("STALE_TRANSITION", "A viagem já mudou de status.");
    }

    await tx
      .update(tripAssignments)
      .set({ confirmedByUserId: actorUserId, confirmedAt: now, updatedAt: now })
      .where(and(eq(tripAssignments.tripId, tripId), eq(tripAssignments.isCurrent, true)));

    await tx.insert(tripEvents).values({
      tripId,
      eventType: "status_change",
      statusBefore: "assigned",
      statusAfter: "confirmed",
      source: "operator_manual",
      actorUserId,
      notes: input.notes ?? null,
    });

    await writeAudit(tx, {
      entityType: "trip",
      entityId: tripId,
      action: "trip.confirm",
      previousValue: { currentStatus: "assigned" },
      newValue: { currentStatus: "confirmed" },
      actorUserId,
    });

    // Feature 007 — assignment/confirmation changes clear/fire the missing_assignment /
    // missed_confirmation SLA reasons immediately (read-only inputs to the evaluator, FR-017/FR-019).
    await recomputeTripSla(tx, tripId);

    const detail = await loadTripDetail(tx, tripId);
    if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
    return { trip: detail, findings: [] };
  });
}
