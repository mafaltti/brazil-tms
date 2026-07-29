import { NextResponse } from "next/server";
import { updateLocationSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { archiveLocation, getLocation, updateLocation } from "@/lib/master-data/locations-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/locations/:id — detail. Requires `manage_commercial_data`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const item = await getLocation(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/master-data/locations/:id — update (FR-005). Requires `manage_commercial_data`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const input = updateLocationSchema.parse(await request.json());
    const item = await updateLocation(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/master-data/locations/:id — archive (FR-026, FR-027). Requires `delete_archive` (Admin). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "delete_archive");
    const { id } = await params;
    const item = await archiveLocation(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
