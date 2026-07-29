import { and, asc, eq, inArray, isNotNull, isNull, or } from "drizzle-orm";
import { db, type DB } from "../client";
import { documentRequirements, documentTypes, documents } from "../../schema";
import {
  DEFAULT_DOCUMENT_CHECKLIST,
  evaluateChecklist,
  type CreateDocumentRequirementInput,
  type CreateDocumentTypeInput,
  type RequiredType,
  type UpdateDocumentRequirementInput,
  type UpdateDocumentTypeInput,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { NotFound } from "../errors";

/**
 * Feature 008 — document-requirement + document-type reads (data-model §11, R2). The applicable
 * required-document checklist for a trip drives the completion/Billing-Ready gates and the
 * "missing documents" surfaces. The write CRUD (`createDocumentRequirement`/`createDocumentType`/…)
 * lands in US3; these foundational reads are needed by every story. (`db` or a `tx` may be passed.)
 */

type Querier = Pick<DB, "select">;

/** The minimal trip facts the requirement/rate resolvers scope on. */
export interface TripScope {
  id: string;
  customerId: string;
  laneId: string | null;
  plannedVehicleType: string | null;
}

/** A resolved required document type with its display labels (for the missing-document list). */
export interface DocRef {
  documentTypeId: string;
  code: string;
  labelPt: string;
}

export interface ChecklistStatus {
  /** The applicable required types for the trip (merged by type id; additive scope). */
  required: RequiredType[];
  /** Display refs for every required type id. */
  refs: Map<string, DocRef>;
  /** Required type ids still unmet for completion / for billing (after accepted-or-waived). */
  completionMissing: DocRef[];
  billingMissing: DocRef[];
  /** True when the customer has explicit document_requirements rows; false ⇒ running on DEFAULT
   * (and document-checklist sign-off is reported blocked — §29 Input #3). */
  hasExplicitChecklist: boolean;
}

/**
 * Resolve the applicable required document types for a trip (R2): the active `document_requirements`
 * rows whose scope matches (unscoped OR lane match OR vehicle-type match — additive), merged by
 * `document_type_id` (OR-ing the completion/billing flags). When the customer has NO active rows,
 * fall back to `DEFAULT_DOCUMENT_CHECKLIST` (resolved to type ids via `document_types.code`).
 */
export async function resolveRequiredTypes(
  trip: Pick<TripScope, "customerId" | "laneId" | "plannedVehicleType">,
  executor: Querier = db,
): Promise<RequiredType[]> {
  const rows = await executor
    .select({
      documentTypeId: documentRequirements.documentTypeId,
      requiredForCompletion: documentRequirements.requiredForCompletion,
      requiredForBilling: documentRequirements.requiredForBilling,
      laneId: documentRequirements.laneId,
      vehicleType: documentRequirements.vehicleType,
    })
    .from(documentRequirements)
    .where(
      and(
        eq(documentRequirements.customerId, trip.customerId),
        eq(documentRequirements.active, true),
      ),
    );

  if (rows.length === 0) {
    // No per-customer checklist → the labeled-configurable DEFAULT (resolved code → type id).
    const codes = DEFAULT_DOCUMENT_CHECKLIST.map((c) => c.typeCode);
    const typeRows = await executor
      .select({ id: documentTypes.id, code: documentTypes.code })
      .from(documentTypes)
      .where(inArray(documentTypes.code, codes));
    const byCode = new Map(typeRows.map((t) => [t.code, t.id]));
    return DEFAULT_DOCUMENT_CHECKLIST.flatMap((c) => {
      const id = byCode.get(c.typeCode);
      return id
        ? [
            {
              documentTypeId: id,
              requiredForCompletion: c.requiredForCompletion,
              requiredForBilling: c.requiredForBilling,
            },
          ]
        : [];
    });
  }

  // Scope-match in JS (avoids nullable-equality SQL pitfalls), then merge by type id (additive).
  const applicable = rows.filter(
    (r) =>
      (r.laneId == null || r.laneId === trip.laneId) &&
      (r.vehicleType == null || r.vehicleType === trip.plannedVehicleType),
  );
  const merged = new Map<string, RequiredType>();
  for (const r of applicable) {
    const ex = merged.get(r.documentTypeId);
    if (ex) {
      ex.requiredForCompletion = ex.requiredForCompletion || r.requiredForCompletion;
      ex.requiredForBilling = ex.requiredForBilling || r.requiredForBilling;
    } else {
      merged.set(r.documentTypeId, {
        documentTypeId: r.documentTypeId,
        requiredForCompletion: r.requiredForCompletion,
        requiredForBilling: r.requiredForBilling,
      });
    }
  }
  return [...merged.values()];
}

/** The set of document-type ids satisfied for a trip: a non-archived accepted upload OR a waiver. */
export async function satisfiedDocumentTypeIds(
  tripId: string,
  executor: Querier = db,
): Promise<Set<string>> {
  const rows = await executor
    .select({ typeId: documents.documentTypeId })
    .from(documents)
    .where(
      and(
        eq(documents.tripId, tripId),
        isNull(documents.archivedAt),
        or(eq(documents.verificationStatus, "accepted"), isNotNull(documents.waivedAt)),
      ),
    );
  return new Set(rows.map((r) => r.typeId));
}

/**
 * The full document-checklist status for a trip: required types (+ display refs), the unmet
 * completion/billing sets (after accepted-or-waived), and whether the customer has an explicit
 * checklist (false ⇒ running on DEFAULT, sign-off blocked). Used by the gates + the read models.
 */
export async function loadChecklistStatus(
  trip: TripScope,
  executor: Querier = db,
): Promise<ChecklistStatus> {
  const required = await resolveRequiredTypes(trip, executor);
  const satisfied = await satisfiedDocumentTypeIds(trip.id, executor);

  // Display refs for every required type id.
  const ids = required.map((r) => r.documentTypeId);
  const refRows = ids.length
    ? await executor
        .select({ id: documentTypes.id, code: documentTypes.code, labelPt: documentTypes.labelPt })
        .from(documentTypes)
        .where(inArray(documentTypes.id, ids))
    : [];
  const refs = new Map<string, DocRef>(
    refRows.map((r) => [r.id, { documentTypeId: r.id, code: r.code, labelPt: r.labelPt }]),
  );

  const { completionMissing, billingMissing } = evaluateChecklist(required, satisfied);
  const toRef = (id: string): DocRef =>
    refs.get(id) ?? { documentTypeId: id, code: id, labelPt: id };

  // hasExplicitChecklist: any active row for the customer (independent of scope match).
  const explicit = await executor
    .select({ id: documentRequirements.id })
    .from(documentRequirements)
    .where(
      and(
        eq(documentRequirements.customerId, trip.customerId),
        eq(documentRequirements.active, true),
      ),
    )
    .limit(1);

  return {
    required,
    refs,
    completionMissing: completionMissing.map(toRef),
    billingMissing: billingMissing.map(toRef),
    hasExplicitChecklist: explicit.length > 0,
  };
}

/** All document types (admin list + upload type picker), newest-config first by sort order. */
export async function listDocumentTypes(executor: Querier = db) {
  return executor
    .select()
    .from(documentTypes)
    .orderBy(asc(documentTypes.sortOrder), asc(documentTypes.code));
}

/** A customer's document-requirement checklist rows (admin list). */
export async function listDocumentRequirements(customerId?: string, executor: Querier = db) {
  const base = executor.select().from(documentRequirements);
  const rows = customerId
    ? await base.where(eq(documentRequirements.customerId, customerId))
    : await base;
  return rows;
}

// ---------------------------------------------------------------------------
// CRUD (US3) — config administered via `manage_commercial_data`, audited
// ---------------------------------------------------------------------------

export async function createDocumentRequirement(
  input: CreateDocumentRequirementInput,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(documentRequirements)
      .values({
        customerId: input.customerId,
        documentTypeId: input.documentTypeId,
        requiredForCompletion: input.requiredForCompletion,
        requiredForBilling: input.requiredForBilling,
        laneId: input.laneId ?? null,
        vehicleType: input.vehicleType ?? null,
        active: input.active,
      })
      .returning();
    await writeAudit(tx, {
      entityType: "document_requirement",
      entityId: inserted[0]!.id,
      action: "document_requirement.create",
      previousValue: null,
      newValue: inserted[0]!,
      actorUserId,
    });
    return inserted[0]!;
  });
}

export async function updateDocumentRequirement(
  id: string,
  input: UpdateDocumentRequirementInput,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(documentRequirements)
      .set({
        ...(input.requiredForCompletion !== undefined
          ? { requiredForCompletion: input.requiredForCompletion }
          : {}),
        ...(input.requiredForBilling !== undefined
          ? { requiredForBilling: input.requiredForBilling }
          : {}),
        ...(input.laneId !== undefined ? { laneId: input.laneId ?? null } : {}),
        ...(input.vehicleType !== undefined ? { vehicleType: input.vehicleType ?? null } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        updatedAt: new Date(),
      })
      .where(eq(documentRequirements.id, id))
      .returning();
    if (!updated[0]) throw new NotFound("NOT_FOUND", "Requisito de documento não encontrado.");
    await writeAudit(tx, {
      entityType: "document_requirement",
      entityId: id,
      action: "document_requirement.update",
      previousValue: null,
      newValue: updated[0],
      actorUserId,
    });
    return updated[0];
  });
}

export async function createDocumentType(input: CreateDocumentTypeInput, actorUserId: string) {
  return db.transaction(async (tx) => {
    const inserted = await tx
      .insert(documentTypes)
      .values({
        code: input.code,
        labelPt: input.labelPt,
        active: input.active,
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
      })
      .returning();
    await writeAudit(tx, {
      entityType: "document_type",
      entityId: inserted[0]!.id,
      action: "document_type.create",
      previousValue: null,
      newValue: inserted[0]!,
      actorUserId,
    });
    return inserted[0]!;
  });
}

export async function updateDocumentType(
  id: string,
  input: UpdateDocumentTypeInput,
  actorUserId: string,
) {
  return db.transaction(async (tx) => {
    const updated = await tx
      .update(documentTypes)
      .set({
        ...(input.code !== undefined ? { code: input.code } : {}),
        ...(input.labelPt !== undefined ? { labelPt: input.labelPt } : {}),
        ...(input.active !== undefined ? { active: input.active } : {}),
        ...(input.sortOrder !== undefined ? { sortOrder: input.sortOrder } : {}),
        updatedAt: new Date(),
      })
      .where(eq(documentTypes.id, id))
      .returning();
    if (!updated[0]) throw new NotFound("NOT_FOUND", "Tipo de documento não encontrado.");
    await writeAudit(tx, {
      entityType: "document_type",
      entityId: id,
      action: "document_type.update",
      previousValue: null,
      newValue: updated[0],
      actorUserId,
    });
    return updated[0];
  });
}
