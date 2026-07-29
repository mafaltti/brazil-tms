import { NextResponse } from "next/server";
import { updateCustomerSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { archiveCustomer, getCustomer, updateCustomer } from "@/lib/master-data/customers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/customers/:id — detail. Requires `manage_commercial_data`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const item = await getCustomer(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/master-data/customers/:id — update (FR-001). Requires `manage_commercial_data`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const { id } = await params;
    const input = updateCustomerSchema.parse(await request.json());
    const item = await updateCustomer(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** DELETE /api/master-data/customers/:id — archive (FR-026, FR-027). Requires `delete_archive` (Admin). */
export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "delete_archive");
    const { id } = await params;
    const item = await archiveCustomer(id, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
