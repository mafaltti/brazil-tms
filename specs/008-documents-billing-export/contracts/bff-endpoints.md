# BFF Endpoints — Documents, Completion, Billing Readiness, Rates & Export (008)

All endpoints are Next.js App Router Route Handlers under `apps/web/app/api/`. Every handler follows the established contract: `const ctx = await requireAuth()` (→ `401 UNAUTHORIZED`) → `requirePermission(ctx, key)` (→ `403 FORBIDDEN`) → Zod `schema.parse(body)` (→ `400 VALIDATION`) → `@brazil-tms/db` service / read-model → `handleRouteError(error)` (maps `Conflict`→`409 <code>` with `findings` passthrough; the `NOT_FOUND` code → `404`). Success bodies: `{ item }` (single / mutation result), `{ items }` (list), `{ summary }` (dashboard). Error body `{ error: { code, message, issues? }, findings? }`. Every route file sets `export const dynamic = "force-dynamic"` and exports **only** HTTP method handlers (logic in `@/lib/*` services — RECON: no `_helpers.ts` in the repo). Timestamps UTC; money integer centavos (BRL); messages pt-BR.

Authorization adds **no new permission key** (FR-026). It **first-enforces** the pre-declared 001 keys `upload_documents`, `verify_documents`, `mark_completed`, `mark_billing_ready`, `edit_rates`, `export_billing`, and **reuses** the already-enforced `manage_commercial_data` (002) for per-customer document-requirement + document-type administration. All **reads** stay on `view_all_trips`.

**Completion / Billing-Ready / Billed are transitions on the existing 003 status machine.** `markCompleted` / `markBillingReady` gather context, call the **pure** `evaluateCompletionReadiness` / `evaluateBillingReadiness` (`@brazil-tms/shared`), and then drive the change through the **reused `transitionTripStatus`** (its concurrency guard + `trip_events` + `trip.status_change` audit + in-tx `recomputeTripSla`) — the status machine is **not redefined** (FR-007/009). Billing lifecycle status is the **`billingStatus(current_status)` projection** (FR-011) — there is no stored billing-status column. The UI never decides completion/billing-readiness (Constitution III).

Legend: **NEW** = added by 008 · **EXTEND** = existing endpoint gains fields/filters.

---

## Documents

### 1. `POST /api/trips/:id/documents` — upload a proof document  **(NEW)**
**Permission**: `upload_documents`. **Body**: `multipart/form-data` — `file` (binary) + `meta` (JSON, `uploadDocumentMetaSchema`: `documentTypeId` uuid, `externalReference?`, `notes?`, `fileName`).
**Behaviour** (service `uploadDocument`): the route validates the file **before** storing — allowed types default **PDF/JPG/PNG** (extension + content-type) and size ≤ `DOCUMENT_MAX_BYTES` (default ~10 MB); on violation it returns `409 UNSUPPORTED_FILE_TYPE` / `409 FILE_TOO_LARGE` and **stores nothing** (R9). Otherwise `putDocument(documentStorageKey(...), bytes, contentType)` (Supabase Storage), then inserts the `documents` row (`verification_status='pending_review'`) + `document.upload` audit. → `201 { item: DocumentDto }`; `400 VALIDATION`; `403 FORBIDDEN`; `404 NOT_FOUND` (trip); `409 INVALID_DOCUMENT_TYPE` (unknown/inactive type), `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`.

### 2. `PATCH /api/documents/:id` — verify (accept / reject / pending)  **(NEW)**
**Permission**: `verify_documents`. **Body** (`verifyDocumentSchema`): `{ verificationStatus: 'accepted'|'rejected'|'pending_review', notes? }`.
**Behaviour** (`verifyDocument`): sets `verification_status` + `verified_by_user_id`/`verified_at` + `document.verify` audit. → `200 { item: DocumentDto }`; `400`/`403`/`404`.

### 3. `DELETE /api/documents/:id` — archive (soft-delete)  **(NEW)**
**Permission**: `upload_documents` (manage your uploads). **Behaviour** (`archiveDocument`): sets `archived_at` + `document.archive` audit (never hard delete). → `200 { item: DocumentDto }`; `403`/`404`.

### 4. `GET /api/trips/:id/documents/:docId/download` — signed download URL  **(NEW)**
**Permission**: `view_all_trips`. **Behaviour**: returns a short-lived **signed URL** (`signedUrl(file_storage_key, …)`) for the document binary (R8) — the service-role key never leaves the server, no public binary path. → `200 { url }`; `403`/`404` (missing / waiver row with no file).

> The trip's document list + missing-document list are served by `GET /api/trips/:id` (§14, EXTEND) and the Documents screen read (`GET /api/documents?...` if a standalone list is needed) on `view_all_trips`.

---

## Completion & Billing Ready (transitions on the 003 machine)

### 5. `POST /api/trips/:id/complete` — mark Completed  **(NEW)**
**Permission**: `mark_completed`. **Body** (`markCompletedSchema`): `{ waivedRequirements?: [{ documentTypeId: uuid, reason: string }] }`.
**Behaviour** (`markCompleted`, R7): gather ctx (current status; applicable required-for-completion types + which are accepted-or-waived incl. `waivedRequirements`) → `evaluateCompletionReadiness` → if blocked, `409 COMPLETION_BLOCKED` (missing types in `findings`); else record waivers (`document.waive`), `transitionTripStatus(unloaded→completed)`, then auto-advance `transitionTripStatus(completed→billing_pending)` (§11.6) + `ensureBillingItem` (period = month of completion). Returns the reloaded detail.
**Responses**: `200 { item: TripDetailView }`; `400`; `403`; `404`; `409 COMPLETION_BLOCKED`; `409 ILLEGAL_TRANSITION` / `STALE_TRANSITION` (surfaced from the reused `transitionTripStatus`).

### 6. `POST /api/trips/:id/billing-ready` — mark Billing Ready  **(NEW)**
**Permission**: `mark_billing_ready`. **Body** (`markBillingReadySchema`): `{ waivedRequirements?: [{ documentTypeId, reason }] }`.
**Behaviour** (`markBillingReady`, R7): gather ctx (current status; required-for-billing satisfied; `hasPricing` = `base_freight_cents != null`; `disputeStatus`) → `evaluateBillingReadiness` → if blocked, `409 BILLING_READY_BLOCKED` (blockers in `findings`); else record waivers, `transitionTripStatus(billing_pending→billing_ready)`. → `200 { item: TripDetailView }`; `400`/`403`/`404`; `409 BILLING_READY_BLOCKED` / `STALE_TRANSITION`.

---

## Per-customer document checklists + document-type master

### 7. `GET /api/document-types` · `POST /api/document-types`  **(NEW)**
**Permission**: GET `view_all_trips` · POST `manage_commercial_data`. POST (`createDocumentTypeSchema`) → `201 { item }` + `document_type.create`. GET → `200 { items }`.
### 8. `PATCH /api/document-types/:id`  **(NEW)** — `manage_commercial_data` (`updateDocumentTypeSchema`) → `200 { item }` + `document_type.update`.
### 9. `GET /api/document-requirements?customerId=` · `POST /api/document-requirements`  **(NEW)**
**Permission**: GET `view_all_trips` · POST `manage_commercial_data`. POST (`createDocumentRequirementSchema`) inserts a checklist row + `document_requirement.create` → `201 { item }`. GET lists a customer's checklist → `200 { items }`.
### 10. `PATCH /api/document-requirements/:id`  **(NEW)** — `manage_commercial_data` (`updateDocumentRequirementSchema`, incl. `active`) → `200 { item }` + `document_requirement.update`.

A customer with **no** checklist rows ⇒ the gate evaluates against `DEFAULT_DOCUMENT_CHECKLIST` and the customer is reported **document-checklist sign-off blocked** (§29 Input #3, FR-013).

---

## Rates & billing values

### 11. `GET /api/rates` · `POST /api/rates`  **(NEW)**
**Permission**: GET `view_all_trips` · POST `edit_rates`. POST (`createRateSchema`: customer/lane?/vehicleType?/`baseAmountCents`/currency/effective/rule-texts) → `201 { item }` + `rate.create`. GET lists rates → `200 { items }`.
### 12. `PATCH /api/rates/:id`  **(NEW)** — `edit_rates` (`updateRateSchema`, incl. `active`) → `200 { item }` + `rate.update`.
### 13. `PATCH /api/trips/:id/billing` — set manual base / period / dispute / notes  **(NEW)**
**Permission**: `edit_rates`. **Body** (`updateBillingItemSchema`): `{ baseFreightCents?, billingPeriod?, disputeStatus?, notes? }` → `updateBillingItem` + `billing_item.update`. → `200 { item: BillingItemView }`; `404` (no billing item yet — trip not in billing phase).
### 14. `POST /api/trips/:id/billing/adjustments` · `DELETE /api/billing-adjustments/:id`  **(NEW)**
**Permission**: `edit_rates`. POST (`addBillingAdjustmentSchema`: `type`, `amountCents`, `note?`) adds a typed adjustment; DELETE **soft-removes** one (sets `removed_at`/`removed_by_user_id`; retained history — Constitution III, never hard-deletes a financial row). Both `billing_item.update` audit + recompute `computeBillingValues` over **live** (`removed_at IS NULL`) rows. → `200/201 { item: BillingItemView }`; `400`/`403`/`404`.

`BillingItemView` returns `base_freight`, the adjustments, and the computed **planned / executed / adjustment / finalBillable** (BILL-005, FR-017) in BRL centavos.

---

## Billing lists, export & export-batch history

### 15. `GET /api/billing?scope=pending|ready&customerId=&period=` — billing pending / ready lists  **(NEW, FR-019)**
**Permission**: `view_all_trips`. Returns the billing-phase trips (filter on the `billingStatus` projection + customer + `YYYY-MM` period) with each trip's computed billable value and a **missing-proof indicator**. → `200 { items: BillingListRow[] }`. Read-only. The Billing screen's pending list opens a trip to price + mark Billing Ready (§5/§13/§14); the ready list feeds the export.
### 16. `POST /api/billing/exports` — generate a billing export  **(NEW, BILL-007/008)**
**Permission**: `export_billing`. **Body** (`createExportSchema`): `{ customerId, billingPeriod: 'YYYY-MM', format: 'csv'|'xlsx' }`.
**Behaviour** (`createExportBatch`): verify a non-empty billing-ready set (`409 NO_BILLABLE_TRIPS` if none) → insert `export_batches` (`status='queued'`) + `billing.export` audit → **enqueue** the `billing.export` worker job (heavy generation off the request path — R11). Until the exact finance format lands, the export uses the **labeled default column set** and the response notes export sign-off **blocked** (§29 Input #4). → `202 { item: ExportBatch }`; `400`/`403`; `409 NO_BILLABLE_TRIPS`.
### 17. `GET /api/billing/exports?customerId=&period=` — export-batch history  **(NEW, BILL-008)**
**Permission**: `view_all_trips`. → `200 { items: ExportBatch[] }` (newest-first; status, trip count, totals).
### 18. `GET /api/billing/exports/:id/download` — signed URL to the export file  **(NEW)**
**Permission**: `export_billing`. Returns a short-lived signed URL to the generated file. → `200 { url }`; `404` (not `completed` yet / missing).

---

## Extended reads (005, already `view_all_trips`)

### 19. `GET /api/trips/:id` — Trip Detail  **(EXTEND)**
`TripDetailView` (via the single `loadTripDetail`) gains `documents: DocumentDto[]` (type/verification/waiver/external-ref + the missing-required-document list) and `billing: BillingItemView | null` (item + adjustments + computed planned/executed/adjustment/final) — filling 005's documents/billing placeholders (R13). Read-only.
### 20. `GET /api/dashboard/summary` — Home Dashboard  **(EXTEND)**
Fills `completedMissingDocuments` (count of billing-phase trips with ≥1 unmet required-for-billing document) — replacing the 005 `null` placeholder; the `metric()` helper auto-flips placeholder→value. `billingPendingCount` already ships live in 005 (unchanged). Read-only.
### 21. `GET /api/trips` — Control Tower board  **(EXTEND)**
Gains the `missingDocuments` filter (trips with an unmet required-for-billing document) backing the **"Missing documents"** board view appended to `DEFAULT_TRIP_VIEWS` (R13). The billing-status filter (003 projection) already exists (005).

---

## Notes

- **No new permission key** (FR-026). Writes: `upload_documents` (upload), `verify_documents` (verify + … archive uses `upload_documents`), `mark_completed` (complete + completion waivers), `mark_billing_ready` (billing-ready + billing waivers), `edit_rates` (rates + billing values/adjustments), `export_billing` (export + download). Admin config: `manage_commercial_data` (document requirements + document types). Reads: `view_all_trips`. Grant matrix (001, RECON): `upload_documents` → Admin/Ops-Mgr/Dispatcher/Control-Tower/Fleet-Coordinator/Finance; `verify_documents` → Admin/Ops-Mgr/Finance; `mark_completed` → Admin/Ops-Mgr/Control-Tower; `mark_billing_ready` → Admin/Finance; `edit_rates` → Admin/Finance; `export_billing` → Admin/Finance; `manage_commercial_data` → Admin/Ops-Mgr.
- **Conflict codes**: new `COMPLETION_BLOCKED`, `BILLING_READY_BLOCKED`, `UNSUPPORTED_FILE_TYPE`, `FILE_TOO_LARGE`, `INVALID_DOCUMENT_TYPE`, `NO_BILLABLE_TRIPS`; reused `NOT_FOUND` (→404), `ILLEGAL_TRANSITION`, `STALE_TRANSITION` (from the reused `transitionTripStatus`).
- **New Zod schema files** in `@brazil-tms/shared` (`export *` in `shared/src/index.ts` after the 007 lines): `schemas/document.ts`, `schemas/document-requirement.ts`, `schemas/rate.ts`, `schemas/billing.ts`; `schemas/trip-board.ts` extended with `missingDocuments`.
- **Worker** (R11): the heavy export file generation runs in the on-demand `billing.export` pg-boss job (ExcelJS for xlsx/csv — no new dep); the §17 cases 7–8 alerts are generated by the scheduled `documents.checks` sweep (the **second** scheduled job, ~5-min `DOCUMENT_CHECKS_CRON`) via the **007 `alerts` store** (`ON CONFLICT DO NOTHING` idempotency + auto-resolve). The export marks included trips `billing_ready → billed` via `transitionTripStatus` (configurable lock/flag; default lock).
- **Audit** (FR-026; Constitution IV requires document-verification + rate/billing-change audit): new actions `document.upload`/`verify`/`waive`/`archive`, `document_requirement.create`/`update`, `document_type.create`/`update`, `rate.create`/`update`, `billing_item.update`, `billing.export` (added to `AuditAction` + `ALL_AUDIT_ACTIONS`, lockstep). Completion/Billing-Ready/Billed reuse `trip.status_change`.
- **HTTP-status assertions** (401/403/400/404/409 + payloads) live in Playwright `e2e/` (the project has **no** `route.test.ts` — `lib/**` Vitest only covers services, per MEMORY); the gate-evaluator + billing-computation correctness in `packages/shared` unit tests + `apps/web/lib/**/*.test.ts`.
