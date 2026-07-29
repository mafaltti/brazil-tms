import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { uploadDocumentMetaSchema } from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { Conflict, handleRouteError } from "@/lib/api/respond";
import { assertUploadable, uploadDocument } from "@/lib/trips/documents";
import { documentStorageKey, documentsBucket, putDocument, removeObject } from "@/lib/supabase/storage";

export const dynamic = "force-dynamic";

/** Allowed proof-document types (default PDF/JPG/PNG). Maps a file to its extension + content type. */
function inferDocFile(
  fileName: string,
  contentType: string,
): { ext: string; contentType: string } | null {
  const lower = fileName.toLowerCase();
  const ct = contentType.toLowerCase();
  if (lower.endsWith(".pdf") || ct === "application/pdf") return { ext: "pdf", contentType: "application/pdf" };
  if (lower.endsWith(".png") || ct === "image/png") return { ext: "png", contentType: "image/png" };
  if (lower.endsWith(".jpg") || lower.endsWith(".jpeg") || ct === "image/jpeg") {
    return { ext: "jpg", contentType: "image/jpeg" };
  }
  return null;
}

function maxBytes(): number {
  const v = Number(process.env.DOCUMENT_MAX_BYTES);
  return Number.isFinite(v) && v > 0 ? v : 10 * 1024 * 1024;
}

/**
 * POST /api/trips/:id/documents — upload a proof document (US1, DOC-001). `upload_documents`. The file
 * type + size are validated BEFORE storing (R9): a disallowed type ⇒ `409 UNSUPPORTED_FILE_TYPE`, an
 * oversize file ⇒ `409 FILE_TOO_LARGE`, and nothing is stored. Then put to Storage + insert the row.
 */
export async function POST(
  request: Request,
  { params }: { params: Promise<{ id: string }> },
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "upload_documents");
    const { id: tripId } = await params;

    // Reject an oversize body BEFORE buffering it (the precise per-file check is below as a backstop).
    // A valid <=10 MB file's multipart body is the file + small meta/boundary overhead, so allow a margin.
    const declaredSize = Number(request.headers.get("content-length") ?? 0);
    if (declaredSize > maxBytes() + 64 * 1024) {
      throw new Conflict("FILE_TOO_LARGE", "Arquivo muito grande (máximo ~10 MB).");
    }

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) {
      throw new Conflict("NO_FILE", "Arquivo do documento obrigatório.");
    }

    const inferred = inferDocFile(file.name, file.type ?? "");
    if (!inferred) {
      throw new Conflict("UNSUPPORTED_FILE_TYPE", "Tipo de arquivo não suportado (use PDF, JPG ou PNG).");
    }
    if (file.size > maxBytes()) {
      throw new Conflict("FILE_TOO_LARGE", "Arquivo muito grande (máximo ~10 MB).");
    }

    const metaRaw = form.get("meta");
    const meta = uploadDocumentMetaSchema.parse(
      typeof metaRaw === "string" ? JSON.parse(metaRaw) : {},
    );

    // Preflight the DB refs (trip exists, type active) BEFORE storing — no orphan object / FK 500.
    await assertUploadable(tripId, meta.documentTypeId);

    const documentId = randomUUID();
    const key = documentStorageKey(tripId, documentId, inferred.ext);
    const bytes = Buffer.from(await file.arrayBuffer());
    await putDocument(key, bytes, inferred.contentType);

    let item;
    try {
      item = await uploadDocument(
        tripId,
        {
          id: documentId,
          documentTypeId: meta.documentTypeId,
          fileStorageKey: key,
          externalReference: meta.externalReference,
          notes: meta.notes,
        },
        ctx.userId,
      );
    } catch (insertError) {
      // Roll back the stored binary if the metadata insert fails (e.g. a race after the preflight).
      await removeObject(key, documentsBucket());
      throw insertError;
    }
    return NextResponse.json({ item }, { status: 201 });
  } catch (error) {
    return handleRouteError(error);
  }
}
