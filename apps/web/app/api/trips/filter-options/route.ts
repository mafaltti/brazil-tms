import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { getTripFilterOptions } from "@/lib/trips/trips-read";

export const dynamic = "force-dynamic";

/**
 * GET /api/trips/filter-options — the option lists (customers/locations/lanes + active fleet +
 * reason codes/owners) that nine pages load server-side (019, issue #26). This read lets an OPEN tab
 * keep those lists fresh via the `useFilterOptions` polled query (60 s + focus refetch) — before
 * 019, a newly registered driver never appeared in the pickers until a full page reload. Requires
 * `view_all_trips` (held by all seven internal roles — §18); the consuming pages' own server guards
 * remain authoritative for page access.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const options = await getTripFilterOptions();
    return NextResponse.json({ options });
  } catch (error) {
    return handleRouteError(error);
  }
}
