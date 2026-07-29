import { NextResponse } from "next/server";
import { createLaneSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createLane, listLanes } from "@/lib/master-data/lanes-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/lanes — list (US2). Requires `manage_commercial_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const url = new URL(request.url);
    const items = await listLanes({
      customerId: url.searchParams.get("customerId") ?? undefined,
      originId: url.searchParams.get("originId") ?? undefined,
      destinationId: url.searchParams.get("destinationId") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/master-data/lanes — create (FR-007, FR-008, FR-009). Requires `manage_commercial_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");

    const input = createLaneSchema.parse(await request.json());
    const item = await createLane(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
