import { NextResponse } from "next/server";
import { markCompletedSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { markCompleted } from "@/lib/trips/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/complete — mark Completed (US2, §19.3). `mark_completed`. Gate-checks server-side
 * (the UI never decides); blocked ⇒ `409 COMPLETION_BLOCKED` with the blockers/missing types in
 * `findings`. On pass, drives `transitionTripStatus` (→ completed → billing_pending) + creates the
 * billing item. → `200 { item: TripDetailView }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "mark_completed");
    const { id } = await params;
    const input = markCompletedSchema.parse(await request.json().catch(() => ({})));
    const item = await markCompleted(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
