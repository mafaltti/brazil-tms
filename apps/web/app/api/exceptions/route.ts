import { NextResponse } from "next/server";
import { exceptionFilterSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryExceptions } from "@/lib/trips/exceptions";

export const dynamic = "force-dynamic";

/**
 * GET /api/exceptions — the Exception Management queue (007, US2). Filter by severity/status/customer/
 * lane/reason/owner/age. Requires `view_all_trips` (read surface — no write key). Returns `{ items }`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const filters = exceptionFilterSchema.parse(Object.fromEntries(url.searchParams));
    const items = await queryExceptions(filters);
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
