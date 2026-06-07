import { NextResponse } from "next/server";
import { transitionTripSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { Conflict, handleRouteError } from "@/lib/api/respond";
import { transitionTripStatus } from "@/lib/trips/trip-transitions";

export const dynamic = "force-dynamic";

/**
 * Assignment-phase states are reachable ONLY through their dedicated endpoints, never this generic
 * status route: `assigned` and `received` (unassign) via POST/DELETE `/assignment`, and `confirmed`
 * via POST `/assignment/confirm`. Those endpoints enforce `assign_resources`, run the eligibility
 * evaluator, and create/supersede the `trip_assignments` row. The generic `transitionTripStatus` does
 * NONE of that, so reaching these via `/status` would (a) skip the `assign_resources` permission
 * (an `update_trip_status`-only holder like Control Tower could mint an "assigned" trip) and (b) leave
 * a STRUCTURALLY INCONSISTENT trip — e.g. `current_status = 'assigned'` with no current assignment
 * row. `received → assigned` etc. are legal table edges (assignTrip traverses them); they are just not
 * this route's to perform.
 */
const ASSIGNMENT_PHASE_STATUSES = new Set<string>(["received", "assigned", "confirmed"]);

/**
 * POST /api/trips/:id/status — record an execution milestone (007, US1). Drives the existing 003
 * status machine (`confirmed → at_origin → [loading] → loaded → in_transit → at_destination →
 * [unloading] → unloaded → completed`); each transition appends a `status_change` event and
 * recomputes SLA. Requires `update_trip_status` (first enforcement). Assignment-phase targets are
 * rejected here (see {@link ASSIGNMENT_PHASE_STATUSES}). 409s: USE_ASSIGNMENT_ENDPOINT /
 * ILLEGAL_TRANSITION / STALE_TRANSITION; 404 NOT_FOUND.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "update_trip_status");
    const { id } = await params;
    const input = transitionTripSchema.parse(await request.json());
    if (ASSIGNMENT_PHASE_STATUSES.has(input.toStatus)) {
      throw new Conflict(
        "USE_ASSIGNMENT_ENDPOINT",
        "Transição de atribuição não permitida por esta rota; use os endpoints de atribuição/confirmação.",
      );
    }
    const item = await transitionTripStatus(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
