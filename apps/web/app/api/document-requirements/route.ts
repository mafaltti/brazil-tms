import { NextResponse } from "next/server";
import { createDocumentRequirementSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryDocumentRequirements } from "@/lib/trips/trips-read";
import { createDocumentRequirement } from "@/lib/trips/document-requirements";

export const dynamic = "force-dynamic";

/**
 * GET /api/document-requirements?customerId= — a customer's checklist (US3). `view_all_trips`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const url = new URL(request.url);
    const customerId = url.searchParams.get("customerId") ?? undefined;
    const items = await queryDocumentRequirements({ customerId });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * POST /api/document-requirements — add a checklist row (US3). `manage_commercial_data`. → `201 { item }`.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const input = createDocumentRequirementSchema.parse(await request.json());
    const item = await createDocumentRequirement(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
