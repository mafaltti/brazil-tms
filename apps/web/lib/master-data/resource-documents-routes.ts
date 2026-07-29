import "server-only";
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import {
  uploadResourceDocumentMetaSchema,
  type ResourceDocumentEntityType,
} from "@brazil-tms/shared";
import { requireAuth, requirePermission } from "@/lib/auth/require-auth";
import { apiError, Conflict, handleRouteError } from "@/lib/api/respond";
import {
  assertResourceDocumentParent,
  createResourceDocument,
  getResourceDocumentFileKey,
  listResourceDocuments,
} from "@/lib/master-data/resource-documents-service";
import {
  documentsBucket,
  putDocument,
  removeObject,
  resourceDocumentStorageKey,
  signedUrl,
} from "@/lib/supabase/storage";

/**
 * Slice 025 (issue #32 [0009]) — shared handlers behind the four registry-attachment routes
 * (drivers/vehicles × list+upload / download). Mirrors the 008 trip-documents route posture:
 * validate type+size and preflight the parent BEFORE storing; roll the binary back if the
 * metadata insert fails; downloads are short-lived signed URLs. Everything gates on
 * `manage_fleet_data` — the same permission as the registry pages hosting the tab.
 */

/** Allowed attachment types (the 008 default set). Maps a file to its extension + content type. */
function inferDocFile(
  fileName: string,
  contentType: string,
): { ext: string; contentType: string } | null {
  const lower = fileName.toLowerCase();
  const ct = contentType.toLowerCase();
  if (lower.endsWith(".pdf") || ct === "application/pdf")
    return { ext: "pdf", contentType: "application/pdf" };
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

/** A short-lived signed download URL (seconds) — the 008 TTL. */
const DOWNLOAD_URL_TTL_SECONDS = 60;

/** GET …/[id]/documents — the append-only history, newest first. */
export async function handleResourceDocumentsList(
  entityType: ResourceDocumentEntityType,
  entityId: string,
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const items = await listResourceDocuments(entityType, entityId);
    return NextResponse.json({ items });
  } catch (error) {
    return handleRouteError(error);
  }
}

/** POST …/[id]/documents — multipart upload (file + meta{docType}). */
export async function handleResourceDocumentUpload(
  entityType: ResourceDocumentEntityType,
  entityId: string,
  request: Request,
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");

    // Reject an oversize body BEFORE buffering it (precise per-file check below as the backstop).
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
      throw new Conflict(
        "UNSUPPORTED_FILE_TYPE",
        "Tipo de arquivo não suportado (use PDF, JPG ou PNG).",
      );
    }
    if (file.size > maxBytes()) {
      throw new Conflict("FILE_TOO_LARGE", "Arquivo muito grande (máximo ~10 MB).");
    }

    const metaRaw = form.get("meta");
    let metaParsed: unknown = {};
    if (typeof metaRaw === "string") {
      try {
        metaParsed = JSON.parse(metaRaw);
      } catch {
        // Malformed meta is a client error: a real 400 (Conflict would map to 409).
        return apiError(400, "VALIDATION", "Metadados do documento inválidos.");
      }
    }
    const meta = uploadResourceDocumentMetaSchema.parse(metaParsed);

    // Preflight the parent (exists + not archived) BEFORE storing — no orphan object.
    await assertResourceDocumentParent(entityType, entityId, { forUpload: true });

    const documentId = randomUUID();
    const key = resourceDocumentStorageKey(entityType, entityId, documentId, inferred.ext);
    const bytes = Buffer.from(await file.arrayBuffer());
    await putDocument(key, bytes, inferred.contentType);

    try {
      const item = await createResourceDocument(
        {
          id: documentId,
          entityType,
          entityId,
          docType: meta.docType,
          // Metadata-only display name; capped so a pathological name never bloats the row/audit.
          fileName: file.name.slice(0, 255),
          contentType: inferred.contentType,
          sizeBytes: file.size,
          fileStorageKey: key,
        },
        ctx.userId,
      );
      return NextResponse.json({ item }, { status: 201 });
    } catch (insertError) {
      // Roll back the stored binary if the metadata insert fails (008 pattern).
      await removeObject(key, documentsBucket());
      throw insertError;
    }
  } catch (error) {
    return handleRouteError(error);
  }
}

/**
 * GET …/[id]/documents/[docId]/download — mints a short-lived signed URL and **302-redirects** to
 * it (the imports error-report pattern), so the UI can use a plain `<a target="_blank">`. This
 * deliberately avoids `{ url }` + client `window.open`, which browsers silently popup-block when
 * the open happens after an `await`. The signed URL never reaches client JS.
 */
export async function handleResourceDocumentDownload(
  entityType: ResourceDocumentEntityType,
  entityId: string,
  documentId: string,
): Promise<NextResponse> {
  try {
    const ctx = await requireAuth();
    requirePermission(ctx, "manage_fleet_data");
    const key = await getResourceDocumentFileKey(entityType, entityId, documentId);
    if (!key) return apiError(404, "NOT_FOUND", "Documento não encontrado.");
    const url = await signedUrl(key, DOWNLOAD_URL_TTL_SECONDS, documentsBucket());
    return NextResponse.redirect(url, 302);
  } catch (error) {
    return handleRouteError(error);
  }
}
