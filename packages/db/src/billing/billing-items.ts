import { and, asc, eq, isNull } from "drizzle-orm";
import { db, type DB } from "../client";
import { billingAdjustments, billingItems, trips } from "../../schema";
import {
  computeBillingValues,
  type AddBillingAdjustmentInput,
  type AdjustmentInput,
  type UpdateBillingItemInput,
} from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict, NotFound } from "../errors";
import { resolveRate } from "./rates";
import { loadChecklistStatus, type ChecklistStatus, type DocRef, type TripScope } from "../documents/requirements";

/**
 * Feature 008 — billing-item reads + lifecycle helpers (data-model §11, R5/R7). `ensureBillingItem`
 * creates the one-per-trip row at billing-phase entry (auto-priced from the resolved rate, period =
 * month of completion in America/Sao_Paulo). `loadBillingItemView` returns the item + its LIVE
 * adjustments + the DERIVED planned/executed/adjustment/final values (`computeBillingValues`, never
 * stored) + the missing-document summaries. The mutations (`updateBillingItem`/`addBillingAdjustment`/
 * `removeBillingAdjustment`) land in US4.
 */

type Querier = Pick<DB, "select">;
type TxLike = Pick<DB, "select" | "insert">;

export interface BillingAdjustmentDto {
  id: string;
  type: string;
  amountCents: number;
  note: string | null;
  createdByUserId: string;
  createdAt: string;
}

export interface BillingItemView {
  id: string;
  tripId: string;
  customerId: string;
  rateId: string | null;
  baseFreightCents: number | null;
  currency: string;
  billingPeriod: string;
  disputeStatus: string;
  exportBatchId: string | null;
  notes: string | null;
  adjustments: BillingAdjustmentDto[];
  /** Derived values (BILL-005, FR-017) — never stored. */
  plannedCents: number | null;
  executedCents: number | null;
  adjustmentCents: number;
  finalBillableCents: number | null;
  /** Unmet required-for-billing / required-for-completion documents (with labels). */
  missingBillingDocuments: DocRef[];
  missingCompletionDocuments: DocRef[];
  /** A rate matched (false ⇒ manual amount + billing-rule sign-off blocked, §29 Input #5). */
  hasRate: boolean;
  /** The customer has an explicit document checklist (false ⇒ sign-off blocked, §29 Input #3). */
  checklistSignedOff: boolean;
}

/** Month of a timestamp in the canonical business timezone, as `YYYY-MM` (no Luxon dependency in db). */
export function billingPeriodSaoPaulo(d: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/Sao_Paulo",
    year: "numeric",
    month: "2-digit",
  }).formatToParts(d);
  const year = parts.find((p) => p.type === "year")?.value ?? "";
  const month = parts.find((p) => p.type === "month")?.value ?? "";
  return `${year}-${month}`;
}

/**
 * Insert the one `billing_items` row for a trip if absent (R7). `billing_period` = the calendar month
 * of completion in America/Sao_Paulo; `base_freight_cents`/`rate_id` from the resolved rate (or null —
 * a manual amount + billing-rule sign-off blocked). Idempotent: a row already present → no-op.
 */
export async function ensureBillingItem(tx: TxLike, tripId: string): Promise<void> {
  const existing = await tx
    .select({ id: billingItems.id })
    .from(billingItems)
    .where(eq(billingItems.tripId, tripId))
    .limit(1);
  if (existing[0]) return;

  const tripRows = await tx
    .select({
      id: trips.id,
      customerId: trips.customerId,
      laneId: trips.laneId,
      plannedVehicleType: trips.plannedVehicleType,
      plannedPickupWindowStart: trips.plannedPickupWindowStart,
    })
    .from(trips)
    .where(eq(trips.id, tripId))
    .limit(1);
  const trip = tripRows[0];
  if (!trip) throw new Conflict("NOT_FOUND", "Viagem não encontrada.");

  const rate = await resolveRate(trip, tx);

  await tx.insert(billingItems).values({
    tripId,
    customerId: trip.customerId,
    rateId: rate?.id ?? null,
    baseFreightCents: rate?.baseAmountCents ?? null,
    billingPeriod: billingPeriodSaoPaulo(new Date()),
  });
}

/**
 * The full billing view for a trip (item + live adjustments + computed values + missing-doc summary),
 * or null when no billing item exists yet (trip not in billing phase). Pass a precomputed checklist
 * status to avoid re-querying it when the caller already has it (`loadTripDetail`).
 */
export async function loadBillingItemView(
  executor: Querier,
  tripId: string,
  checklist?: ChecklistStatus,
): Promise<BillingItemView | null> {
  const itemRows = await executor
    .select()
    .from(billingItems)
    .where(eq(billingItems.tripId, tripId))
    .limit(1);
  const item = itemRows[0];
  if (!item) return null;

  const adjRows = await executor
    .select()
    .from(billingAdjustments)
    .where(and(eq(billingAdjustments.billingItemId, item.id), isNull(billingAdjustments.removedAt)))
    .orderBy(asc(billingAdjustments.createdAt));

  const adjustmentInputs: AdjustmentInput[] = adjRows.map((a) => ({
    type: a.type,
    amountCents: a.amountCents,
  }));
  const values = computeBillingValues(item.baseFreightCents, adjustmentInputs);

  // Missing-document summary (resolve the checklist if not supplied).
  let status = checklist;
  if (!status) {
    const tripRows = await executor
      .select({
        id: trips.id,
        customerId: trips.customerId,
        laneId: trips.laneId,
        plannedVehicleType: trips.plannedVehicleType,
      })
      .from(trips)
      .where(eq(trips.id, tripId))
      .limit(1);
    const trip = tripRows[0] as TripScope | undefined;
    status = trip ? await loadChecklistStatus(trip, executor) : undefined;
  }

  return {
    id: item.id,
    tripId: item.tripId,
    customerId: item.customerId,
    rateId: item.rateId,
    baseFreightCents: item.baseFreightCents,
    currency: item.currency,
    billingPeriod: item.billingPeriod,
    disputeStatus: item.disputeStatus,
    exportBatchId: item.exportBatchId,
    notes: item.notes,
    adjustments: adjRows.map((a) => ({
      id: a.id,
      type: a.type,
      amountCents: a.amountCents,
      note: a.note,
      createdByUserId: a.createdByUserId,
      createdAt: a.createdAt.toISOString(),
    })),
    plannedCents: values.plannedCents,
    executedCents: values.executedCents,
    adjustmentCents: values.adjustmentCents,
    finalBillableCents: values.finalBillableCents,
    missingBillingDocuments: status?.billingMissing ?? [],
    missingCompletionDocuments: status?.completionMissing ?? [],
    hasRate: item.rateId != null,
    checklistSignedOff: status?.hasExplicitChecklist ?? false,
  };
}

// ---------------------------------------------------------------------------
// Mutations (US4) — `edit_rates`, audited (billing_item.update)
// ---------------------------------------------------------------------------

async function billingItemIdForTrip(executor: Querier, tripId: string): Promise<string> {
  const rows = await executor
    .select({ id: billingItems.id })
    .from(billingItems)
    .where(eq(billingItems.tripId, tripId))
    .limit(1);
  if (!rows[0]) throw new NotFound("NOT_FOUND", "Item de faturamento não encontrado.");
  return rows[0].id;
}

async function reloadView(tripId: string): Promise<BillingItemView> {
  const view = await loadBillingItemView(db, tripId);
  if (!view) throw new NotFound("NOT_FOUND", "Item de faturamento não encontrado.");
  return view;
}

/** Set the manual base / period / dispute / notes on a trip's billing item. */
export async function updateBillingItem(
  tripId: string,
  input: UpdateBillingItemInput,
  actorUserId: string,
): Promise<BillingItemView> {
  const itemId = await billingItemIdForTrip(db, tripId);
  await db.transaction(async (tx) => {
    await tx
      .update(billingItems)
      .set({
        ...(input.baseFreightCents !== undefined ? { baseFreightCents: input.baseFreightCents } : {}),
        ...(input.billingPeriod !== undefined ? { billingPeriod: input.billingPeriod } : {}),
        ...(input.disputeStatus !== undefined ? { disputeStatus: input.disputeStatus } : {}),
        ...(input.notes !== undefined ? { notes: input.notes ?? null } : {}),
        updatedAt: new Date(),
      })
      .where(eq(billingItems.id, itemId));
    await writeAudit(tx, {
      entityType: "billing_item",
      entityId: itemId,
      action: "billing_item.update",
      previousValue: null,
      newValue: { tripId, ...input },
      actorUserId,
    });
  });
  return reloadView(tripId);
}

/** Add a typed adjustment to a trip's billing item. */
export async function addBillingAdjustment(
  tripId: string,
  input: AddBillingAdjustmentInput,
  actorUserId: string,
): Promise<BillingItemView> {
  const itemId = await billingItemIdForTrip(db, tripId);
  await db.transaction(async (tx) => {
    await tx.insert(billingAdjustments).values({
      billingItemId: itemId,
      type: input.type,
      amountCents: input.amountCents,
      note: input.note ?? null,
      createdByUserId: actorUserId,
    });
    await writeAudit(tx, {
      entityType: "billing_item",
      entityId: itemId,
      action: "billing_item.update",
      previousValue: null,
      newValue: { tripId, addedAdjustment: { type: input.type, amountCents: input.amountCents } },
      actorUserId,
    });
  });
  return reloadView(tripId);
}

/** Soft-remove an adjustment (never hard-delete a financial row — Constitution III). */
export async function removeBillingAdjustment(
  adjustmentId: string,
  actorUserId: string,
): Promise<BillingItemView> {
  const rows = await db
    .select({ itemId: billingAdjustments.billingItemId })
    .from(billingAdjustments)
    .where(eq(billingAdjustments.id, adjustmentId))
    .limit(1);
  if (!rows[0]) throw new NotFound("NOT_FOUND", "Ajuste não encontrado.");
  const itemId = rows[0].itemId;
  const tripRows = await db
    .select({ tripId: billingItems.tripId })
    .from(billingItems)
    .where(eq(billingItems.id, itemId))
    .limit(1);
  const tripId = tripRows[0]!.tripId;

  await db.transaction(async (tx) => {
    await tx
      .update(billingAdjustments)
      .set({ removedAt: new Date(), removedByUserId: actorUserId })
      .where(eq(billingAdjustments.id, adjustmentId));
    await writeAudit(tx, {
      entityType: "billing_item",
      entityId: itemId,
      action: "billing_item.update",
      previousValue: null,
      newValue: { tripId, removedAdjustmentId: adjustmentId },
      actorUserId,
    });
  });
  return reloadView(tripId);
}
