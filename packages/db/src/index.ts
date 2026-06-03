export { db, getDb, schema, type DB } from "./client";
export * from "../schema";
export * from "./errors";
export * from "./audit/write-audit";
export * from "./trips/trip-dto";
export { createTrip, getTrip, listTrips } from "./trips/trips-service";
export { updateTripPlan } from "./trips/trip-plan";
export { transitionTripStatus } from "./trips/trip-transitions";
export { cancelTrip } from "./trips/trip-cancellation";
export { addTripNote } from "./trips/trip-events";
export { createException, updateException, transitionException } from "./trips/exceptions";
export {
  assignTrip,
  reassignTrip,
  unassignTrip,
  confirmTripAssignment,
  checkAssignment,
  gatherEligibilityContext,
  assertTripExists,
} from "./trips/trip-assignments";
// `TripAssignmentDto` (+ the extended `TripDetail`) is already re-exported via `export * from
// "./trips/trip-dto"` above.
export {
  queryTripBoard,
  getTripDetailView,
  queryDashboardMetrics,
  exportTripRows,
  getTripFilterOptions,
  queryExceptions,
  queryReasonCodes,
  queryCustomerSlaRules,
} from "./trips/trips-read";
export type {
  TripBoardRow,
  TripBoardResult,
  TripDetailView,
  DashboardSummary,
  TripFilterOptions,
  ResourceOption,
  ExceptionListItem,
  ReasonCodeOption,
  CustomerSlaRuleItem,
} from "./trips/trips-read";
// Feature 007 — SLA recompute + alert helpers. `ExceptionDto`/`AlertDto` (+ the extended `TripDetail`)
// are already re-exported via `export * from "./trips/trip-dto"` above.
export { recomputeTripSla, resolveSlaPolicy } from "./trips/sla";
// feature 009 — the shared on-time predicate (DRY-for-correctness with the dashboard, R2). The three
// report read models + the extended audit read are exported within their story phases below.
export { onTimeExpr, type OnTimeExpr, type OnTimeKind } from "./trips/on-time";
export { querySlaReport } from "./reporting/sla";
export { queryExceptionReport } from "./reporting/exceptions";
export { queryBillingReadinessReport } from "./reporting/billing-readiness";
export { queryAuditLog } from "./audit/audit-read";
export { createCustomerSlaRule, updateCustomerSlaRule } from "./trips/sla-rules";
export {
  generateAlert,
  autoResolveAlert,
  acknowledgeAlert,
  listAlerts,
  type AlertCase,
  type AlertSeverity,
  type AlertListItem,
  type AlertListResult,
} from "./trips/alerts";
// Feature 008 — documents / requirements / rates / billing-items foundational reads + helpers.
// (`DocumentDto`/`DocumentSummary`/`BillingItemView`/`BillingAdjustmentDto`/`DocRef` flow through
// `export * from "./trips/trip-dto"` above.)
export {
  resolveRequiredTypes,
  satisfiedDocumentTypeIds,
  loadChecklistStatus,
  listDocumentRequirements,
  listDocumentTypes,
  createDocumentRequirement,
  updateDocumentRequirement,
  createDocumentType,
  updateDocumentType,
  type TripScope,
  type ChecklistStatus,
} from "./documents/requirements";
export {
  uploadDocument,
  verifyDocument,
  archiveDocument,
  getDocumentFileKey,
  assertUploadable,
} from "./documents/documents";
export { resolveRate, listRates, createRate, updateRate, type RateRow } from "./billing/rates";
export {
  ensureBillingItem,
  loadBillingItemView,
  billingPeriodSaoPaulo,
  updateBillingItem,
  addBillingAdjustment,
  removeBillingAdjustment,
} from "./billing/billing-items";
export { markCompleted, markBillingReady } from "./trips/completion";
export { createExportBatch, countBillableTrips, getExportDownload } from "./billing/export";
export {
  queryBillingList,
  queryExportBatches,
  queryRates,
  queryDocumentRequirements,
  queryDocumentTypes,
  type BillingListRow,
  type ExportBatchRow,
  type RateRowView,
  type DocumentRequirementView,
  type DocumentTypeView,
} from "./trips/trips-read";
