import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryReasonCodes } from "@/lib/trips/exceptions";

export const dynamic = "force-dynamic";

/**
 * GET /api/reason-codes — active exception reason codes for the create form (007, US2). Requires
 * `view_all_trips`. Returns `{ items }` ordered by `sort_order` with their default severity/party.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const items = await queryReasonCodes();
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
