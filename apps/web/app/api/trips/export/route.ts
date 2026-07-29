import { NextResponse } from "next/server";
import { tripExportQueryFromParams } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, Conflict, handleRouteError } from "@/lib/api/respond";
import { exportTripRows } from "@/lib/trips/trips-read";
import { tripRowsToCsv } from "@/lib/trips/export-csv";

export const dynamic = "force-dynamic";

/**
 * GET /api/trips/export — synchronous, capped CSV export of the current board filter (005, US3).
 * Requires `view_all_trips`. Over the cap, `exportTripRows` throws `Conflict("EXPORT_TOO_LARGE")`,
 * which the contract maps to `422` (not the default `409`).
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");

    const url = new URL(request.url);
    const query = tripExportQueryFromParams(url.searchParams);
    const rows = await exportTripRows(query);
    const csv = tripRowsToCsv(rows);
    return new NextResponse(csv, {
      status: 200,
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": 'attachment; filename="trips.csv"',
      },
    });
  } catch (error) {
    if (error instanceof Conflict && error.code === "EXPORT_TOO_LARGE") {
      return apiError(422, "EXPORT_TOO_LARGE", error.message);
    }
    return handleRouteError(error);
  }
}
