import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { inviteRedirectTo, resendInvite } from "@/lib/users/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/users/:id/invite — re-send the invite for a still-pending user (FR-013).
 * Returns 409 NOT_PENDING if the user has already activated.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_users");

    const { id } = await params;
    await resendInvite(id, ctx.userId, inviteRedirectTo(request));
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleRouteError(error);
  }
}
