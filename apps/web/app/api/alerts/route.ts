import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { listAlerts } from "@/lib/trips/alerts";

export const dynamic = "force-dynamic";

/**
 * GET /api/alerts — the active/acknowledged in-app alert list + per-case/severity counts (007, US4).
 * Requires `view_all_trips` (read surface). Optional `state` (`active`|`acknowledged`) / `tripId`
 * narrow the list; resolved rows are always excluded. Returns `{ items, counts }`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const state = url.searchParams.get("state") ?? undefined;
    const tripId = url.searchParams.get("tripId") ?? undefined;
    const { items, counts } = await listAlerts({ state, tripId });
    return NextResponse.json({ items, counts });
  } catch (error) {
    return handleRouteError(error);
  }
}
