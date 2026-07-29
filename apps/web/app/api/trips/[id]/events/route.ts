import { NextResponse } from "next/server";
import { addTripNoteSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { addTripNote } from "@/lib/trips/trip-events";

export const dynamic = "force-dynamic";

/**
 * POST /api/trips/:id/events — append a free-form note (007, US1). A note is a `trip_events` row with
 * NO status change. Requires `update_trip_status` (same key as milestone recording). 404 NOT_FOUND.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "update_trip_status");
    const { id } = await params;
    const input = addTripNoteSchema.parse(await request.json());
    const item = await addTripNote(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
