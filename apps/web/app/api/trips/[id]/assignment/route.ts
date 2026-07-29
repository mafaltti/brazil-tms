import { NextResponse } from "next/server";
import { assignTripSchema, confirmAssignmentSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, Conflict, handleRouteError } from "@/lib/api/respond";
import {
  assignTrip,
  reassignTrip,
  unassignTrip,
} from "@/lib/trips/trip-assignments";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/assignment — assign **or** reassign resources (006, R9/R11). Requires
 * `assign_resources` (first enforced here). Branches on `expectedFromStatus`: a `received` trip is
 * **assigned** (`received → assigned`; slice 015 retargeted off the removed `validated` state), an
 * `assigned`/`confirmed` trip is **reassigned** (supersede the current row, no status change). The
 * service runs the server-authoritative eligibility evaluator
 * and may throw `Conflict(INCOMPLETE_ASSIGNMENT | OVERRIDE_REQUIRED | ASSIGNMENT_BLOCKED |
 * STALE_TRANSITION | ILLEGAL_TRANSITION | NOT_FOUND)` → 409 via `handleRouteError` (which surfaces the
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

    const result =
      input.expectedFromStatus === "received"
        ? await assignTrip(id, input, ctx.userId)
        : await reassignTrip(id, input, ctx.userId);

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
 * current assignment (retained as history) and transitions `assigned → received` (slice 015; was
 * `assigned → validated`). Body carries the
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
