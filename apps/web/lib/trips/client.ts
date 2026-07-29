"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useCallback } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import {
  EXPORT_ROW_CAP,
  tripBoardQueryFromParams,
  type TripBoardQuery,
  type UpdateTripPlanInput,
  type AssignTripInput,
  type ConfirmAssignmentInput,
  type CheckAssignmentInput,
  type Finding,
  type TransitionTripInput,
  type AddTripNoteInput,
  type CreateExceptionInput,
  type UpdateExceptionInput,
  type TransitionExceptionInput,
  type CreateSlaRuleInput,
  type UpdateSlaRuleInput,
  type CreateDocumentRequirementInput,
  type UpdateDocumentRequirementInput,
  type CreateDocumentTypeInput,
  type UpdateDocumentTypeInput,
  type CreateRateInput,
  type UpdateRateInput,
  type UpdateBillingItemInput,
  type AddBillingAdjustmentInput,
  type CreateExportInput,
  // feature 009 — report read-model row types + the audit-view page shape (pure, from shared).
  type SlaReport,
  type ExceptionReport,
  type BillingReadinessReport,
  type AuditLogPage,
} from "@brazil-tms/shared";
import type {
  TripBoardRow,
  TripDetailView,
  TripFilterOptions,
  DashboardSummary,
  ExceptionListItem,
  ReasonCodeOption,
  CancellationOptionItem,
  AlertListItem,
  AlertListResult,
  CustomerSlaRuleItem,
  DocumentTypeView,
  DocumentRequirementView,
  RateRowView,
  BillingItemView,
  BillingListRow,
  ExportBatchRow,
} from "@brazil-tms/db";

/**
 * Client data layer for the Control Tower (feature 005): TanStack Query hooks, URL filter state,
 * and the CSV export href. Read-first — freshness is polling (per-hook `refetchInterval`), NO
 * Realtime (Constitution). The browser never talks to Postgres; everything goes through the BFF
 * under `/api/trips/*` and `/api/dashboard/*`. db view types are imported TYPE-ONLY (erased at
 * build) so this client file carries no server-side db dependency.
 */

// --- Poll/cap constants --------------------------------------------------------------------------

/** Control Tower board — dense active-trips list; 30s polling (plan: Performance Goals, R-poll). */
export const CONTROL_TOWER_POLL_MS = 30_000;
/** Home daily dashboard — coarser aggregates; 60s polling. */
export const DASHBOARD_POLL_MS = 60_000;
/** Trip Detail — operational view that may be edited; 30s polling. */
export const TRIP_DETAIL_POLL_MS = 30_000;
/** Reports + audit view — coarse aggregates / forensic browse; 60s polling (matches the dashboard). */
export const REPORTS_POLL_MS = 60_000;
/** Filter/resource option lists — bounded master data; 60s polling + focus refetch (019, issue #26). */
export const FILTER_OPTIONS_POLL_MS = 60_000;
/** Synchronous CSV export row cap (R13); single source in @brazil-tms/shared, re-exported for UI copy. */
export { EXPORT_ROW_CAP };

// --- Error + fetch helpers (mirror apps/web/lib/master-data/client.ts) ----------------------------

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
}

/**
 * The error 409s for assignment writes (006) carry the offending `Finding[]` at the TOP LEVEL of the
 * body (`{ error, findings }`), not inside `error` — so `readApiError` returns both halves.
 */
export interface ParsedApiError {
  error: ApiErrorBody | null;
  findings?: Finding[];
}

/** Read a `{ error: { code, message, issues? }, findings? }` body; `{ error: null }` if unparseable. */
export async function readApiError(res: Response): Promise<ParsedApiError> {
  try {
    const body = (await res.json()) as { error?: ApiErrorBody; findings?: Finding[] };
    return { error: body.error ?? null, findings: body.findings };
  } catch {
    return { error: null };
  }
}

/**
 * A thrown error carrying the API error code, so mutation onError can map it to a pt-BR message.
 * For assignment 409s it also carries the `findings` that fired (OVERRIDE_REQUIRED/ASSIGNMENT_BLOCKED),
 * so the UI can show exactly which checks blocked or warned.
 */
export class TripsError extends Error {
  readonly findings?: Finding[];
  constructor(readonly code: string, findings?: Finding[]) {
    super(code);
    this.name = "TripsError";
    this.findings = findings;
  }
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const { error, findings } = await readApiError(res);
    throw new TripsError(error?.code ?? "REQUEST_FAILED", findings);
  }
  return (await res.json()) as T;
}

// --- Query keys ----------------------------------------------------------------------------------

const TRIPS_ROOT = ["trips"] as const;

/** `search` is the URL query string (e.g. `useSearchParams().toString()`). */
export function tripBoardKey(search: string): unknown[] {
  return [...TRIPS_ROOT, "board", search];
}

export function tripDetailKey(id: string): unknown[] {
  return [...TRIPS_ROOT, "detail", id];
}

export function dashboardKey(): unknown[] {
  return [...TRIPS_ROOT, "dashboard"];
}

// feature 009 — reports + audit-view query keys.
const REPORTS_ROOT = ["reports"] as const;
const AUDIT_ROOT = ["audit-logs"] as const;

// --- Response shapes -----------------------------------------------------------------------------

export interface TripBoardResponse {
  items: TripBoardRow[];
  total: number;
  limit: number;
  offset: number;
}

// --- Read hooks ----------------------------------------------------------------------------------

/** Control Tower board. `search` is the URL query string; pass `searchParams.toString()`. */
export function useTripBoard(search: string): UseQueryResult<TripBoardResponse> {
  return useQuery({
    queryKey: tripBoardKey(search),
    queryFn: async () => asJson<TripBoardResponse>(await fetch(`/api/trips?${search}`)),
    refetchInterval: CONTROL_TOWER_POLL_MS,
  });
}

/**
 * Fresh filter/resource option lists (019, issue #26). Every option-loaded page still fetches the
 * lists server-side and passes them here as the SEED (`initialData` — first paint identical, no
 * double-fetch on mount); from then on the open tab keeps them fresh: 60 s polling + the TanStack
 * default focus refetch, so a driver registered mid-shift appears in the pickers without a reload.
 * A failed refresh keeps the last-known lists (stale-but-usable). Key is its own root — the lists
 * are master data, not trip data, so `["trips"]` invalidations don't churn them.
 */
export function useFilterOptions(initial: TripFilterOptions): TripFilterOptions {
  const query = useQuery({
    queryKey: ["filter-options"],
    queryFn: async () =>
      (await asJson<{ options: TripFilterOptions }>(await fetch(`/api/trips/filter-options`)))
        .options,
    initialData: initial,
    refetchInterval: FILTER_OPTIONS_POLL_MS,
  });
  return query.data ?? initial;
}

/** Trip Detail for a single trip (404 → TripsError("NOT_FOUND")). */
export function useTripDetail(id: string): UseQueryResult<{ item: TripDetailView }> {
  return useQuery({
    queryKey: tripDetailKey(id),
    queryFn: async () => asJson<{ item: TripDetailView }>(await fetch(`/api/trips/${id}`)),
    refetchInterval: TRIP_DETAIL_POLL_MS,
    enabled: Boolean(id),
  });
}

/** Home daily dashboard aggregates. */
export function useDashboardSummary(): UseQueryResult<{ summary: DashboardSummary }> {
  return useQuery({
    queryKey: dashboardKey(),
    queryFn: async () => asJson<{ summary: DashboardSummary }>(await fetch(`/api/dashboard/summary`)),
    refetchInterval: DASHBOARD_POLL_MS,
  });
}

// --- Feature 009 report + audit-view read hooks (poll 60s; reads, no mutations) ------------------

/** SLA performance report (US1). `search` is the report-filter query string. Returns the report directly. */
export function useSlaReport(search: string): UseQueryResult<SlaReport> {
  return useQuery({
    queryKey: [...REPORTS_ROOT, "sla", search],
    queryFn: async () => asJson<SlaReport>(await fetch(`/api/reports/sla?${search}`)),
    refetchInterval: REPORTS_POLL_MS,
  });
}

/** Exception volume / delay-reason report (US2). */
export function useExceptionReport(search: string): UseQueryResult<ExceptionReport> {
  return useQuery({
    queryKey: [...REPORTS_ROOT, "exceptions", search],
    queryFn: async () => asJson<ExceptionReport>(await fetch(`/api/reports/exceptions?${search}`)),
    refetchInterval: REPORTS_POLL_MS,
  });
}

/** Billing-readiness report (US3). */
export function useBillingReadinessReport(search: string): UseQueryResult<BillingReadinessReport> {
  return useQuery({
    queryKey: [...REPORTS_ROOT, "billing-readiness", search],
    queryFn: async () =>
      asJson<BillingReadinessReport>(await fetch(`/api/reports/billing-readiness?${search}`)),
    refetchInterval: REPORTS_POLL_MS,
  });
}

/** Audit-history view (US4). `search` is the audit-log query string; returns `{ items, total }`. */
export function useAuditLog(search: string): UseQueryResult<AuditLogPage> {
  return useQuery({
    queryKey: [...AUDIT_ROOT, search],
    queryFn: async () => asJson<AuditLogPage>(await fetch(`/api/admin/audit-logs?${search}`)),
    refetchInterval: REPORTS_POLL_MS,
  });
}

// --- Write hook (operational-field edits; reuses 003 updateTripPlan via the BFF) ------------------

/**
 * Edit live planned fields before completion. Invalidating the `["trips"]` root refreshes both the
 * board and the detail. Error codes (mapped to pt-BR by the caller): EDIT_NOT_ALLOWED,
 * REVIEW_REQUIRED, STALE_TRANSITION, NOT_FOUND, VALIDATION.
 */
export function useUpdateTripPlan(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateTripPlanInput) => {
      const res = await fetch(`/api/trips/${id}/plan`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Execution write hooks (007, US1; milestones + free-form notes via the BFF) -------------------

/**
 * Record an execution milestone (POST /api/trips/:id/status) — drives the 003 status machine and
 * recomputes SLA server-side. Invalidates the `["trips"]` root so the board/detail/dashboard refresh.
 * Error codes (mapped to pt-BR by the caller): ILLEGAL_TRANSITION, STALE_TRANSITION, NOT_FOUND.
 */
export function useRecordMilestone(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: TransitionTripInput) => {
      const res = await fetch(`/api/trips/${id}/status`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Append a free-form note (POST /api/trips/:id/events) — no status change. */
export function useAddTripNote(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddTripNoteInput) => {
      const res = await fetch(`/api/trips/${id}/events`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Assignment write hooks (006; reuse the @brazil-tms/db assignment services via the BFF) --------
//
// All POST/DELETE under `/api/trips/:id/assignment*`; every `onSuccess` invalidates the `["trips"]`
// root so the board, detail, and dashboard all refresh. A 409 throws a `TripsError` carrying the
// `findings` (OVERRIDE_REQUIRED / ASSIGNMENT_BLOCKED) so the caller can show which checks fired; the
// success body's `findings` are the overridden WARNs (assign/reassign only).

/** Shared response shape for assign/reassign: the updated trip + any overridden WARN findings. */
interface AssignmentResult {
  item: TripDetailView;
  findings: Finding[];
}

/**
 * Assign resources to a `received` trip (POST; slice 015, was `validated`). Error codes:
 * INCOMPLETE_ASSIGNMENT, OVERRIDE_REQUIRED, ASSIGNMENT_BLOCKED, STALE_TRANSITION, ILLEGAL_TRANSITION,
 * NOT_FOUND, VALIDATION.
 */
export function useAssignTrip(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignTripInput) => {
      const res = await fetch(`/api/trips/${id}/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<AssignmentResult>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/**
 * Reassign (substitute) the resources on an `assigned`/`confirmed` trip — same POST endpoint as
 * assign; the BFF branches on `expectedFromStatus`. No status change. Same error codes as assign.
 */
export function useReassignTrip(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AssignTripInput) => {
      const res = await fetch(`/api/trips/${id}/assignment`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<AssignmentResult>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Unassign (DELETE) — supersedes the current assignment and reverts `assigned → received` (slice 015). */
export function useUnassignTrip(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmAssignmentInput) => {
      const res = await fetch(`/api/trips/${id}/assignment`, {
        method: "DELETE",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/**
 * Confirm the current assignment (POST). Re-runs the evaluator server-side; a remaining BLOCK throws
 * `TripsError("ASSIGNMENT_BLOCKED")` carrying the `findings`. Transitions `assigned → confirmed`.
 */
export function useConfirmAssignment(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: ConfirmAssignmentInput) => {
      const res = await fetch(`/api/trips/${id}/assignment/confirm`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/**
 * Read-only dry-run eligibility check (POST). Writes nothing, so it invalidates nothing — it just
 * returns the `Finding[]` for the candidate resources (powers inline warnings in the panel/board).
 */
export function useAssignmentCheck(id: string) {
  return useMutation({
    mutationFn: async (input: CheckAssignmentInput) => {
      const res = await fetch(`/api/trips/${id}/assignment/check`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      const { findings } = await asJson<{ findings: Finding[] }>(res);
      return findings;
    },
  });
}

// --- Exception hooks (007, US2; exception lifecycle + queue via the BFF) --------------------------

const EXCEPTIONS_ROOT = ["exceptions"] as const;

/** Log an exception on a trip (POST /api/trips/:id/exceptions). Invalidates trips + exceptions. */
export function useCreateException(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateExceptionInput) => {
      const res = await fetch(`/api/trips/${id}/exceptions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: EXCEPTIONS_ROOT });
    },
  });
}

/** Edit a non-terminal exception (PATCH /api/exceptions/:id). */
export function useUpdateException() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ exceptionId, input }: { exceptionId: string; input: UpdateExceptionInput }) => {
      const res = await fetch(`/api/exceptions/${exceptionId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: EXCEPTIONS_ROOT });
    },
  });
}

/** Work an exception through its lifecycle (POST /api/exceptions/:id/transition). */
export function useTransitionException() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      exceptionId,
      input,
    }: {
      exceptionId: string;
      input: TransitionExceptionInput;
    }) => {
      const res = await fetch(`/api/exceptions/${exceptionId}/transition`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: EXCEPTIONS_ROOT });
    },
  });
}

/** The Exception Management queue (GET /api/exceptions). `search` is the filter query string. */
export function useExceptions(search: string): UseQueryResult<{ items: ExceptionListItem[] }> {
  return useQuery({
    queryKey: [...EXCEPTIONS_ROOT, "list", search],
    queryFn: async () => asJson<{ items: ExceptionListItem[] }>(await fetch(`/api/exceptions?${search}`)),
    refetchInterval: CONTROL_TOWER_POLL_MS,
  });
}

/** Active reason codes for the create-exception form (GET /api/reason-codes). */
export function useReasonCodes(): UseQueryResult<{ items: ReasonCodeOption[] }> {
  return useQuery({
    queryKey: [...EXCEPTIONS_ROOT, "reason-codes"],
    queryFn: async () => asJson<{ items: ReasonCodeOption[] }>(await fetch(`/api/reason-codes`)),
  });
}

// --- Alert hooks (007, US4; in-app alert list + acknowledge via the BFF) --------------------------

const ALERTS_ROOT = ["alerts"] as const;

/** The active/acknowledged in-app alert list + counts (GET /api/alerts). `state`/`tripId` optional. */
export function useAlerts(
  filters: { state?: string; tripId?: string } = {},
): UseQueryResult<AlertListResult> {
  const params = new URLSearchParams();
  if (filters.state) params.set("state", filters.state);
  if (filters.tripId) params.set("tripId", filters.tripId);
  const search = params.toString();
  return useQuery({
    queryKey: [...ALERTS_ROOT, "list", search],
    queryFn: async () => asJson<AlertListResult>(await fetch(`/api/alerts?${search}`)),
    refetchInterval: CONTROL_TOWER_POLL_MS,
  });
}

/** Acknowledge an alert (POST /api/alerts/:id/acknowledge). Invalidates alerts + trips. */
export function useAcknowledgeAlert() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (alertId: string) => {
      const res = await fetch(`/api/alerts/${alertId}/acknowledge`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
      });
      return asJson<{ item: AlertListItem }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ALERTS_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- SLA-rule hooks (007, US5; per-customer SLA-rule admin via the BFF) ---------------------------

const SLA_RULES_ROOT = ["sla-rules"] as const;

/** The per-customer SLA rules list (GET /api/customer-sla-rules). */
export function useCustomerSlaRules(): UseQueryResult<{ items: CustomerSlaRuleItem[] }> {
  return useQuery({
    queryKey: [...SLA_RULES_ROOT, "list"],
    queryFn: async () =>
      asJson<{ items: CustomerSlaRuleItem[] }>(await fetch(`/api/customer-sla-rules`)),
  });
}

/** Create a per-customer SLA rule (POST). Invalidates sla-rules + trips (the evaluator uses them). */
export function useCreateSlaRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateSlaRuleInput) => {
      const res = await fetch(`/api/customer-sla-rules`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: CustomerSlaRuleItem }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SLA_RULES_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Edit a per-customer SLA rule (PATCH /api/customer-sla-rules/:id). */
export function useUpdateSlaRule() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ ruleId, input }: { ruleId: string; input: UpdateSlaRuleInput }) => {
      const res = await fetch(`/api/customer-sla-rules/${ruleId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: CustomerSlaRuleItem }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: SLA_RULES_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Document hooks (008, US1; upload / verify / archive / download via the BFF) ------------------

const DOCUMENTS_ROOT = ["documents"] as const;

export interface UploadDocumentMetaInput {
  documentTypeId: string;
  externalReference?: string;
  notes?: string;
  fileName: string;
}

/** Upload a proof document (multipart POST /api/trips/:id/documents). Invalidates trips + documents. */
export function useUploadDocument(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ file, meta }: { file: File; meta: UploadDocumentMetaInput }) => {
      const form = new FormData();
      form.append("file", file);
      form.append("meta", JSON.stringify(meta));
      const res = await fetch(`/api/trips/${id}/documents`, { method: "POST", body: form });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_ROOT });
    },
  });
}

/** Verify a document (PATCH /api/documents/:id). */
export function useVerifyDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({
      documentId,
      input,
    }: {
      documentId: string;
      input: { verificationStatus: "pending_review" | "accepted" | "rejected"; notes?: string };
    }) => {
      const res = await fetch(`/api/documents/${documentId}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_ROOT });
    },
  });
}

/** Archive a document (DELETE /api/documents/:id) — soft-delete. */
export function useArchiveDocument() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (documentId: string) => {
      const res = await fetch(`/api/documents/${documentId}`, { method: "DELETE" });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_ROOT });
    },
  });
}

/** Fetch a short-lived signed download URL for a document (GET); not a hook — call on click. */
export async function fetchDocumentDownloadUrl(tripId: string, docId: string): Promise<string> {
  const res = await fetch(`/api/trips/${tripId}/documents/${docId}/download`);
  const { url } = await asJson<{ url: string }>(res);
  return url;
}

/** The document-type master (GET /api/document-types) — powers the upload type picker. */
export function useDocumentTypes(): UseQueryResult<{ items: DocumentTypeView[] }> {
  return useQuery({
    queryKey: [...DOCUMENTS_ROOT, "types"],
    queryFn: async () => asJson<{ items: DocumentTypeView[] }>(await fetch(`/api/document-types`)),
  });
}

// --- Completion / Billing-Ready hooks (008, US2) -------------------------------------------------

export interface WaivedRequirementInput {
  documentTypeId: string;
  reason: string;
}

/**
 * Mark Completed (POST /api/trips/:id/complete). A blocked gate throws `TripsError("COMPLETION_BLOCKED")`
 * carrying the blockers/missing types in `findings`. Invalidates the `["trips"]` root.
 */
export function useMarkCompleted(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { waivedRequirements?: WaivedRequirementInput[] } = {}) => {
      const res = await fetch(`/api/trips/${id}/complete`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Mark Billing Ready (POST /api/trips/:id/billing-ready). Blocked ⇒ `TripsError("BILLING_READY_BLOCKED")`. */
export function useMarkBillingReady(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: { waivedRequirements?: WaivedRequirementInput[] } = {}) => {
      const res = await fetch(`/api/trips/${id}/billing-ready`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Cancellation hooks (017 — issue #24; contracts/trip-cancellation-api.md) --------------------

/** The §19.5 user inputs — the BFF supplies `cancelled_at` itself (server now(), FR-005). */
export interface CancelTripFormInput {
  reasonCode: string;
  responsibleParty: string;
  billingImpact: string;
}

/**
 * Active cancellation options for the cancel dialog (GET /api/cancellation-options) — both kinds
 * (`reason` | `billing_impact`), config-grade staleness (no polling; refetched on mount/invalidate).
 * NOT `useReasonCodes` — that hook serves the 007 EXCEPTION reason codes.
 */
export function useCancellationOptions(): UseQueryResult<{ items: CancellationOptionItem[] }> {
  return useQuery({
    queryKey: [...TRIPS_ROOT, "cancellation-options"],
    queryFn: async () =>
      asJson<{ items: CancellationOptionItem[] }>(await fetch(`/api/cancellation-options`)),
  });
}

/**
 * Cancel a trip with full §19.5 justification (POST /api/trips/:id/cancel — the ONLY path to
 * `cancelled`). 409 codes surface via `TripsError` (NOT_CANCELLABLE, NOT_CANCELLABLE_BY_ROLE,
 * STALE_TRANSITION, CANCELLATION_NOT_CONFIGURED, …). Invalidates the `["trips"]` root so the
 * detail, Control Tower list, and dispatch queue all refetch.
 */
export function useCancelTrip(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CancelTripFormInput) => {
      const res = await fetch(`/api/trips/${id}/cancel`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: TripDetailView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Document requirement / type admin hooks (008, US3) ------------------------------------------

const DOC_REQ_ROOT = ["document-requirements"] as const;

const jsonMutation = <I, T>(url: () => string, method: "POST" | "PATCH") => ({
  mutationFn: async (input: I) => {
    const res = await fetch(url(), {
      method,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    });
    return asJson<T>(res);
  },
});

/** A customer's document-requirement checklist (GET). */
export function useDocumentRequirements(
  customerId?: string,
): UseQueryResult<{ items: DocumentRequirementView[] }> {
  const search = customerId ? `?customerId=${customerId}` : "";
  return useQuery({
    queryKey: [...DOC_REQ_ROOT, "list", customerId ?? ""],
    queryFn: async () =>
      asJson<{ items: DocumentRequirementView[] }>(
        await fetch(`/api/document-requirements${search}`),
      ),
    enabled: Boolean(customerId),
  });
}

export function useCreateDocumentRequirement() {
  const queryClient = useQueryClient();
  return useMutation({
    ...jsonMutation<CreateDocumentRequirementInput, { item: DocumentRequirementView }>(
      () => `/api/document-requirements`,
      "POST",
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOC_REQ_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

export function useUpdateDocumentRequirement() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateDocumentRequirementInput }) => {
      const res = await fetch(`/api/document-requirements/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: DocumentRequirementView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOC_REQ_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

export function useCreateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    ...jsonMutation<CreateDocumentTypeInput, { item: DocumentTypeView }>(
      () => `/api/document-types`,
      "POST",
    ),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_ROOT });
    },
  });
}

export function useUpdateDocumentType() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateDocumentTypeInput }) => {
      const res = await fetch(`/api/document-types/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: DocumentTypeView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: DOCUMENTS_ROOT });
    },
  });
}

// --- Rate + billing-item hooks (008, US4) --------------------------------------------------------

const RATES_ROOT = ["rates"] as const;

/** Rates list with labels (GET /api/rates). */
export function useRates(customerId?: string): UseQueryResult<{ items: RateRowView[] }> {
  const search = customerId ? `?customerId=${customerId}` : "";
  return useQuery({
    queryKey: [...RATES_ROOT, "list", customerId ?? ""],
    queryFn: async () => asJson<{ items: RateRowView[] }>(await fetch(`/api/rates${search}`)),
  });
}

export function useCreateRate() {
  const queryClient = useQueryClient();
  return useMutation({
    ...jsonMutation<CreateRateInput, { item: unknown }>(() => `/api/rates`, "POST"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RATES_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

export function useUpdateRate() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, input }: { id: string; input: UpdateRateInput }) => {
      const res = await fetch(`/api/rates/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: unknown }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: RATES_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Set the manual base / period / dispute / notes on a trip's billing item (PATCH). */
export function useUpdateBillingItem(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: UpdateBillingItemInput) => {
      const res = await fetch(`/api/trips/${id}/billing`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: BillingItemView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Add a typed adjustment to a trip's billing item (POST). */
export function useAddBillingAdjustment(id: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: AddBillingAdjustmentInput) => {
      const res = await fetch(`/api/trips/${id}/billing/adjustments`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: BillingItemView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Soft-remove a billing adjustment (DELETE /api/billing-adjustments/:id). */
export function useRemoveBillingAdjustment() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (adjustmentId: string) => {
      const res = await fetch(`/api/billing-adjustments/${adjustmentId}`, { method: "DELETE" });
      return asJson<{ item: BillingItemView }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

// --- Billing list + export hooks (008, US5) ------------------------------------------------------

const BILLING_ROOT = ["billing"] as const;

/** The billing pending/ready list (GET /api/billing). 30s polling. */
export function useBillingList(
  scope: "pending" | "ready",
  filters: { customerId?: string; period?: string } = {},
): UseQueryResult<{ items: BillingListRow[] }> {
  const params = new URLSearchParams({ scope });
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.period) params.set("period", filters.period);
  const search = params.toString();
  return useQuery({
    queryKey: [...BILLING_ROOT, "list", search],
    queryFn: async () => asJson<{ items: BillingListRow[] }>(await fetch(`/api/billing?${search}`)),
    refetchInterval: CONTROL_TOWER_POLL_MS,
  });
}

/** Export-batch history (GET /api/billing/exports). 30s polling (status progresses on the worker). */
export function useExportBatches(
  filters: { customerId?: string; period?: string } = {},
): UseQueryResult<{ items: ExportBatchRow[] }> {
  const params = new URLSearchParams();
  if (filters.customerId) params.set("customerId", filters.customerId);
  if (filters.period) params.set("period", filters.period);
  const search = params.toString();
  return useQuery({
    queryKey: [...BILLING_ROOT, "exports", search],
    queryFn: async () =>
      asJson<{ items: ExportBatchRow[] }>(await fetch(`/api/billing/exports?${search}`)),
    refetchInterval: CONTROL_TOWER_POLL_MS,
  });
}

/** Trigger a billing export (POST /api/billing/exports). Blocked ⇒ `TripsError("NO_BILLABLE_TRIPS")`. */
export function useCreateExport() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (input: CreateExportInput) => {
      const res = await fetch(`/api/billing/exports`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      return asJson<{ item: ExportBatchRow }>(res);
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: BILLING_ROOT });
      void queryClient.invalidateQueries({ queryKey: TRIPS_ROOT });
    },
  });
}

/** Fetch a signed URL to an export file (GET); not a hook — call on click. */
export async function fetchExportDownloadUrl(exportBatchId: string): Promise<string> {
  const res = await fetch(`/api/billing/exports/${exportBatchId}/download`);
  const { url } = await asJson<{ url: string }>(res);
  return url;
}

// --- CSV export ----------------------------------------------------------------------------------

/**
 * The CSV export is a direct browser navigation/anchor download (NOT a fetch hook). `search` is the
 * board query string WITHOUT limit/offset; the cap (EXPORT_ROW_CAP) is enforced server-side.
 */
export function exportHref(search: string): string {
  return `/api/trips/export?${search}`;
}

// --- URL filter state ----------------------------------------------------------------------------

type FilterValue = string | string[] | undefined;

export interface TripBoardFilters {
  /** Validated board query parsed from the current URL (falls back to defaults on parse error). */
  query: TripBoardQuery;
  /** The current URL query string (`searchParams.toString()`). */
  search: string;
  /** Merge `next` into the current params (delete on empty; arrays replaced); resets offset on filter change. */
  setFilters: (next: Partial<Record<string, FilterValue>>) => void;
  /** Set/clear a single param (sugar over setFilters). */
  setParam: (key: string, value: FilterValue) => void;
  /** Clear all params. */
  reset: () => void;
}

/** Keys whose change does NOT reset pagination (pagination/sort controls themselves). */
const NON_RESETTING_KEYS = new Set(["offset", "limit", "sort", "dir"]);

function isEmpty(value: FilterValue): boolean {
  return value === undefined || value === "" || (Array.isArray(value) && value.length === 0);
}

/** URL-as-state for the Control Tower board: parse + mutate filters via the router (shallow replace). */
export function useTripBoardFilters(): TripBoardFilters {
  const searchParams = useSearchParams();
  const router = useRouter();

  const search = searchParams.toString();

  let query: TripBoardQuery;
  try {
    query = tripBoardQueryFromParams(new URLSearchParams(search));
  } catch {
    query = tripBoardQueryFromParams(new URLSearchParams());
  }

  const setFilters = useCallback(
    (next: Partial<Record<string, FilterValue>>) => {
      const params = new URLSearchParams(searchParams.toString());

      let changedFilter = false;
      for (const [key, value] of Object.entries(next)) {
        params.delete(key);
        if (!isEmpty(value)) {
          if (Array.isArray(value)) {
            for (const v of value) params.append(key, v);
          } else {
            params.set(key, value as string);
          }
        }
        if (!NON_RESETTING_KEYS.has(key)) changedFilter = true;
      }

      // Reset pagination on any actual filter change (good UX): jump back to the first page.
      if (changedFilter) params.set("offset", "0");

      router.replace(`?${params.toString()}`, { scroll: false });
    },
    [router, searchParams],
  );

  const setParam = useCallback(
    (key: string, value: FilterValue) => setFilters({ [key]: value }),
    [setFilters],
  );

  const reset = useCallback(() => {
    router.replace("?");
  }, [router]);

  return { query, search, setFilters, setParam, reset };
}
