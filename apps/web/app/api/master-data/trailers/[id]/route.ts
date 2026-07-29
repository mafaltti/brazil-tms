import { NextResponse } from "next/server";
import { updateTrailerSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { archiveTrailer, getTrailer, updateTrailer } from "@/lib/master-data/trailers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/trailers/:id — detail. Requires `manage_fleet_data`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const { id } = await params;
    const item = await getTrailer(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/master-data/trailers/:id — update (FR-015, FR-018). Requires `manage_fleet_data`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const { id } = await params;
    const input = updateTrailerSchema.parse(await request.json());
    const item = await updateTrailer(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/master-data/trailers/:id — archive (FR-026, FR-027). Requires `delete_archive` (Admin). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "delete_archive");
    const { id } = await params;
    const item = await archiveTrailer(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
