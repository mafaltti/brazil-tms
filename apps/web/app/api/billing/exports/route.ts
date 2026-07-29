import { NextResponse } from "next/server";
import { createExportSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createExportBatch, queryExportBatches } from "@/lib/billing/exports";
import { enqueueBillingExport } from "@/lib/billing/queue";

export const dynamic = "force-dynamic";

/**
 * GET /api/billing/exports?customerId=&period= — export-batch history (US5, BILL-008). `view_all_trips`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId") ?? undefined;
    const billingPeriod = url.searchParams.get("period") ?? undefined;
    const items = await queryExportBatches({ customerId, billingPeriod });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/billing/exports — generate a billing export (US5, BILL-007). `export_billing`. Validates a
 * non-empty billing-ready set (`409 NO_BILLABLE_TRIPS`), inserts a queued `export_batches` row + audit,
 * and enqueues the on-demand worker job (heavy generation off the request path). → `202 { item }`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "export_billing");
    const input = createExportSchema.parse(await request.json());
    const item = await createExportBatch(input, ctx.userId);
    await enqueueBillingExport({ exportBatchId: item.id, actorUserId: ctx.userId });
    return NextResponse.json({ item }, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}
