import { NextResponse } from "next/server";
import { createRateSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryRates } from "@/lib/trips/trips-read";
import { createRate } from "@/lib/trips/rates";

export const dynamic = "force-dynamic";

/** GET /api/rates?customerId= — rates with labels (US4). `view_all_trips`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId") ?? undefined;
    const items = await queryRates({ customerId });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/rates — create a rate (US4). `edit_rates`. → `201 { item }`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "edit_rates");
    const input = createRateSchema.parse(await request.json());
    const item = await createRate(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
