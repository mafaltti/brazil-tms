import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { removeBillingAdjustment } from "@/lib/trips/billing";

export const dynamic = "force-dynamic";

/**
 * DELETE /api/billing-adjustments/:id — soft-remove an adjustment (US4). `edit_rates`. → `200
 * { item: BillingItemView }`.
 */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "edit_rates");
    const { id } = await params;
    const item = await removeBillingAdjustment(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
