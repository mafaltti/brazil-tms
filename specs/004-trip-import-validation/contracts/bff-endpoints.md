# Contract: BFF Endpoints (feature 004)

**Feature**: 004-trip-import-validation | **Spec**: [../spec.md](../spec.md) · **Data model**:
[../data-model.md](../data-model.md) · **Engine/reuse**: [import-engine-api.md](./import-engine-api.md)

Handlers live under `apps/web/app/api/imports/*` and `apps/web/app/api/import-templates/*` (+ `…/status-mappings`). The
**fast path** (upload) does authz → Storage put → batch insert → enqueue and returns `202`; all heavy work is in the
worker (R3/R4). Batch progress is read by **TanStack Query polling** of the batch-status endpoint (no Realtime).

**Conventions** (inherited from 001/002/003 `contracts/bff-endpoints.md`):

- Every endpoint: `const ctx = await requireAuth(); requirePermission(ctx, 'import_trips');` then call a
  `apps/web/lib/imports/*` service with `ctx.userId` as `actorUserId`. Errors flow through `handleRouteError`.
- Status-code legend: **401** no session · **403** authenticated but lacks `import_trips` · **404** not found · **400**
  Zod/validation error · **409** business conflict (`error.code`) · **413** body too large (Caddy/proxy) · **202**
  accepted for async processing.
- URLs are kebab/resource style; ids are uuids; timestamps are ISO‑8601 UTC.

---

### `POST /api/imports`

- **Permission**: `import_trips`.
- **Body**: `multipart/form-data` — `file` (CSV/XLSX), `customerId` (uuid), `templateId?` (uuid). Metadata validated by
  `uploadMetaSchema`.
- **Behavior**: validate metadata + file type/size; upload the **original** file to Storage (service-role); insert
  `import_batches` (`status='received'`, `uploaded_by=ctx.userId`); audit `import.create`; enqueue the `parse` job.
  Returns immediately (fast path).
- **Responses**: `202 { id }`; `400` (bad metadata / unsupported file type); `401`; `403`; `413` (oversize).
- Traceability: US1, FR-006, FR-007, FR-009; SC-001, SC-008.

### `GET /api/imports`

- **Permission**: `import_trips`.
- **Query**: `?customerId=`, `?status=` (`import_batch_status`), `?limit=` (default 50).
- **Behavior**: import batch history (newest first), each with counts + status (INT-004).
- **Responses**: `200 { items: ImportBatchSummary[] }`; `401`; `403`.
- Traceability: US5, FR-031; SC-001, SC-007.

### `GET /api/imports/{id}`

- **Permission**: `import_trips`.
- **Behavior**: batch status + the four outcome counts + error-report availability (the **polled** progress endpoint).
- **Responses**: `200 ImportBatchDetail`; `401`; `403`; `404`.
- Traceability: US1/US5, FR-007; SC-008 (progress without blocking).

### `GET /api/imports/{id}/rows`

- **Permission**: `import_trips`.
- **Query**: `?outcome=` (`valid|warning|error`), `?match=` (`import_row_match`), `?limit=` (default 100), `?offset=`.
- **Behavior**: the preview/validation table — per-row `row_number`, `outcome`, localized `reasons`, `match_decision`,
  mapped field summary, `target_trip_id`.
- **Responses**: `200 { items: ImportRow[], total }`; `401`; `403`; `404`.
- Traceability: US2/US3, FR-013; SC-003, SC-006.

### `POST /api/imports/{id}/confirm`

- **Permission**: `import_trips`.
- **Behavior**: enqueue `confirm-import` for the batch (applies `valid`+`warning` rows; excludes `error`). **Idempotent**
  — re-confirm skips already-applied rows (R8). Audit `import.confirm`.
- **Responses**: `202 { id }`; `401`; `403`; `404`; `409 NOT_CONFIRMABLE` (batch not in `validated`/`completed`).
- Traceability: US1/US3, FR-016, FR-027, FR-027a, FR-029; SC-002, SC-009, SC-010.

### `GET /api/imports/{id}/error-report`

- **Permission**: `import_trips`.
- **Behavior**: mints a short-lived **signed URL** for the generated error report (server-mediated; no public object URL)
  and **`302`-redirects** to it, so the client uses a plain link/navigation (no `{ url }` + client `window.open`, which
  browsers popup-block after an `await`). The signed URL never reaches client JS and is freshly minted per request. The
  UI shows the download only when the batch's `hasErrorReport` is true.
- **Responses**: `302` → signed URL (`Location`); `401`; `403`; `404` (no error report for this batch).
- Traceability: US2, FR-014; SC-003.

### `POST /api/imports/{id}/locations`

- **Permission**: `import_trips`.
- **Body**: `{ fileValue: string, locationId: uuid }`.
- **Behavior**: resolve a flagged unknown location by creating a `location_aliases` row (map file value → **existing
  active** location of the batch's customer); audit `location_alias.create`; re-validate affected rows (enqueue
  re-validate). **Never creates** a master-data location.
- **Responses**: `201 { id }`; `400`; `401`; `403`; `404`; `409 INVALID_LOCATION_REFERENCE` (location archived or
  belongs to another customer).
- Traceability: US4, FR-025, FR-026; SC-005.

### `GET /api/import-templates` · `POST /api/import-templates`

- **Permission**: `import_trips`.
- **GET Query**: `?customerId=`, `?includeArchived=`. **POST Body**: `templateConfigSchema` (customerId, name, version,
  file_type, column_mappings, parsing_rules, required_overrides).
- **Behavior**: list / create per-customer template config (Zod-validated). Create audits `import_template.create`.
- **Responses**: `200 { items: ImportTemplate[] }` / `201 { id }`; `400`; `401`; `403`; `409 DUPLICATE_TEMPLATE`
  (`(customer, name, version)`).
- Traceability: US1, CUST-003, FR-001, FR-002, FR-003, FR-003a.

### `GET /api/import-templates/{id}` · `PATCH /api/import-templates/{id}`

- **Permission**: `import_trips`.
- **PATCH Body**: partial `templateConfigSchema` and/or `{ active }`, `{ archive: true }` (soft-delete).
- **Behavior**: read / update / archive a template. Update audits `import_template.update`.
- **Responses**: `200 ImportTemplate`; `400`; `401`; `403`; `404`.
- Traceability: FR-002, FR-003a, FR-004.

### `GET /api/status-mappings` · `POST /api/status-mappings`

- **Permission**: `import_trips`.
- **GET Query**: `?customerId=` (required). **POST Body**: `{ customerId, customerLabel, internalStatus }` (upsert).
- **Behavior**: list / upsert per-customer status-label → internal `trip_status` mappings (record/validate only, R10).
  Upsert audits `status_mapping.upsert`.
- **Responses**: `200 { items: StatusMapping[] }` / `200 { id }`; `400` (unknown `internalStatus`); `401`; `403`.
- Traceability: FR-004; Decision §30.

---

## Shared returned shapes (TypeScript-like)

```typescript
type ImportBatchSummary = {
  id: string; customerId: string; fileName: string; status: ImportBatchStatus;
  totalRows: number; createdCount: number; updatedCount: number; duplicateCount: number; errorCount: number;
  uploadedBy: string; createdAt: string;                       // ISO UTC
  hasErrorReport: boolean;                                     // report exists in Storage (drives the download UI)
};

type ImportBatchDetail = ImportBatchSummary & {
  templateId: string | null; errorMessage: string | null; updatedAt: string;
};

type ImportRow = {
  rowNumber: number; outcome: 'valid' | 'warning' | 'error' | null;
  matchDecision: 'new' | 'update' | 'no_op' | 'potential_duplicate' | 'unresolved' | null;
  reasons: { code: string; field?: string; message: string }[];   // localized (pt-BR)
  mapped: Record<string, unknown> | null; targetTripId: string | null;
};

type ImportTemplate = {
  id: string; customerId: string; name: string; version: number; fileType: 'csv' | 'xlsx';
  columnMappings: { source: string; target: string; required?: boolean }[];
  parsingRules: Record<string, unknown>; requiredOverrides: string[];
  active: boolean; archived: boolean; createdAt: string; updatedAt: string;
};

type StatusMapping  = { id: string; customerId: string; customerLabel: string; internalStatus: TripStatus; active: boolean };
type LocationAlias  = { id: string; customerId: string; fileValue: string; locationId: string; createdAt: string };
```
