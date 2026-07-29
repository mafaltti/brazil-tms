import { NextResponse } from "next/server";
import { updateUserSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateUser } from "@/lib/users/service";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/admin/users/:id — change a user's role and/or status (FR-014..FR-016).
 * The last-admin guard (409 LAST_ADMIN_GUARD) is enforced inside the service transaction.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_users");

    const { id } = await params;
    const body = await request.json();
    const input = updateUserSchema.parse(body);
    const user = await updateUser(id, input, ctx.userId);
    return NextResponse.json({ user });
  } catch (error) {
    return handleRouteError(error);
  }
}
