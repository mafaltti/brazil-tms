import { NextResponse } from "next/server";
import { updateExceptionSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateException } from "@/lib/trips/exceptions";

export const dynamic = "force-dynamic";

/**
 * PATCH /api/exceptions/:id — edit a non-terminal exception's owner/severity/responsible-party/
 * description (007, US2). Requires `resolve_exceptions`. 409 STALE_EXCEPTION when already closed.
 */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "resolve_exceptions");
    const { id } = await params;
    const input = updateExceptionSchema.parse(await request.json());
    const item = await updateException(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
