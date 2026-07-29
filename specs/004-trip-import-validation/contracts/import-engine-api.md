# Contract: Import Engine / Service API (feature 004) — new surface + the consume-003 reuse contract

**Feature**: 004-trip-import-validation | **Spec**: [../spec.md](../spec.md) · **Data model**:
[../data-model.md](../data-model.md) · **Research**: [../research.md](../research.md)

This file documents (A) what 004 **MUST reuse from 003** without redefining, (B) the **new reusable mapping engine**
(pure, in `@brazil-tms/shared`, used by web + worker), (C) the **worker job contracts**, and (D) the **BFF service
functions**. Single sources of truth: `@brazil-tms/shared` (engine + schemas), `@brazil-tms/db` (durable model + the
promoted trip-write services), `apps/web/lib/imports/*` (BFF services), `workers/jobs/*` (handlers).

## A. Consume-003 reuse contract (MUST NOT redefine — FR-027, FR-028)

004 **imports** from `@brazil-tms/shared`: `TRIP_STATUSES`, `TRANSITIONS`, `canTransition`, `billingStatus`,
`TRIP_CRITICAL_FIELDS`, `TRIP_EVENT_SOURCES` (uses `'import'`), and the trip Zod schemas (`createTripSchema`,
`updateTripPlanSchema`, `tripPlanFieldsSchema`). It **calls** these promoted trip-write services (see §R2 — moved to
`@brazil-tms/db` so the worker can import them; `apps/web/lib/trips/*` re-exports them unchanged for 003 callers):

```typescript
// @brazil-tms/db (canonical; apps/web re-exports). Each runs in ONE tx and writes row + (transitions) trip_event + audit.
createTrip(input: CreateTripInput, actorUserId: string): Promise<TripDetail>           // audit: trip.create; status starts 'received'; snapshots original_plan
updateTripPlan(
  tripId: string, changes: TripPlanFields,          // all keys optional/nullable; provided (!== undefined) → set, null → clear, absent → untouched
  args: { authorizedReview?: boolean }, actorUserId: string,
): Promise<TripDetail>                              // audit: trip.plan_update; throws Conflict('REVIEW_REQUIRED') past 'confirmed'
transitionTripStatus(/* … */): Promise<TripDetail> // NOT used by 004 (import never transitions from the file — R10)
```

- 004 passes `importBatchId` into `createTrip` (003 `createTripSchema` already accepts it) so each imported trip links to
  its batch. **`createTrip` does not catch the `(customer_id, external_trip_id)` `23505`** — the confirm job owns
  match/dedup and treats a race-conflict as update/no-op (R8).
- 004 MUST NOT declare a parallel status set, a second transition table, or its own trip table. New audit actions extend
  the shared `AuditAction` union (data-model §Audit actions).

## B. Mapping engine — pure, `@brazil-tms/shared/import/*` (used by web admin UI + worker)

```typescript
// engine.ts — config-driven; NO per-customer code (Constitution V)
applyTemplate(rawRow: Record<string, string>, template: TemplateConfig): MappedRow;
// normalize.ts — EXPLICIT Luxon parsing per template.parsingRules (no implicit Date — STACK §3.5)
normalizeDate(value: string, rules: ParsingRules): Date;       // returns UTC instant
normalizeNumber(value: string, rules: ParsingRules): number;
// matching.ts — pure
buildFuzzyKey(row: MappedRow): string;                         // customer+origin+dest+pickup-window+vehicle-type, tolerance-bucketed
detectInFileCollisions(rows: MappedRow[]): Set<number>;        // row_numbers sharing (customer, external_trip_id)
```

```typescript
// schemas/import.ts (Zod; reused by web + worker — the single validation boundary)
TemplateConfig = z.object({
  customerId: z.string().uuid(), name: z.string(), version: z.number().int().min(1),
  fileType: z.enum(['csv','xlsx']),
  columnMappings: z.array(z.object({ source: z.string(), target: z.string(), required: z.boolean().optional() })).min(1),
  parsingRules: z.object({ dateFormats: z.array(z.string()).default([]), timezone: z.string().default('America/Sao_Paulo'),
                           decimalSeparator: z.string().default(','), thousandSeparator: z.string().default('.') }).default({}),
  requiredOverrides: z.array(z.string()).default([]),
});
UploadMeta  = z.object({ customerId: z.string().uuid(), templateId: z.string().uuid().optional(),
                         fileName: z.string(), fileType: z.enum(['csv','xlsx']) });
MappedRow   = /* subset of 003 createTripSchema fields: externalTripId, originCode, destinationCode, planned windows,
                 vehicleType, volume/weight/pallets, routeNotes, serviceRequirements */;
```

## C. Worker job contracts (`workers/jobs/*`; pg-boss; payloads Zod-typed in `workers/lib/queue.ts`)

| Job name | Payload | Does | Then |
|---|---|---|---|
| `import.parse` | `{ batchId, storageKey }` | download original from Storage; stream-parse (csv-parse/exceljs); `applyTemplate` per row → insert `import_rows` (raw+mapped, preserving `row_number`); set `total_rows`; status `parsing→` | enqueue `import.validate` |
| `import.validate` | `{ batchId }` | per-row validation (customer active; external id present; locations resolve via `(customer,code)` or `location_aliases`; windows valid; vehicle type maps; required+overrides) → set `outcome`+`reasons`; status `validating` | enqueue `import.detect-duplicates` |
| `import.detect-duplicates` | `{ batchId }` | match `(customer,external_trip_id)` → `new`/`update`/`no_op`; fuzzy → `potential_duplicate` (warning); in-file collision → all `error`; tally counts | enqueue `import.generate-error-report` if `error_count>0`; set status `validated` |
| `import.generate-error-report` | `{ batchId }` | write error CSV/XLSX (failed rows + reasons + `row_number`) → Storage; set `error_report_storage_key` | — |
| `import.confirm` | `{ batchId, actorUserId }` | per-row best-effort + idempotent (R8): for `valid`/`warning` & `applied_at IS NULL` → call `createTrip`/`updateTripPlan`; link `target_trip_id`+`applied_at`; `REVIEW_REQUIRED`→needs-review; tally; status `confirming→completed`; audit `import.confirm` | — |

- Jobs are **idempotent** (re-run safe; STACK §3.11). Each records progress to `import_batches`. Failures set `status='failed'` + `error_message`; the original file is retained.

## D. BFF service functions (`apps/web/lib/imports/*`; called by route handlers)

```typescript
// import-batches-service.ts
createBatch(input: { customerId; templateId?; fileName; fileType; fileBytes }, actorUserId): Promise<{ id }>   // Storage put + insert + audit import.create + enqueue parse
getBatch(batchId): Promise<ImportBatchDetail | null>
listBatches(opts: { customerId?; status?; limit? }): Promise<ImportBatchSummary[]>
confirmBatch(batchId, actorUserId): Promise<{ id }>            // enqueue import.confirm (idempotent); audit import.confirm; throws Conflict('NOT_CONFIRMABLE')
errorReportUrl(batchId): Promise<string | null>               // signed URL via Storage helper
// import-rows-service.ts
listRows(batchId, opts: { outcome?; match?; limit?; offset? }): Promise<{ items: ImportRow[]; total: number }>
// import-templates-service.ts
createTemplate / getTemplate / updateTemplate(archive?) : Zod-validated; audit import_template.*
// status-mappings-service.ts
upsertStatusMapping(input, actorUserId)                        // audit status_mapping.upsert; throws on unknown internalStatus
// location-aliases-service.ts
resolveLocation(batchId, { fileValue, locationId }, actorUserId): Promise<{ id }>   // assert location active + same customer (else Conflict('INVALID_LOCATION_REFERENCE')); audit location_alias.create; enqueue re-validate
```

- All services `import "server-only"`, take `actorUserId`, and assume the handler already enforced
  `requirePermission(ctx, 'import_trips')`. They reuse 002's `assertActiveCustomer` / location-reference checks and the
  `isUniqueViolation` (`error.cause` walk) → `Conflict` pattern.

## Reuse rules (FR-027/FR-028, Constitution III/V)

- The worker imports trip-write services + `writeAudit` + `Conflict` from **`@brazil-tms/db`** (the R2 promotion); it
  does **not** re-implement trip creation/update, the status machine, or the audit write.
- Template/status-mapping/location-alias **config** is the only customer-specific surface; it is **data**, validated by
  the shared Zod schemas, consumed by one engine. No per-customer code path.
- New statuses/event types/audit actions are added by migration + the shared definition in the same PR (PR review
  enforces it).
