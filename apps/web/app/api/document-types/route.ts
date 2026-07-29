import { NextResponse } from "next/server";
import { createDocumentTypeSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { queryDocumentTypes } from "@/lib/trips/trips-read";
import { createDocumentType } from "@/lib/trips/document-requirements";

export const dynamic = "force-dynamic";

/**
 * GET /api/document-types — the document-type master (US1 upload picker + US3 admin). `view_all_trips`.
 */
export async function GET(): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "view_all_trips");
    const items = await queryDocumentTypes();
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/document-types — create a document type (US3). `manage_commercial_data`. → `201 { item }`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_commercial_data");
    const input = createDocumentTypeSchema.parse(await request.json());
    const item = await createDocumentType(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
