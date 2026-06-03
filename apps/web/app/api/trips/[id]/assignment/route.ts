import { NextResponse } from "next/server";
import { assignTripSchema, confirmAssignmentSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, Conflict, handleRouteError } from "@/lib/api/respond";
import {
  assignTrip,
  assertTripExists,
  reassignTrip,
  unassignTrip,
} from "@/lib/trips/trip-assignments";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/assignment — assign **or** reassign resources (006, R9/R11; 010, #11). Requires
 * `assign_resources` (first enforced here). Branches EXPLICITLY on `expectedFromStatus`: a `validated`
 * trip is **assigned** (`validated → assigned`), an `assigned`/`confirmed` trip is **reassigned**
 * (supersede the current row, no status change), and **any other status** (received / validation_error
 * / in-flight / terminal) is rejected with `Conflict("NOT_ASSIGNABLE", …)` → 409 — an honest "must be
 * validated first" instead of silently misrouting into the reassign path's "reassignment only"
 * `ILLEGAL_TRANSITION` (the #11 defect). The service runs the server-authoritative eligibility evaluator
 * and may throw `Conflict(INCOMPLETE_ASSIGNMENT | OVERRIDE_REQUIRED | ASSIGNMENT_BLOCKED |
 * STALE_TRANSITION | ILLEGAL_TRANSITION | NOT_ASSIGNABLE | NOT_FOUND)` → 409 via `handleRouteError` (which surfaces the
 * `Finding[]` for OVERRIDE_REQUIRED/ASSIGNMENT_BLOCKED). Returns the trip + any overridden WARN findings.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "assign_resources");
    const { id } = await params;
    const input = assignTripSchema.parse(await request.json());

    // Explicit by-status branch (010, #11): a non-assignable from-status gets an honest
    // NOT_ASSIGNABLE rather than being silently routed into reassignTrip's "reassignment only" guard.
    let result: Awaited<ReturnType<typeof assignTrip>>;
    if (input.expectedFromStatus === "validated") {
      result = await assignTrip(id, input, ctx.userId);
    } else if (
      input.expectedFromStatus === "assigned" ||
      input.expectedFromStatus === "confirmed"
    ) {
      result = await reassignTrip(id, input, ctx.userId);
    } else {
      // A missing trip must be 404 NOT_FOUND (contract §1) even on the non-assignable path — verify
      // existence before the NOT_ASSIGNABLE short-circuit (#11 review). assign/reassign raise NOT_FOUND
      // themselves via gatherEligibilityContext; this branch never calls them, so check here.
      await assertTripExists(id);
      throw new Conflict("NOT_ASSIGNABLE", "A viagem precisa ser validada antes de ser atribuída.");
    }

    return NextResponse.json({ item: result.trip, findings: result.findings });
  } catch (error) {
    // A missing trip is 404 NOT_FOUND (contract §1/§2), not the generic 409 handleRouteError maps
    // Conflict to (mirrors apps/web/app/api/imports/[id]/confirm/route.ts).
    if (error instanceof Conflict && error.code === "NOT_FOUND") {
      return apiError(404, "NOT_FOUND", error.message);
    }
    return handleRouteError(error);
  }
}

/**
 * DELETE /api/trips/:id/assignment — unassign (006). Requires `assign_resources`. Supersedes the
 * current assignment (retained as history) and transitions `assigned → validated`. Body carries the
 * optimistic-concurrency `expectedFromStatus` (+ optional notes), validated with
 * `confirmAssignmentSchema`. Service may throw `Conflict(STALE_TRANSITION | ILLEGAL_TRANSITION |
 * NOT_FOUND)` → 409.
 */
export async function DELETE(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "assign_resources");
    const { id } = await params;
    const input = confirmAssignmentSchema.parse(await request.json());

    const result = await unassignTrip(id, input, ctx.userId);
    return NextResponse.json({ item: result.trip });
  } catch (error) {
    // A missing trip is 404 NOT_FOUND (contract §1/§2), not the generic 409 handleRouteError maps
    // Conflict to (mirrors apps/web/app/api/imports/[id]/confirm/route.ts).
    if (error instanceof Conflict && error.code === "NOT_FOUND") {
      return apiError(404, "NOT_FOUND", error.message);
    }
    return handleRouteError(error);
  }
}
