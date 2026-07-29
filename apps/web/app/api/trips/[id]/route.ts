import { NextResponse } from "next/server";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, handleRouteError } from "@/lib/api/respond";
import { getTripDetailView } from "@/lib/trips/trips-read";

export const dynamic = "force-dynamic";

/**
 * GET /api/trips/:id — Trip Detail view (005, US2): trip + events + audit + billing projection plus
 * the labelled placeholder sections owned by later slices. Requires `view_all_trips` (re-gated from
 * `manage_trips`).
 */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const { id } = await params;
    const item = await getTripDetailView(id);
    if (!item) return apiError(404, "NOT_FOUND", "Viagem não encontrada.");
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
