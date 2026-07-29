import "server-only";
import { and, desc, eq } from "drizzle-orm";
import { db, drivers, resourceDocuments, vehicles } from "@brazil-tms/db";
import type {
  AuditAction,
  ResourceDocumentDto,
  ResourceDocumentEntityType,
} from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict, NotFound } from "@/lib/api/respond";

/**
 * Slice 025 (issue #32 [0009]) — registry attachments for drivers/vehicles ("Documentos" tab).
 * APPEND-ONLY: list + insert(+audit, same tx) + file-key lookup; no update/delete surface (the
 * history is the product requirement). The route validates the FILE (type/size) and stores the
 * binary; this service owns the DB side: parent preflight (exists + not archived → 404/409 before
 * anything is stored), metadata insert, and the `<entity>.document_upload` audit entry.
 */

interface ResourceDocumentRow {
  id: string;
  entityType: ResourceDocumentEntityType;
  entityId: string;
  docType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  fileStorageKey: string;
  uploadedByUserId: string;
  createdAt: Date;
}

function toDto(row: ResourceDocumentRow): ResourceDocumentDto {
  return {
    id: row.id,
    entityType: row.entityType,
    entityId: row.entityId,
    docType: row.docType,
    fileName: row.fileName,
    contentType: row.contentType,
    sizeBytes: row.sizeBytes,
    uploadedByUserId: row.uploadedByUserId,
    createdAt: row.createdAt.toISOString(),
  };
}

const NOT_FOUND_MESSAGE: Record<ResourceDocumentEntityType, string> = {
  driver: "Motorista não encontrado.",
  vehicle: "Veículo não encontrado.",
};

const UPLOAD_AUDIT_ACTION: Record<ResourceDocumentEntityType, AuditAction> = {
  driver: "driver.document_upload",
  vehicle: "vehicle.document_upload",
};

/**
 * Preflight the parent registry row. Missing → 404-style NOT_FOUND Conflict; archived → 409
 * ARCHIVED_RESOURCE when uploading (`forUpload`) — an archived registry must not grow, but its
 * existing history stays listable/downloadable.
 */
export async function assertResourceDocumentParent(
  entityType: ResourceDocumentEntityType,
  entityId: string,
  opts: { forUpload: boolean },
): Promise<void> {
  const table = entityType === "driver" ? drivers : vehicles;
  const rows = await db
    .select({ archivedAt: table.archivedAt })
    .from(table)
    .where(eq(table.id, entityId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new NotFound("NOT_FOUND", NOT_FOUND_MESSAGE[entityType]);
  if (opts.forUpload && row.archivedAt !== null) {
    throw new Conflict("ARCHIVED_RESOURCE", "Recurso arquivado não recebe novos documentos.");
  }
}

/** History, newest first. */
export async function listResourceDocuments(
  entityType: ResourceDocumentEntityType,
  entityId: string,
): Promise<ResourceDocumentDto[]> {
  await assertResourceDocumentParent(entityType, entityId, { forUpload: false });
  const rows = await db
    .select()
    .from(resourceDocuments)
    .where(
      and(
        eq(resourceDocuments.entityType, entityType),
        eq(resourceDocuments.entityId, entityId),
      ),
    )
    // id as the tiebreaker — same-microsecond uploads keep a stable, deterministic order.
    .orderBy(desc(resourceDocuments.createdAt), desc(resourceDocuments.id));
  return rows.map(toDto);
}

export interface CreateResourceDocumentInput {
  /** Pre-generated id — the route derives the storage key from it BEFORE inserting. */
  id: string;
  entityType: ResourceDocumentEntityType;
  entityId: string;
  docType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  fileStorageKey: string;
}

/**
 * Insert the metadata row + the audit entry in ONE transaction (the binary is already stored).
 * The parent is RE-CHECKED here under a row lock: the route's preflight runs before the Storage
 * upload, so a concurrent archive could land in between — `FOR UPDATE` serializes against the
 * archive's row UPDATE and guarantees no document is attached to an archived resource. On throw,
 * the route rolls the stored binary back.
 */
export async function createResourceDocument(
  input: CreateResourceDocumentInput,
  actorUserId: string,
): Promise<ResourceDocumentDto> {
  return db.transaction(async (tx) => {
    const table = input.entityType === "driver" ? drivers : vehicles;
    const parent = await tx
      .select({ archivedAt: table.archivedAt })
      .from(table)
      .where(eq(table.id, input.entityId))
      .limit(1)
      .for("update");
    if (!parent[0]) throw new NotFound("NOT_FOUND", NOT_FOUND_MESSAGE[input.entityType]);
    if (parent[0].archivedAt !== null) {
      throw new Conflict("ARCHIVED_RESOURCE", "Recurso arquivado não recebe novos documentos.");
    }

    const inserted = await tx
      .insert(resourceDocuments)
      .values({ ...input, uploadedByUserId: actorUserId })
      .returning();
    const row = inserted[0];
    if (!row) throw new Error("Inserção de documento não retornou linha.");
    await writeAudit(tx, {
      entityType: input.entityType,
      entityId: input.entityId,
      action: UPLOAD_AUDIT_ACTION[input.entityType],
      previousValue: null,
      newValue: { docType: input.docType, fileName: input.fileName, documentId: input.id },
      actorUserId,
    });
    return toDto(row);
  });
}

/** Storage key of one history entry (download route) — null when the entry does not match. */
export async function getResourceDocumentFileKey(
  entityType: ResourceDocumentEntityType,
  entityId: string,
  documentId: string,
): Promise<string | null> {
  const rows = await db
    .select({ fileStorageKey: resourceDocuments.fileStorageKey })
    .from(resourceDocuments)
    .where(
      and(
        eq(resourceDocuments.id, documentId),
        eq(resourceDocuments.entityType, entityType),
        eq(resourceDocuments.entityId, entityId),
      ),
    )
    .limit(1);
  return rows[0]?.fileStorageKey ?? null;
}
