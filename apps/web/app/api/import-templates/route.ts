import { NextResponse } from "next/server";
import { templateConfigSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { handleRouteError } from "@/lib/api/respond";
import { createTemplate, listTemplates } from "@/lib/imports/import-templates-service";

export const dynamic = "force-dynamic";

/** GET /api/import-templates — list per-customer template config (US1). Requires `import_trips`. */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const url = new URL(request.url);
    const items = await listTemplates({
      customerId: url.searchParams.get("customerId") ?? undefined,
      includeArchived: url.searchParams.get("includeArchived") === "true",
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST /api/import-templates — create template config (FR-001, FR-002). Requires `import_trips`. */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const input = templateConfigSchema.parse(await request.json());
    const item = await createTemplate(input, ctx.userId);
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
