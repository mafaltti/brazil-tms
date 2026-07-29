import { NextResponse } from "next/server";
import { confirmAssignmentSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, Conflict, handleRouteError } from "@/lib/api/respond";
import { confirmTripAssignment } from "@/lib/trips/trip-assignments";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/assignment/confirm — confirm the current assignment (006). Requires
 * `assign_resources`. Re-runs the evaluator to catch resource drift since assignment; refuses on any
 * unresolved BLOCK (`Conflict(ASSIGNMENT_BLOCKED)` → 409 with `findings`), otherwise stamps
 * `confirmed_by/at` and transitions `assigned → confirmed`. May also throw `Conflict(STALE_TRANSITION |
 * ILLEGAL_TRANSITION | NOT_FOUND)` → 409.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "assign_resources");
    const { id } = await params;
    const input = confirmAssignmentSchema.parse(await request.json());

    const result = await confirmTripAssignment(id, input, ctx.userId);
    return NextResponse.json({ item: result.trip });
  } catch (error) {
    if (error instanceof Conflict && error.code === "NOT_FOUND") {
      return apiError(404, "NOT_FOUND", error.message);
    }
    return handleRouteError(error);
  }
}
