import { NextResponse } from "next/server";
import { isNonEditableStatus, updateTripPlanSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, handleRouteError } from "@/lib/api/respond";
import { getTripDetailView } from "@/lib/trips/trips-read";
import { updateTripPlan } from "@/lib/trips/trip-plan";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/trips/:id/plan — inline edit of live planned fields before completion (005, TRIP-005;
 * reuses 003's `updateTripPlan`: immutable plan, post-`confirmed` REVIEW_REQUIRED gate, `trip.plan_update`
 * audit). Edits keep `manage_trips` (only the read endpoints re-gate to `view_all_trips`). The route adds
 * the thin "before completion" guard (R11): a non-editable (completed/cancelled) status is `409
 * EDIT_NOT_ALLOWED`. `updateTripPlan` itself may throw `Conflict(REVIEW_REQUIRED | STALE_TRANSITION |
 * NOT_FOUND)` → 409 via `handleRouteError`.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_trips");
    const { id } = await params;
    const { authorizedReview, ...changes } = updateTripPlanSchema.parse(await request.json());

    const before = await getTripDetailView(id);
    if (!before) return apiError(404, "NOT_FOUND", "Viagem não encontrada.");
    if (isNonEditableStatus(before.currentStatus)) {
      return apiError(409, "EDIT_NOT_ALLOWED", "Edição não permitida após a conclusão da viagem.");
    }

    await updateTripPlan(id, changes, { authorizedReview }, ctx.userId);
    const item = await getTripDetailView(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
