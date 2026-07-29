import { z } from "zod";
import { TRIP_STATUSES } from "../domain/trip-status";

/**
 * Shared Zod schemas for the feature 006 dispatch-assignment write surface (data-model.md §3 / research
 * §11; pt-BR messages). They validate the inputs to the assignment service functions
 * (`packages/db/src/trips/trip-assignments.ts`) and the BFF route handlers that call them, at the
 * boundary (400) before any row is touched. Shape/naming mirror `transitionTripSchema` (`./trip`):
 * `expectedFromStatus` carries the optimistic-concurrency expectation; the DB enforces FKs + the
 * single-current-assignment partial-unique index; conflict/eligibility legality lives server-side in
 * the evaluator (`../domain/assignment-eligibility`), NOT here.
 */

const uuid = (label: string) => z.string().uuid(`${label} inválido.`);

/** Optional, clearable UUID: a blank/null value collapses to undefined (trailer/carrier are optional). */
const optionalUuid = (label: string) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), uuid(label).optional());

const optionalNotes = z.string().trim().max(2000, "Máximo de 2000 caracteres.").optional();

// ---------------------------------------------------------------------------
// assignTrip / reassignTrip — set or substitute the resources running a trip (R9, R11)
// ---------------------------------------------------------------------------

/**
 * Assign (or reassign/substitute) driver + vehicle (+ optional trailer/carrier) to a trip. The
 * minimum-required set (driver+vehicle always; carrier when subcontracted) is enforced server-side via
 * `requiredResourcesFor`, not here. `overrideReason` is required by the service when WARN findings are
 * present and the caller chooses to proceed; an empty/whitespace reason is rejected by the trim+min.
 */
export const assignTripSchema = z.object({
  driverId: uuid("Motorista"),
  vehicleId: uuid("Veículo"),
  trailerId: optionalUuid("Reboque"),
  carrierId: optionalUuid("Transportadora"),
  expectedFromStatus: z.enum(TRIP_STATUSES, { message: "Status de origem inválido." }),
  notes: optionalNotes,
  overrideReason: z.string().trim().min(1, "Informe o motivo da exceção.").max(2000).optional(),
});

export type AssignTripInput = z.infer<typeof assignTripSchema>;

// ---------------------------------------------------------------------------
// confirmTripAssignment — confirm the current assignment (re-checks for BLOCK drift)
// ---------------------------------------------------------------------------

export const confirmAssignmentSchema = z.object({
  expectedFromStatus: z.enum(TRIP_STATUSES, { message: "Status de origem inválido." }),
  notes: optionalNotes,
});

export type ConfirmAssignmentInput = z.infer<typeof confirmAssignmentSchema>;

// ---------------------------------------------------------------------------
// checkAssignment — read-only dry-run: candidate resources only (powers inline warnings, R10)
// ---------------------------------------------------------------------------

export const checkAssignmentSchema = z.object({
  driverId: optionalUuid("Motorista"),
  vehicleId: optionalUuid("Veículo"),
  trailerId: optionalUuid("Reboque"),
  carrierId: optionalUuid("Transportadora"),
});

export type CheckAssignmentInput = z.infer<typeof checkAssignmentSchema>;
