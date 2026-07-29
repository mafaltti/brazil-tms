import { NextResponse } from "next/server";
import { reportFromParams } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryExceptionReport } from "@/lib/trips/reporting";

export const dynamic = "force-dynamic";

/**
 * GET /api/reports/exceptions — exception volume / delay reasons by customer/lane/period (009, US2;
 * contracts §2). Period membership by `opened_at`. Read-only, polled (60s). Requires `view_all_trips`.
 * 401 no session · 403 lacks key · 400 invalid filter.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const filters = reportFromParams(new URL(request.url).searchParams);
    const report = await queryExceptionReport(filters);
    return NextResponse.json(report);
  } catch (error) {
    return handleRouteError(error);
  }
}
