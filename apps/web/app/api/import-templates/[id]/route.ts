import { NextResponse } from "next/server";
import { z } from "zod";
import { templateConfigSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { getTemplate, updateTemplate } from "@/lib/imports/import-templates-service";

export const dynamic = "force-dynamic";

const updateTemplateSchema = templateConfigSchema.partial().extend({
  active: z.boolean().optional(),
  archive: z.boolean().optional(),
});

/** GET /api/import-templates/:id — detail. Requires `import_trips`. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const item = await getTemplate(id);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** PATCH /api/import-templates/:id — update/archive (FR-002, FR-003a, FR-004). Requires `import_trips`. */
export async function PATCH(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");
    const { id } = await params;
    const input = updateTemplateSchema.parse(await request.json());
    const item = await updateTemplate(id, input, ctx.userId);
    return NextResponse.json({ item });
  } catch (error) {
    return handleRouteError(error);
  }
}
