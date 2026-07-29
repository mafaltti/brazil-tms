export { loadTripDetail, toTripSummary } from "@brazil-tms/db";
export type {
  TripDetail,
  TripSummary,
  TripEventDto,
  AuditEntryDto,
  BillingStatus,
  // Feature 007 — exception + alert detail shapes (surfaced on the Trip Detail view).
  ExceptionDto,
  AlertDto,
  // Feature 008 — documents + billing detail shapes (Trip Detail documents/billing sections).
  DocumentDto,
  DocumentSummary,
  DocRef,
  BillingItemView,
  BillingAdjustmentDto,
} from "@brazil-tms/db";
