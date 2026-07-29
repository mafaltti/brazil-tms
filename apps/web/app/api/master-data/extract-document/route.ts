import { NextResponse } from "next/server";
import { extractDocumentRequestSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, handleRouteError } from "@/lib/api/respond";
import {
  ExtractionFailed,
  ExtractionNotConfigured,
  extractDocument,
} from "@/lib/ai/extract-document";

export const dynamic = "force-dynamic";

/**
 * POST /api/master-data/extract-document — AI document reading (021, issue #29). Requires
 * `manage_fleet_data` (the fleet-registration permission). Body: `{ docType: cnh|crlv, mediaType,
 * data }` (base64; images ≤ 10 MiB ENCODED — the Anthropic per-image cap ≈ 7.5 MiB raw — and PDFs
 * ≤ 10 MiB raw; oversize → 400 here, never reaching the provider). Runs ONE synchronous vision
 * call (60 s cap — 016 R1 precedent; not
 * batch work) and returns `{ fields, unreadable }` for the form to PREFILL — creating the record
 * stays on the existing validated paths (FR-004). The payload is EPHEMERAL: never persisted or
 * logged (FR-005). 503 EXTRACTION_NOT_CONFIGURED without a server key (feature dark, FR-007);
 * 502 EXTRACTION_FAILED on provider errors; 400 Zod.
 */
export async function POST(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const input = extractDocumentRequestSchema.parse(await request.json());
    const result = await extractDocument(input);
    return NextResponse.json(result);
  } catch (error) {
    if (error instanceof ExtractionNotConfigured) {
      return apiError(503, error.code, error.message);
    }
    if (error instanceof ExtractionFailed) {
      return apiError(502, error.code, error.message);
    }
    return handleRouteError(error);
  }
}
