import { NextResponse } from "next/server";
import { normalizeFreightSheet } from "@brazil-tms/shared";
import { Conflict, handleRouteError } from "@/lib/api/respond";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { parseFreightSheet } from "@/lib/freight-rates/parse-xlsx";
import { replaceFreightRates } from "@/lib/freight-rates/service";

export const dynamic = "force-dynamic";

/**
 * POST /api/freight-rates/import — replace the whole agregados rate table from the standard
 * spreadsheet (016 US2, FR-005). Sync parse (research R1): the file is tiny, and a rejected file
 * must change nothing — row/column issues come back on the 409. Requires `import_freight_rates`
 * (Admin, Finance — §18 "Edit rates" precedent).
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "import_freight_rates");

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Conflict("NO_FILE", "Planilha de fretes obrigatória.");
    }
    if (!file.name.toLowerCase().endsWith(".xlsx")) {
      throw new Conflict("UNSUPPORTED_FILE_TYPE", "Tipo de arquivo não suportado (use .xlsx).");
    }

    const grid = await parseFreightSheet(Buffer.from(await file.arrayBuffer()));
    if (grid === null) {
      throw new Conflict(
        "SHEET_NOT_FOUND",
        'A planilha precisa conter a aba "Controle de Fretes".',
      );
    }

    const normalized = normalizeFreightSheet(grid);
    if (!normalized.ok) {
      // House envelope: Conflict `details` surfaces as top-level `findings` (respond.ts).
      throw new Conflict(
        "INVALID_FILE",
        "A planilha contém erros e nada foi alterado. Corrija e envie novamente.",
        normalized.issues,
      );
    }

    const item = await replaceFreightRates(
      normalized.rates,
      normalized.routeCount,
      file.name,
      ctx.userId,
    );
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
