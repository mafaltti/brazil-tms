import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryDashboardMetrics } from "@/lib/trips/trips-read";

export const dynamic = "force-dynamic";

/**
 * GET /api/dashboard/summary — Home daily dashboard metrics (005, US4): aggregate counts/indicators
 * over today's trips. Read-only, polled via TanStack Query (no Realtime). Requires `view_all_trips`.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const summary = await queryDashboardMetrics();
    return NextResponse.json({ summary });
  } catch (error) {
    return handleRouteError(error);
  }
}
