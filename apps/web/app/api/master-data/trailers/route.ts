import { NextResponse } from "next/server";
import {
  createTrailerSchema,
  ownershipTypeSchema,
  resourceStatusSchema,
  trailerTypeSchema,
} from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createTrailer, listTrailers } from "@/lib/master-data/trailers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/trailers — list (US3). Requires `manage_fleet_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const url = new URL(request.url);
    const status = resourceStatusSchema.safeParse(url.searchParams.get("status"));
    const trailerType = trailerTypeSchema.safeParse(url.searchParams.get("trailerType"));
    const ownership = ownershipTypeSchema.safeParse(url.searchParams.get("ownership"));
    const expiryParam = url.searchParams.get("expiry");
    const items = await listTrailers({
      q: url.searchParams.get("q") ?? undefined,
      status: status.success ? status.data : undefined,
      trailerType: trailerType.success ? trailerType.data : undefined,
      carrierId: url.searchParams.get("carrierId") ?? undefined,
      ownership: ownership.success ? ownership.data : undefined,
      expiry: expiryParam === "expiring" || expiryParam === "expired" ? expiryParam : undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/master-data/trailers — create (FR-015, FR-016). Requires `manage_fleet_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const input = createTrailerSchema.parse(await request.json());
    const item = await createTrailer(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
