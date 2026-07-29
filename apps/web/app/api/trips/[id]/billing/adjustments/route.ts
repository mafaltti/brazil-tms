import { NextResponse } from "next/server";
import { addBillingAdjustmentSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { addBillingAdjustment } from "@/lib/trips/billing";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/billing/adjustments — add a typed adjustment (US4). `edit_rates`. → `201
 * { item: BillingItemView }`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "edit_rates");
    const { id } = await params;
    const input = addBillingAdjustmentSchema.parse(await request.json());
    const item = await addBillingAdjustment(id, input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
