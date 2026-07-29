import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryCancellationOptions } from "@/lib/trips/trip-cancellation";

export const dynamic = "force-dynamic";

/**
 * GET /api/cancellation-options — ACTIVE cancellation value sets for the cancel dialog (017, FR-004).
 * Requires `cancel_trip` (only users who can cancel need the lists). Returns `{ items }` with both
 * kinds (`reason` | `billing_impact`) ordered by `kind, sort_order` — a bounded config list, no
 * paging. NOT `/api/reason-codes`: that route serves the 007 EXCEPTION reason codes (different
 * table, deliberately separate domain).
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "cancel_trip");
    const items = await queryCancellationOptions();
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
