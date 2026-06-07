import { NextResponse } from "next/server";
import { inferFileType } from "@brazil-tms/shared";
import { Conflict, handleRouteError } from "@/lib/api/respond";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { createBatch, listBatches } from "@/lib/imports/import-batches-service";

export const dynamic = "force-dynamic";

/**
 * POST /api/imports — upload an import file (US1, FR-006/007/009). Fast path: authz → Storage put →
 * batch insert → enqueue parse → `202 { id }`. Requires `import_trips`. The heavy work is the worker's.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Conflict("NO_FILE", "Arquivo de importação obrigatório.");
    }

    const customerId = String(form.get("customerId") ?? "");
    const templateIdValue = form.get("templateId");
    const templateId =
      typeof templateIdValue === "string" && templateIdValue.length > 0
        ? templateIdValue
        : undefined;

    const fileType = inferFileType(file.name);
    if (!fileType) {
      throw new Conflict("UNSUPPORTED_FILE_TYPE", "Tipo de arquivo não suportado (use .csv ou .xlsx).");
    }

    const fileBytes = Buffer.from(await file.arrayBuffer());
    const { id } = await createBatch(
      { customerId, templateId, fileName: file.name, fileType, fileBytes },
      ctx.userId,
    );
    return NextResponse.json({ id }, { status: 202 });
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * GET /api/imports — import batch history, newest first (US5, FR-031, INT-004). Requires `import_trips`.
 * Query: `?customerId=`, `?status=`, `?limit=`.
 */
export async function GET(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_trips");

    const url = new URL(request.url);
    const limitParam = url.searchParams.get("limit");
    const items = await listBatches({
      customerId: url.searchParams.get("customerId") ?? undefined,
      status: url.searchParams.get("status") ?? undefined,
      limit: limitParam ? Number(limitParam) : undefined,
    });
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}
