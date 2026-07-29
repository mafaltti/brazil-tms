import { NextResponse } from "next/server";
import {
  createDriverSchema,
  ownershipTypeSchema,
  resourceStatusSchema,
} from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createDriver, listDrivers } from "@/lib/master-data/drivers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/drivers — list (US3). Requires `manage_fleet_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const url = new URL(request.url);
    const status = resourceStatusSchema.safeParse(url.searchParams.get("status"));
    const ownership = ownershipTypeSchema.safeParse(url.searchParams.get("ownership"));
    const expiryParam = url.searchParams.get("expiry");
    const items = await listDrivers({
      q: url.searchParams.get("q") ?? undefined,
      status: status.success ? status.data : undefined,
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

/** POST /api/master-data/drivers — create (FR-011, FR-012). Requires `manage_fleet_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const input = createDriverSchema.parse(await request.json());
    const item = await createDriver(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
