import {
  canTransition,
  DISPATCH_PHASE_TRIP_STATUSES,
  type Role,
  type TripStatus,
} from "@brazil-tms/shared";

/**
 * How far a user's cancel permission reaches (017 R5; PRD §18 "Cancel trip"). Server pages compute
 * it from the session role and pass it down as a prop (the `canAssign` pattern); the BFF re-enforces
 * the same rule independently (`cancel_trip` + `allowedSourceStatuses`), so this is display logic,
 * never the security boundary.
 */
export type CancelScope = "any" | "dispatch_phase" | "none";

/** §18 matrix: Admin/Ops Manager — yes; Dispatcher — Limited (dispatch phase); everyone else — no. */
export function cancelScopeForRole(role: Role): CancelScope {
  if (role === "admin" || role === "operations_manager") return "any";
  if (role === "dispatcher") return "dispatch_phase";
  return "none";
}

/** Should THIS user see a cancel action on a trip in `status`? (scope ∩ machine legality) */
export function canCancelTrip(scope: CancelScope, status: TripStatus): boolean {
  if (scope === "none") return false;
  if (!canTransition(status, "cancelled")) return false;
  return scope === "any" || (DISPATCH_PHASE_TRIP_STATUSES as readonly TripStatus[]).includes(status);
}
