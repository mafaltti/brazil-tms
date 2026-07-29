import { NextResponse } from "next/server";
import { createSlaRuleSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createCustomerSlaRule, queryCustomerSlaRules } from "@/lib/trips/sla-rules";

export const dynamic = "force-dynamic";

/**
 * GET /api/customer-sla-rules — list per-customer SLA rules (007, US5). Read surface → `view_all_trips`.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const items = await queryCustomerSlaRules();
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/customer-sla-rules — create a per-customer SLA rule (007, US5). Admin write reuses
 * `manage_commercial_data` (no new key). 201 with the created rule; 404 NOT_FOUND on a missing
 * customer/lane.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const input = createSlaRuleSchema.parse(await request.json());
    const item = await createCustomerSlaRule(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
