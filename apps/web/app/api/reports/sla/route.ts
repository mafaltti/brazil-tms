import { NextResponse } from "next/server";
import { reportFromParams } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { querySlaReport } from "@/lib/trips/reporting";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/sla — SLA performance by customer/lane/period (009, US1; contracts §1). Read-only,
 * polled via TanStack Query (no Realtime). Requires `view_all_trips` (mirrors the 005 dashboard). The
 * report body is returned directly (no wrapper). 401 no session · 403 lacks key · 400 invalid filter.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const filters = reportFromParams(new URL(request.url).searchParams);
    const report = await querySlaReport(filters);
    return NextResponse.json(report);
  } catch (error) {
    return handleRouteError(error);
  }
}
