import { NextResponse } from "next/server";
import { cancelTripSchema, DISPATCH_PHASE_TRIP_STATUSES } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { cancelTrip } from "@/lib/trips/trip-cancellation";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/cancel — cancel a trip with full §19.5 justification (017, US1-US3; issue #24).
 * The ONLY path to `cancelled` (the generic `/status` route refuses it — FR-008). Requires
 * `cancel_trip` (admin, operations_manager, dispatcher — §18; control_tower has no key).
 *
 * Body: `{ reasonCode, responsibleParty, billingImpact }` — parsed with `cancelTripSchema`, but any
 * client-supplied `cancellationTimestamp` is DISCARDED here so `cancelled_at` is always server
 * `now()` (FR-005). Dispatcher's §18 "Limited" (clarification 2026-07-27): the domain call gets
 * `allowedSourceStatuses = DISPATCH_PHASE_TRIP_STATUSES`, so a dispatcher can cancel only a
 * `received`/`assigned`/`confirmed` trip.
 *
 * 200 `{ item: TripDetail }`. 400 Zod (missing element, FR-006); 401/403 auth; 404 NOT_FOUND;
 * 409: NOT_CANCELLABLE / NOT_CANCELLABLE_BY_ROLE / STALE_TRANSITION / CANCELLATION_NOT_CONFIGURED /
 * INVALID_REASON_CODE / INVALID_BILLING_IMPACT.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "cancel_trip");
    const { id } = await params;
    const parsed = cancelTripSchema.parse(await request.json());
    // Forward ONLY the three user inputs — never the client timestamp (FR-005).
    const item = await cancelTrip(
      id,
      {
        reasonCode: parsed.reasonCode,
        responsibleParty: parsed.responsibleParty,
        billingImpact: parsed.billingImpact,
      },
      ctx.userId,
      ctx.role === "dispatcher" ? { allowedSourceStatuses: DISPATCH_PHASE_TRIP_STATUSES } : {},
    );
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
