import { and, eq, isNull } from "drizzle-orm";
import { db } from "../client";
import { documents, documentTypes, trips } from "../../schema";
import type { DocumentVerificationStatus } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict, NotFound } from "../errors";
import { loadTripDetail, type TripDetail } from "../trips/trip-dto";

/**
 * Feature 008 — document services (data-model §11, US1). Mirror `trip-transitions.ts`: a transaction
 * doing the row write + `writeAudit(tx, …)`, returning the reloaded `loadTripDetail`. The binary is put
 * to Storage by the BFF route BEFORE this is called (R9); the service only persists metadata. Conflicts
 * `throw new Conflict(CODE, "pt-BR message")`. Waivers are written by the completion service (US2).
 */

interface UploadDocumentInput {
  /** Pre-generated id so the route can derive the storage key before the row exists. */
  id?: string;
  documentTypeId: string;
  /** Storage key of the uploaded binary (null only for a waiver — written elsewhere). */
  fileStorageKey: string;
  externalReference?: string | null;
  notes?: string | null;
}

/**
 * Preflight the DB references BEFORE the route stores the binary (R9): the trip must exist (else 404)
 * and the document type must be active (else `INVALID_DOCUMENT_TYPE` 409). This prevents an orphan
 * Storage object (and a 500 from the trips FK) when the metadata insert would have failed anyway.
 */
export async function assertUploadable(tripId: string, documentTypeId: string): Promise<void> {
  const tripRows = await db.select({ id: trips.id }).from(trips).where(eq(trips.id, tripId)).limit(1);
  if (!tripRows[0]) throw new NotFound("NOT_FOUND", "Viagem não encontrada.");
  const typeRows = await db
    .select({ active: documentTypes.active })
    .from(documentTypes)
    .where(eq(documentTypes.id, documentTypeId))
    .limit(1);
  if (!typeRows[0] || !typeRows[0].active) {
    throw new Conflict("INVALID_DOCUMENT_TYPE", "Tipo de documento inválido ou inativo.");
  }
}

async function reload(tx: Parameters<typeof loadTripDetail>[0], tripId: string): Promise<TripDetail> {
  const detail = await loadTripDetail(tx, tripId);
  if (!detail) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");
  return detail;
}

/** Attach a proof document to a trip (`pending_review`). Unknown/inactive type ⇒ INVALID_DOCUMENT_TYPE. */
export async function uploadDocument(
  tripId: string,
  input: UploadDocumentInput,
  actorUserId: string,
): Promise<TripDetail> {
  const typeRows = await db
    .select({ id: documentTypes.id, active: documentTypes.active })
    .from(documentTypes)
    .where(eq(documentTypes.id, input.documentTypeId))
    .limit(1);
  const type = typeRows[0];
  if (!type || !type.active) {
    throw new Conflict("INVALID_DOCUMENT_TYPE", "Tipo de documento inválido ou inativo.");
  }

  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(documents)
      .values({
        ...(input.id ? { id: input.id } : {}),
        tripId,
        documentTypeId: input.documentTypeId,
        fileStorageKey: input.fileStorageKey,
        externalReference: input.externalReference ?? null,
        uploadedByUserId: actorUserId,
        notes: input.notes ?? null,
      })
      .returning({ id: documents.id });

    await writeAudit(tx, {
      entityType: "document",
      entityId: inserted[0]!.id,
      action: "document.upload",
      previousValue: null,
      newValue: { tripId, documentTypeId: input.documentTypeId, verificationStatus: "pending_review" },
      actorUserId,
    });

    return reload(tx, tripId);
  });
}

/** The non-archived document's storage key for a signed download, or null (missing / waiver row). */
export async function getDocumentFileKey(
  tripId: string,
  documentId: string,
): Promise<string | null> {
  const rows = await db
    .select({ key: documents.fileStorageKey })
    .from(documents)
    .where(
      and(
        eq(documents.id, documentId),
        eq(documents.tripId, tripId),
        isNull(documents.archivedAt),
      ),
    )
    .limit(1);
  return rows[0]?.key ?? null;
}

/** Verify a document (accept / reject / pending) — records verifier + timestamp. */
export async function verifyDocument(
  documentId: string,
  input: { verificationStatus: DocumentVerificationStatus; notes?: string | null },
  actorUserId: string,
): Promise<TripDetail> {
  const rows = await db
    .select({ tripId: documents.tripId, prev: documents.verificationStatus })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Documento não encontrado.");

  return db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({
        verificationStatus: input.verificationStatus,
        verifiedByUserId: actorUserId,
        verifiedAt: new Date(),
        ...(input.notes != null ? { notes: input.notes } : {}),
        updatedAt: new Date(),
      })
      .where(eq(documents.id, documentId));

    await writeAudit(tx, {
      entityType: "document",
      entityId: documentId,
      action: "document.verify",
      previousValue: { verificationStatus: row.prev },
      newValue: { verificationStatus: input.verificationStatus },
      actorUserId,
    });

    return reload(tx, row.tripId);
  });
}

/** Archive a document (soft-delete) — never hard-delete (Constitution III). */
export async function archiveDocument(documentId: string, actorUserId: string): Promise<TripDetail> {
  const rows = await db
    .select({ tripId: documents.tripId, archivedAt: documents.archivedAt })
    .from(documents)
    .where(eq(documents.id, documentId))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Documento não encontrado.");

  return db.transaction(async (tx) => {
    await tx
      .update(documents)
      .set({ archivedAt: new Date(), updatedAt: new Date() })
      .where(and(eq(documents.id, documentId)));

    await writeAudit(tx, {
      entityType: "document",
      entityId: documentId,
      action: "document.archive",
      previousValue: { archivedAt: row.archivedAt },
      newValue: { archivedAt: new Date().toISOString() },
      actorUserId,
    });

    return reload(tx, row.tripId);
  });
}
