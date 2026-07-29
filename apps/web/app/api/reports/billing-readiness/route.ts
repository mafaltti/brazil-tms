import { NextResponse } from "next/server";
import { reportFromParams } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryBillingReadinessReport } from "@/lib/trips/reporting";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/billing-readiness — billing-phase readiness by customer/period (009, US3;
 * contracts §3). Period = month of completion (`billing_items.billing_period`); grouping fixed to
 * customer. Read-only, polled (60s). Requires `view_all_trips`. 401 · 403 · 400 as the other reports.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const filters = reportFromParams(new URL(request.url).searchParams);
    const report = await queryBillingReadinessReport(filters);
    return NextResponse.json(report);
  } catch (error) {
    return handleRouteError(error);
  }
}
