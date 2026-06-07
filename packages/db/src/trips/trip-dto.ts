import { alias } from "drizzle-orm/pg-core";
import { and, desc, eq, isNull } from "drizzle-orm";
import {
  alerts,
  auditLogs,
  carriers,
  documentTypes,
  documents,
  drivers,
  exceptions,
  reasonCodes,
  tripAssignments,
  tripEvents,
  tripStatus,
  trailers,
  trips,
  users,
  vehicles,
} from "../../schema";
import type { DB } from "../client";
import {
  billingStatus,
  type AuditAction,
  type BillingStatus,
  type ResponsibleParty,
  type TripEventSource,
  type TripEventType,
  type TripStatus,
} from "@brazil-tms/shared";
import { loadChecklistStatus, type DocRef, type TripScope } from "../documents/requirements";
import { loadBillingItemView, type BillingItemView } from "../billing/billing-items";

export type { BillingItemView, BillingAdjustmentDto } from "../billing/billing-items";
export type { DocRef } from "../documents/requirements";

/**
 * Shared trip DTO mapping + detail loader for the feature 003 trip services (contract:
 * contracts/bff-endpoints.md §Shared returned shapes). Every mutating service (createTrip,
 * updateTripPlan, transitionTripStatus, cancelTrip) and the read-only inspector return the SAME
 * `TripDetail`/`TripSummary` shape, so the mapping lives here once (DRY — four producers, well past
 * the ≥3 threshold). `billingStatus` is the derived projection (R3); there is no stored column.
 *
 * `loadTripDetail` accepts either the live `db` or a transaction handle (`tx`) so a mutation can
 * return the freshly-written detail inside its own transaction.
 */

/** Anything that can run a `select` — the live `db` or a `tx`. */
type Querier = Pick<DB, "select">;

export type { BillingStatus } from "@brazil-tms/shared";

export interface TripSummary {
  id: string;
  customerId: string;
  externalTripId: string | null;
  originLocationId: string;
  destinationLocationId: string;
  laneId: string | null;
  currentStatus: TripStatus;
  billingStatus: BillingStatus;
  slaStatus: string | null;
  slaReasons: string[] | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * The physical `trip_status` domain (18 members) — `trip_events` is immutable history that MAY still
 * carry the slice-015 dormant values (`validation_error`/`validated`) on rows written before the
 * collapse, even though no live writer produces them. The ACTIVE machine (`TripStatus`) is 16; this
 * history-reader type admits the two dormant values so event DTOs reflect what is physically stored.
 * The timeline renders these defensively (raw string for any non-active status — no i18n key needed).
 */
export type TripEventStatus = (typeof tripStatus.enumValues)[number];

export interface TripEventDto {
  id: string;
  eventType: TripEventType;
  statusBefore: TripEventStatus | null;
  statusAfter: TripEventStatus | null;
  eventTimestamp: string | null;
  source: TripEventSource;
  actorUserId: string | null;
  locationId: string | null;
  notes: string | null;
  exceptionId: string | null;
  createdAt: string;
}

/**
 * Feature 007 — an exception on the trip detail (FR-008..FR-012). Joins `reason_codes` for the DERIVED
 * `category`/`reasonLabelPt` (never stored on the exception) and the owner's display name.
 */
export interface ExceptionDto {
  id: string;
  reasonCodeId: string;
  reasonCode: string;
  category: string;
  reasonLabelPt: string;
  severity: string;
  status: string;
  responsibleParty: string;
  ownerUserId: string;
  ownerName: string | null;
  description: string;
  openedAt: string;
  resolvedAt: string | null;
  closureNotes: string | null;
  createdByUserId: string;
  createdAt: string;
  updatedAt: string;
}

/** Feature 007 — an in-app alert on the trip detail (active/acknowledged/resolved, FR-023/024). */
export interface AlertDto {
  id: string;
  tripId: string;
  alertCase: string;
  severity: string;
  state: string;
  createdAt: string;
  acknowledgedByUserId: string | null;
  acknowledgedByName: string | null;
  acknowledgedAt: string | null;
  autoResolvedAt: string | null;
}

export interface AuditEntryDto {
  id: string;
  action: AuditAction;
  previousValue: unknown;
  newValue: unknown;
  actorUserId: string;
  reason: string | null;
  createdAt: string;
}

/** Feature 008 — a proof document (or waiver) on the trip detail (DOC-001/002/004/006; waiver R3). */
export interface DocumentDto {
  id: string;
  tripId: string;
  documentTypeId: string;
  documentTypeCode: string;
  documentTypeLabelPt: string;
  fileStorageKey: string | null;
  externalReference: string | null;
  verificationStatus: string;
  verifiedByUserId: string | null;
  verifiedAt: string | null;
  waivedAt: string | null;
  waivedReason: string | null;
  waivedByUserId: string | null;
  notes: string | null;
  uploadedByUserId: string;
  isWaiver: boolean;
  createdAt: string;
}

/** Feature 008 — the trip's required-document checklist status (drives the missing-document list). */
export interface DocumentSummary {
  completionMissing: DocRef[];
  billingMissing: DocRef[];
  /** False ⇒ the customer has no explicit checklist (running on DEFAULT; sign-off blocked). */
  checklistSignedOff: boolean;
}

/**
 * A trip-assignment row projected for the detail view (data-model.md §1, §5). Joins the resource name
 * tables so the client renders driver/vehicle/trailer/carrier labels without a second lookup. The SAME
 * shape carries both the single `currentAssignment` (the `is_current` row) and each entry of
 * `assignmentHistory` (superseded rows). All timestamps are ISO strings (UTC).
 */
export interface TripAssignmentDto {
  id: string;
  driverId: string | null;
  driverName: string | null;
  vehicleId: string | null;
  vehiclePlate: string | null;
  trailerId: string | null;
  trailerLabel: string | null;
  carrierId: string | null;
  carrierName: string | null;
  notes: string | null;
  overrideReason: string | null;
  isCurrent: boolean;
  assignedByUserId: string;
  assignedAt: string;
  confirmedByUserId: string | null;
  confirmedAt: string | null;
  supersededByAssignmentId: string | null;
  supersededAt: string | null;
}

export interface TripDetail extends TripSummary {
  originalPlan: unknown;
  plannedPickupWindowStart: string | null;
  plannedPickupWindowEnd: string | null;
  plannedDeliveryWindowStart: string | null;
  plannedDeliveryWindowEnd: string | null;
  plannedVehicleType: string | null;
  plannedVolumeUnits: number | null;
  plannedWeightKg: number | null;
  plannedPalletCount: number | null;
  plannedRouteNotes: string | null;
  plannedServiceRequirements: unknown;
  cancellationReasonCode: string | null;
  cancellationResponsibleParty: ResponsibleParty | null;
  cancellationBillingImpact: string | null;
  cancelledAt: string | null;
  disputedFromStatus: TripStatus | null;
  events: TripEventDto[];
  audit: AuditEntryDto[];
  /** The single current (`is_current`) assignment for this trip, or null when none (006). */
  currentAssignment: TripAssignmentDto | null;
  /** Superseded assignment rows (`is_current=false`), newest-first — retained history (006). */
  assignmentHistory: TripAssignmentDto[];
  /** Feature 007 — the trip's exceptions, newest-first (opened_at). */
  exceptions: ExceptionDto[];
  /** Feature 007 — the trip's in-app alerts, newest-first (created_at). */
  alerts: AlertDto[];
  /** Feature 008 — the trip's non-archived proof documents (+ waivers), newest-first. */
  documents: DocumentDto[];
  /** Feature 008 — the required-document checklist status (missing lists + sign-off flag). */
  documentSummary: DocumentSummary;
  /** Feature 008 — the billing item + computed values, or null when not yet in the billing phase. */
  billing: BillingItemView | null;
}

/** The Drizzle row type for `trips` (camelCase columns; timestamps are Date). */
type TripRow = typeof trips.$inferSelect;

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** Map a `trips` row to the list/summary shape with the derived billing projection. */
export function toTripSummary(row: TripRow): TripSummary {
  return {
    id: row.id,
    customerId: row.customerId,
    externalTripId: row.externalTripId,
    originLocationId: row.originLocationId,
    destinationLocationId: row.destinationLocationId,
    laneId: row.laneId,
    currentStatus: row.currentStatus,
    billingStatus: billingStatus(row.currentStatus),
    slaStatus: row.slaStatus,
    slaReasons: row.slaReasons,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/**
 * Map a `trips` row to the full detail shape (without events/audit and the assignment projection,
 * which are loaded separately in `loadTripDetail`).
 */
function toTripBase(
  row: TripRow,
): Omit<
  TripDetail,
  | "events"
  | "audit"
  | "currentAssignment"
  | "assignmentHistory"
  | "exceptions"
  | "alerts"
  | "documents"
  | "documentSummary"
  | "billing"
> {
  return {
    ...toTripSummary(row),
    originalPlan: row.originalPlan,
    plannedPickupWindowStart: iso(row.plannedPickupWindowStart),
    plannedPickupWindowEnd: iso(row.plannedPickupWindowEnd),
    plannedDeliveryWindowStart: iso(row.plannedDeliveryWindowStart),
    plannedDeliveryWindowEnd: iso(row.plannedDeliveryWindowEnd),
    plannedVehicleType: row.plannedVehicleType,
    plannedVolumeUnits: row.plannedVolumeUnits,
    plannedWeightKg: row.plannedWeightKg,
    plannedPalletCount: row.plannedPalletCount,
    plannedRouteNotes: row.plannedRouteNotes,
    plannedServiceRequirements: row.plannedServiceRequirements,
    cancellationReasonCode: row.cancellationReasonCode,
    cancellationResponsibleParty: row.cancellationResponsibleParty,
    cancellationBillingImpact: row.cancellationBillingImpact,
    cancelledAt: iso(row.cancelledAt),
    disputedFromStatus: row.disputedFromStatus,
  };
}

// Drivers/vehicles/trailers/carriers each join the assignment once for display names. Aliasing keeps
// the join explicit and avoids any clash if the same tables are joined elsewhere in a wider query.
const asgDriver = alias(drivers, "asg_driver");
const asgVehicle = alias(vehicles, "asg_vehicle");
const asgTrailer = alias(trailers, "asg_trailer");
const asgCarrier = alias(carriers, "asg_carrier");
// Feature 007 — the exception owner + alert acknowledger display-name joins (aliased copies of users).
const excOwner = alias(users, "exc_owner");
const alertAck = alias(users, "alert_ack");

/** The assignment-row + joined-name select shape (shared by current + history loads). */
const assignmentColumns = {
  id: tripAssignments.id,
  driverId: tripAssignments.driverId,
  driverName: asgDriver.name,
  vehicleId: tripAssignments.vehicleId,
  vehiclePlate: asgVehicle.plate,
  trailerId: tripAssignments.trailerId,
  trailerLabel: asgTrailer.plate,
  carrierId: tripAssignments.carrierId,
  carrierName: asgCarrier.name,
  notes: tripAssignments.notes,
  overrideReason: tripAssignments.overrideReason,
  isCurrent: tripAssignments.isCurrent,
  assignedByUserId: tripAssignments.assignedByUserId,
  assignedAt: tripAssignments.assignedAt,
  confirmedByUserId: tripAssignments.confirmedByUserId,
  confirmedAt: tripAssignments.confirmedAt,
  supersededByAssignmentId: tripAssignments.supersededByAssignmentId,
  supersededAt: tripAssignments.supersededAt,
};

type AssignmentRow = {
  id: string;
  driverId: string | null;
  driverName: string | null;
  vehicleId: string | null;
  vehiclePlate: string | null;
  trailerId: string | null;
  trailerLabel: string | null;
  carrierId: string | null;
  carrierName: string | null;
  notes: string | null;
  overrideReason: string | null;
  isCurrent: boolean;
  assignedByUserId: string;
  assignedAt: Date;
  confirmedByUserId: string | null;
  confirmedAt: Date | null;
  supersededByAssignmentId: string | null;
  supersededAt: Date | null;
};

/** Map a joined `trip_assignments` row to the public DTO (timestamps → ISO). */
function toAssignmentDto(row: AssignmentRow): TripAssignmentDto {
  return {
    id: row.id,
    driverId: row.driverId,
    driverName: row.driverName,
    vehicleId: row.vehicleId,
    vehiclePlate: row.vehiclePlate,
    trailerId: row.trailerId,
    trailerLabel: row.trailerLabel,
    carrierId: row.carrierId,
    carrierName: row.carrierName,
    notes: row.notes,
    overrideReason: row.overrideReason,
    isCurrent: row.isCurrent,
    assignedByUserId: row.assignedByUserId,
    assignedAt: row.assignedAt.toISOString(),
    confirmedByUserId: row.confirmedByUserId,
    confirmedAt: iso(row.confirmedAt),
    supersededByAssignmentId: row.supersededByAssignmentId,
    supersededAt: iso(row.supersededAt),
  };
}

/**
 * Assemble a trip's full detail: the row + the latest 50 `trip_events` (newest first) + the latest
 * 50 `audit_logs` for `entity_type='trip', entity_id=:id` (newest first) + the assignment state
 * (006): the single `is_current` row (`currentAssignment`) and the superseded rows newest-first
 * (`assignmentHistory`). Returns `null` when the trip does not exist (callers map that to a 404 /
 * NOT_FOUND). This is the SINGLE source of current/history assignment loading — both mutating
 * services and `getTripDetailView` get it here, so trips-read never re-queries assignments.
 */
export async function loadTripDetail(
  executor: Querier,
  tripId: string,
): Promise<TripDetail | null> {
  const tripRows = await executor.select().from(trips).where(eq(trips.id, tripId)).limit(1);
  const row = tripRows[0];
  if (!row) return null;

  const eventRows = await executor
    .select()
    .from(tripEvents)
    .where(eq(tripEvents.tripId, tripId))
    .orderBy(desc(tripEvents.createdAt))
    .limit(50);

  const auditRows = await executor
    .select()
    .from(auditLogs)
    .where(and(eq(auditLogs.entityType, "trip"), eq(auditLogs.entityId, tripId)))
    .orderBy(desc(auditLogs.createdAt))
    .limit(50);

  // All assignment rows for this trip; the partial-unique index guarantees at most one is_current.
  const assignmentRows: AssignmentRow[] = await executor
    .select(assignmentColumns)
    .from(tripAssignments)
    .leftJoin(asgDriver, eq(tripAssignments.driverId, asgDriver.id))
    .leftJoin(asgVehicle, eq(tripAssignments.vehicleId, asgVehicle.id))
    .leftJoin(asgTrailer, eq(tripAssignments.trailerId, asgTrailer.id))
    .leftJoin(asgCarrier, eq(tripAssignments.carrierId, asgCarrier.id))
    .where(eq(tripAssignments.tripId, tripId))
    .orderBy(desc(tripAssignments.assignedAt));

  const current = assignmentRows.find((a) => a.isCurrent);
  const history = assignmentRows.filter((a) => !a.isCurrent);

  // Feature 007 — the trip's exceptions (with the derived reason-code category/label + owner name).
  const exceptionRows = await executor
    .select({
      id: exceptions.id,
      reasonCodeId: exceptions.reasonCodeId,
      reasonCode: reasonCodes.code,
      category: reasonCodes.category,
      reasonLabelPt: reasonCodes.labelPt,
      severity: exceptions.severity,
      status: exceptions.status,
      responsibleParty: exceptions.responsibleParty,
      ownerUserId: exceptions.ownerUserId,
      ownerName: excOwner.name,
      description: exceptions.description,
      openedAt: exceptions.openedAt,
      resolvedAt: exceptions.resolvedAt,
      closureNotes: exceptions.closureNotes,
      createdByUserId: exceptions.createdByUserId,
      createdAt: exceptions.createdAt,
      updatedAt: exceptions.updatedAt,
    })
    .from(exceptions)
    .innerJoin(reasonCodes, eq(exceptions.reasonCodeId, reasonCodes.id))
    .leftJoin(excOwner, eq(exceptions.ownerUserId, excOwner.id))
    .where(eq(exceptions.tripId, tripId))
    .orderBy(desc(exceptions.openedAt));

  // Feature 007 — the trip's in-app alerts (active/acknowledged/resolved) + the acknowledger name.
  const alertRows = await executor
    .select({
      id: alerts.id,
      tripId: alerts.tripId,
      alertCase: alerts.alertCase,
      severity: alerts.severity,
      state: alerts.state,
      createdAt: alerts.createdAt,
      acknowledgedByUserId: alerts.acknowledgedByUserId,
      acknowledgedByName: alertAck.name,
      acknowledgedAt: alerts.acknowledgedAt,
      autoResolvedAt: alerts.autoResolvedAt,
    })
    .from(alerts)
    .leftJoin(alertAck, eq(alerts.acknowledgedByUserId, alertAck.id))
    .where(eq(alerts.tripId, tripId))
    .orderBy(desc(alerts.createdAt));

  // Feature 008 — the trip's non-archived proof documents (+ waivers), with their type code/label.
  const documentRows = await executor
    .select({
      id: documents.id,
      tripId: documents.tripId,
      documentTypeId: documents.documentTypeId,
      documentTypeCode: documentTypes.code,
      documentTypeLabelPt: documentTypes.labelPt,
      fileStorageKey: documents.fileStorageKey,
      externalReference: documents.externalReference,
      verificationStatus: documents.verificationStatus,
      verifiedByUserId: documents.verifiedByUserId,
      verifiedAt: documents.verifiedAt,
      waivedAt: documents.waivedAt,
      waivedReason: documents.waivedReason,
      waivedByUserId: documents.waivedByUserId,
      notes: documents.notes,
      uploadedByUserId: documents.uploadedByUserId,
      createdAt: documents.createdAt,
    })
    .from(documents)
    .innerJoin(documentTypes, eq(documents.documentTypeId, documentTypes.id))
    .where(and(eq(documents.tripId, tripId), isNull(documents.archivedAt)))
    .orderBy(desc(documents.createdAt));

  // Feature 008 — required-document checklist status (computed once, shared by the doc + billing views).
  const tripScope: TripScope = {
    id: row.id,
    customerId: row.customerId,
    laneId: row.laneId,
    plannedVehicleType: row.plannedVehicleType,
  };
  const checklist = await loadChecklistStatus(tripScope, executor);
  const billing = await loadBillingItemView(executor, tripId, checklist);

  return {
    ...toTripBase(row),
    events: eventRows.map((e) => ({
      id: e.id,
      eventType: e.eventType,
      statusBefore: e.statusBefore,
      statusAfter: e.statusAfter,
      eventTimestamp: iso(e.eventTimestamp),
      source: e.source,
      actorUserId: e.actorUserId,
      locationId: e.locationId,
      notes: e.notes,
      exceptionId: e.exceptionId,
      createdAt: e.createdAt.toISOString(),
    })),
    audit: auditRows.map((a) => ({
      id: a.id,
      action: a.action as AuditAction,
      previousValue: a.previousValue,
      newValue: a.newValue,
      actorUserId: a.actorUserId,
      reason: a.reason,
      createdAt: a.createdAt.toISOString(),
    })),
    currentAssignment: current ? toAssignmentDto(current) : null,
    assignmentHistory: history.map(toAssignmentDto),
    exceptions: exceptionRows.map((e) => ({
      id: e.id,
      reasonCodeId: e.reasonCodeId,
      reasonCode: e.reasonCode,
      category: e.category,
      reasonLabelPt: e.reasonLabelPt,
      severity: e.severity,
      status: e.status,
      responsibleParty: e.responsibleParty,
      ownerUserId: e.ownerUserId,
      ownerName: e.ownerName,
      description: e.description,
      openedAt: e.openedAt.toISOString(),
      resolvedAt: iso(e.resolvedAt),
      closureNotes: e.closureNotes,
      createdByUserId: e.createdByUserId,
      createdAt: e.createdAt.toISOString(),
      updatedAt: e.updatedAt.toISOString(),
    })),
    alerts: alertRows.map((a) => ({
      id: a.id,
      tripId: a.tripId,
      alertCase: a.alertCase,
      severity: a.severity,
      state: a.state,
      createdAt: a.createdAt.toISOString(),
      acknowledgedByUserId: a.acknowledgedByUserId,
      acknowledgedByName: a.acknowledgedByName,
      acknowledgedAt: iso(a.acknowledgedAt),
      autoResolvedAt: iso(a.autoResolvedAt),
    })),
    documents: documentRows.map((d) => ({
      id: d.id,
      tripId: d.tripId,
      documentTypeId: d.documentTypeId,
      documentTypeCode: d.documentTypeCode,
      documentTypeLabelPt: d.documentTypeLabelPt,
      fileStorageKey: d.fileStorageKey,
      externalReference: d.externalReference,
      verificationStatus: d.verificationStatus,
      verifiedByUserId: d.verifiedByUserId,
      verifiedAt: iso(d.verifiedAt),
      waivedAt: iso(d.waivedAt),
      waivedReason: d.waivedReason,
      waivedByUserId: d.waivedByUserId,
      notes: d.notes,
      uploadedByUserId: d.uploadedByUserId,
      isWaiver: d.waivedAt != null,
      createdAt: d.createdAt.toISOString(),
    })),
    documentSummary: {
      completionMissing: checklist.completionMissing,
      billingMissing: checklist.billingMissing,
      checklistSignedOff: checklist.hasExplicitChecklist,
    },
    billing,
  };
}
