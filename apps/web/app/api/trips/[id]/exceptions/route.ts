import { NextResponse } from "next/server";
import { createExceptionSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createException } from "@/lib/trips/exceptions";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/exceptions — log an exception on a trip (007, US2). Requires `create_exceptions`
 * (first enforcement). The reason code pre-fills severity/responsible-party; a high-severity exception
 * raises its alert + recomputes SLA synchronously. 201 with the updated `TripDetail`.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "create_exceptions");
    const { id } = await params;
    const input = createExceptionSchema.parse(await request.json());
    const item = await createException(id, input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
