import { NextResponse } from "next/server";
import { createCarrierSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createCarrier, listCarriers } from "@/lib/master-data/carriers-service";

export const dynamic = "force-dynamic";

/** GET /api/master-data/carriers — list (US4). Requires `manage_fleet_data`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const url = new URL(request.url);
    const items = await listCarriers({
      q: url.searchParams.get("q") ?? undefined,
      contractStatus: url.searchParams.get("contractStatus") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/master-data/carriers — create (FR-020, FR-021). Requires `manage_fleet_data`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    const input = createCarrierSchema.parse(await request.json());
    const item = await createCarrier(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
