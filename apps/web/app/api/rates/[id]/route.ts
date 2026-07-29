import { NextResponse } from "next/server";
import { updateRateSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { updateRate } from "@/lib/trips/rates";

export const dynamic = "force-dynamic";

/** PATCH /api/rates/:id — update a rate (US4). `edit_rates`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "edit_rates");
    const { id } = await params;
    const input = updateRateSchema.parse(await request.json());
    const item = await updateRate(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
