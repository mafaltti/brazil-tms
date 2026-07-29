import { NextResponse } from "next/server";
import { transitionExceptionSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { transitionException } from "@/lib/trips/exceptions";

export const dynamic = "force-dynamic";

/**
 * POST /api/exceptions/:id/transition — work an exception through its lifecycle (007, US2):
 * Open↔Monitoring; →Resolved/Cancelled (terminal, closure notes on Resolve). Requires
 * `resolve_exceptions`. 409 ILLEGAL_EXCEPTION_TRANSITION / STALE_EXCEPTION.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "resolve_exceptions");
    const { id } = await params;
    const input = transitionExceptionSchema.parse(await request.json());
    const item = await transitionException(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
