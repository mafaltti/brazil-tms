import { NextResponse } from "next/server";
import { createLocationSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createLocation, listLocations } from "@/lib/master-data/locations-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/locations — list (US2). Requires `manage_commercial_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const url = new URL(request.url);
    const items = await listLocations({
      customerId: url.searchParams.get("customerId") ?? undefined,
      q: url.searchParams.get("q") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/master-data/locations — create (FR-005, FR-006). Requires `manage_commercial_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const input = createLocationSchema.parse(await request.json());
    const item = await createLocation(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
