import { NextResponse } from "next/server";
import { updateSlaRuleSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateCustomerSlaRule } from "@/lib/trips/sla-rules";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/customer-sla-rules/:id — edit a per-customer SLA rule (007, US5). Reuses
 * `manage_commercial_data`. 404 NOT_FOUND on a missing rule/lane.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const input = updateSlaRuleSchema.parse(await request.json());
    const item = await updateCustomerSlaRule(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
