import { NextResponse } from "next/server";
import { updateCarrierSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { archiveCarrier, getCarrier, updateCarrier } from "@/lib/master-data/carriers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/carriers/:id — detail. Requires `manage_fleet_data`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const { id } = await params;
    const item = await getCarrier(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/master-data/carriers/:id — update (FR-020). Requires `manage_fleet_data`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const { id } = await params;
    const input = updateCarrierSchema.parse(await request.json());
    const item = await updateCarrier(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/master-data/carriers/:id — archive (FR-026, FR-027). Requires `delete_archive` (Admin). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "delete_archive");
    const { id } = await params;
    const item = await archiveCarrier(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
