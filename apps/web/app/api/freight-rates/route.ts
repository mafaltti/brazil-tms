import { NextResponse } from "next/server";
import { freightRateFilterSchema } from "@brazil-tms/shared";
import { handleRouteError } from "@/lib/api/respond";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { queryFreightRates } from "@/lib/freight-rates/service";

export const dynamic = "force-dynamic";

/**
 * GET /api/freight-rates — search the agregados rate table (016 US1, FR-001..004).
 * Requires `view_freight_rates` (the 7 internal roles; Customer Viewer has no role mapping).
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_freight_rates");

    const url = new URL(request.url);
    const raw = Object.fromEntries(
      ["originUf", "originCity", "destinationUf", "destinationCity", "priceMinCents", "priceMaxCents", "sort"]
        .map((key) => [key, url.searchParams.get(key) ?? undefined] as const)
        .filter(([, value]) => value !== undefined && value !== ""),
    );
    const filters = freightRateFilterSchema.parse(raw);
    const items = await queryFreightRates(filters);
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
