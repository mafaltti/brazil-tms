import { NextResponse } from "next/server";
import { markBillingReadySchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { markBillingReady } from "@/lib/trips/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/billing-ready — mark Billing Ready (US2, §19.4). `mark_billing_ready`. Blocked ⇒
 * `409 BILLING_READY_BLOCKED` with the blockers in `findings`. On pass, drives
 * `transitionTripStatus(billing_pending→billing_ready)`. → `200 { item: TripDetailView }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "mark_billing_ready");
    const { id } = await params;
    const input = markBillingReadySchema.parse(await request.json().catch(() => ({})));
    const item = await markBillingReady(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
