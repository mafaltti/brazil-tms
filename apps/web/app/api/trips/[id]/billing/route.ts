import { NextResponse } from "next/server";
import { updateBillingItemSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateBillingItem } from "@/lib/trips/billing";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/trips/:id/billing — set the manual base / period / dispute / notes on a trip's billing
 * item (US4). `edit_rates`. → `200 { item: BillingItemView }`; `404` if no billing item yet.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "edit_rates");
    const { id } = await params;
    const input = updateBillingItemSchema.parse(await request.json());
    const item = await updateBillingItem(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
