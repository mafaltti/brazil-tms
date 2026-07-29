import { NextResponse } from "next/server";
import {
  createVehicleSchema,
  ownershipTypeSchema,
  resourceStatusSchema,
  vehicleTypeSchema,
} from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createVehicle, listVehicles } from "@/lib/master-data/vehicles-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/vehicles — list (US3). Requires `manage_fleet_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const url = new URL(request.url);
    const status = resourceStatusSchema.safeParse(url.searchParams.get("status"));
    const vehicleType = vehicleTypeSchema.safeParse(url.searchParams.get("vehicleType"));
    const ownership = ownershipTypeSchema.safeParse(url.searchParams.get("ownership"));
    const expiryParam = url.searchParams.get("expiry");
    const items = await listVehicles({
      q: url.searchParams.get("q") ?? undefined,
      status: status.success ? status.data : undefined,
      vehicleType: vehicleType.success ? vehicleType.data : undefined,
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

/** POST /api/master-data/vehicles — create (FR-013, FR-014). Requires `manage_fleet_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const input = createVehicleSchema.parse(await request.json());
    const item = await createVehicle(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
