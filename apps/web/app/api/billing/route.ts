import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryBillingList } from "@/lib/billing/exports";

export const dynamic = "force-dynamic";

/**
 * GET /api/billing?scope=pending|ready&customerId=&period= — the billing pending/ready lists (US5,
 * FR-019). `view_all_trips`. Each row carries the computed billable value + a missing-proof indicator.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const scope = url.searchParams.get("scope") === "ready" ? "ready" : "pending";
    const customerId = url.searchParams.get("customerId") ?? undefined;
    const billingPeriod = url.searchParams.get("period") ?? undefined;
    const items = await queryBillingList({ scope, customerId, billingPeriod });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
