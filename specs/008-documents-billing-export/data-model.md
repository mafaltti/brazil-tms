# Phase 1 — Data Model: Documents, Completion, Billing Readiness, Rates, and Export

**Feature**: 008-documents-billing-export · **Date**: 2026-06-01 · **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

> Authoritative DDL is the committed `drizzle-kit generate` output under `packages/db/migrations/0007_*.sql`. The blocks below are the design sketch the new schema files (`packages/db/schema/{document-types,documents,document-requirements,rates,billing-items,billing-adjustments,export-batches}.ts`) produce. **Seven new tables; three new pgEnums; `document_types` is a config table (not an enum, clarify Q2); `export_batches.format` / `billing_items.dispute_status` are CHECK text; NO `trips` ALTER (billing status is the `billingStatus(current_status)` projection — FR-011); no new permission key, package, worker process, or runtime dependency.**

The clarified decisions this model encodes verbatim:
- **Q1** — `billing_items.billing_period` = `text 'YYYY-MM'`, defaulting to the **calendar month of completion** (`America/Sao_Paulo`), editable.
- **Q2** — proof-document **types are a configurable master table** `document_types` (mirrors `reason_codes`), referenced by `documents` + `document_requirements`.
- **Q3** — a missing required document is satisfied by an accepted upload **or an audited per-document waiver** (a no-file `documents` row, `waived_at` set), recorded **inside** the gated `markCompleted`/`markBillingReady` transition.
- **Q4** — uploads restricted to **PDF/JPG/PNG ≤ ~10 MB** (configurable; enforced in the BFF, R9).
- **FR-011** — billing lifecycle status is the **003 `billingStatus(current_status)` projection** over `{billing_pending, billing_ready, billed, disputed}`; **no stored billing-status column**.

---

## 1. New enums (`CREATE TYPE`) vs CHECK text vs config table

Three new pgEnums in `packages/db/schema/enums.ts` (the codebase convention — `pgEnum` for fixed sets referenced by service/gating/computation logic; `text + CHECK` for business-mutable / display value sets; a **config table** for an admin-managed vocabulary):

```ts
// packages/db/schema/enums.ts (append, after the 007 exception enums)
export const documentVerificationStatus = pgEnum("document_verification_status", [
  "pending_review", "accepted", "rejected",
]);
export const exportBatchStatus = pgEnum("export_batch_status", [
  "queued", "running", "completed", "failed",          // mirrors import_batch_status
]);
export const billingAdjustmentType = pgEnum("billing_adjustment_type", [
  "toll", "waiting_time", "redelivery", "extra_stop", "penalty", "discount", "manual_adjustment",
]);
```

- **`document_verification_status`** — fixed 3-value set the completion/billing gate branches on (accepted satisfies a requirement) → pgEnum (mirrors `exception_status`).
- **`export_batch_status`** — `queued | running | completed | failed`, **mirrors the existing `import_batch_status`** pgEnum (durable batch status, R11/R14).
- **`billing_adjustment_type`** — fixed 7-value set `computeBillingValues` branches on (the discount-subtraction rule) → pgEnum.

**CHECK-constrained text (NOT enums)**: `export_batches.format` (`'csv' | 'xlsx'` — a 2-value display set, no logic branch); `billing_items.dispute_status` (`'none' | 'open' | 'resolved'` — keeps the §19.4 gate predicate readable); `rates.currency` / `billing_items.currency` (`text` default `'BRL'`, no multi-currency MVP). **Config table (NOT enum)**: `document_types` (clarify Q2 — admin-managed vocabulary, mirrors `reason_codes`). **No new `vehicle_type`** (reused). **No `trips` enum or column** (FR-011 — billing status is the projection).

---

## 2. New table — `document_types` (config/master; PRD §13.9, clarify Q2)

Config table mirroring `reason_codes` (business-mutable vocabulary → config rows + `text` codes, not a `pgEnum`).

```sql
CREATE TABLE "document_types" (
  "id"          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "code"        text NOT NULL UNIQUE,          -- 'pod','cte','mdfe','gate_receipt','portal_ref',...
  "label_pt"    text NOT NULL,
  "active"      boolean NOT NULL DEFAULT true,
  "sort_order"  integer NOT NULL DEFAULT 0,
  "created_at"  timestamptz NOT NULL DEFAULT now(),
  "updated_at"  timestamptz NOT NULL DEFAULT now()
);
```

```ts
export const documentTypes = pgTable("document_types", {
  id: uuid("id").primaryKey().defaultRandom(),
  code: text("code").notNull().unique(),
  labelPt: text("label_pt").notNull(),
  active: boolean("active").notNull().default(true),
  sortOrder: integer("sort_order").notNull().default(0),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
});
```

**Rules / invariants**
- Seeded as **labeled scaffolding** (Constitution II): `pod`, `cte`, `mdfe`, `gate_receipt`, `portal_ref` with pt-BR labels — extensible without a code change (Q2, Constitution V). Mirrors how `reason_codes` is seeded.
- Referenced by `documents.document_type_id` and `document_requirements.document_type_id`.
- **Mutable** (admin edits) → **NO REVOKE**. Administered via `manage_commercial_data` (R12).

---

## 3. New table — `documents` (PRD §14.1, DOC-001/002/004/006; waiver R3)

```sql
CREATE TABLE "documents" (
  "id"                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id"              uuid NOT NULL REFERENCES "trips"("id"),
  "document_type_id"     uuid NOT NULL REFERENCES "document_types"("id"),
  "file_storage_key"     text,                                  -- Supabase Storage key; NULL for a waiver row
  "external_reference"   text,                                  -- CT-e / MDF-e / POD / gate receipt / portal ref
  "uploaded_by_user_id"  uuid NOT NULL REFERENCES "users"("id"),
  "verification_status"  "document_verification_status" NOT NULL DEFAULT 'pending_review',
  "verified_by_user_id"  uuid REFERENCES "users"("id"),
  "verified_at"          timestamptz,
  "waived_at"            timestamptz,                           -- set ⇒ this is a waiver (Q3)
  "waived_reason"        text,
  "waived_by_user_id"    uuid REFERENCES "users"("id"),
  "notes"                text,
  "archived_at"          timestamptz,                           -- soft-delete (never hard delete)
  "created_at"           timestamptz NOT NULL DEFAULT now(),
  "updated_at"           timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "documents_file_or_waiver_ck"
    CHECK ("file_storage_key" IS NOT NULL OR "waived_at" IS NOT NULL)
);

CREATE INDEX "documents_trip_idx"         ON "documents" ("trip_id");
CREATE INDEX "documents_type_idx"         ON "documents" ("document_type_id");
CREATE INDEX "documents_verification_idx" ON "documents" ("verification_status");
```

```ts
export const documents = pgTable(
  "documents",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    documentTypeId: uuid("document_type_id").notNull().references(() => documentTypes.id),
    fileStorageKey: text("file_storage_key"),
    externalReference: text("external_reference"),
    uploadedByUserId: uuid("uploaded_by_user_id").notNull().references(() => users.id),
    verificationStatus: documentVerificationStatus("verification_status").notNull().default("pending_review"),
    verifiedByUserId: uuid("verified_by_user_id").references(() => users.id),
    verifiedAt: timestamp("verified_at", { withTimezone: true }),
    waivedAt: timestamp("waived_at", { withTimezone: true }),
    waivedReason: text("waived_reason"),
    waivedByUserId: uuid("waived_by_user_id").references(() => users.id),
    notes: text("notes"),
    archivedAt: timestamp("archived_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("documents_file_or_waiver_ck", sql`${table.fileStorageKey} IS NOT NULL OR ${table.waivedAt} IS NOT NULL`),
    index("documents_trip_idx").on(table.tripId),
    index("documents_type_idx").on(table.documentTypeId),
    index("documents_verification_idx").on(table.verificationStatus),
  ],
);
```

**Rules / invariants**
- **1:1 with PRD §14.1's Document fields**; `document_type_id` references the Q2 master. The **binary lives only in Supabase Storage** (`file_storage_key`); never in Postgres (STACK §3.9, R8).
- **Verification** (DOC-004): `verification_status` ∈ `pending_review` (default on upload) / `accepted` / `rejected`; `verified_by_user_id` + `verified_at` set on a verify. A **`rejected`** document does **not** satisfy a requirement (FR-003).
- **Waiver** (Q3, R3): a row with `file_storage_key = NULL` + `waived_at`/`waived_reason`/`waived_by_user_id` is an audited "unavailable-with-reason". The `documents_file_or_waiver_ck` CHECK guarantees a row is **either** an upload **or** a waiver.
- **Requirement satisfaction** (used by the gate evaluators, R10): a required type *T* is satisfied for a trip iff ∃ a non-archived row `(trip, T)` with `verification_status='accepted'` **OR** `waived_at IS NOT NULL`.
- **Soft-delete** via `archived_at` (the codebase convention; Constitution III — never hard-delete). **Mutable** (verify/waive/archive) → **NO REVOKE**.
- Audited: `document.upload`, `document.verify`, `document.waive`, `document.archive` (R12; Constitution IV explicitly requires document-verification audit).

---

## 4. New table — `document_requirements` (PRD §14.1, CUST-004, DOC-003/005)

```sql
CREATE TABLE "document_requirements" (
  "id"                        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"               uuid NOT NULL REFERENCES "customers"("id"),
  "document_type_id"          uuid NOT NULL REFERENCES "document_types"("id"),
  "required_for_completion"   boolean NOT NULL DEFAULT false,   -- blocks Completed
  "required_for_billing"      boolean NOT NULL DEFAULT true,    -- blocks Billing Ready
  "lane_id"                   uuid REFERENCES "lanes"("id"),    -- optional scope
  "vehicle_type"              "vehicle_type",                   -- optional scope (reused enum)
  "active"                    boolean NOT NULL DEFAULT true,
  "created_at"                timestamptz NOT NULL DEFAULT now(),
  "updated_at"                timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "document_requirements_customer_idx" ON "document_requirements" ("customer_id");
CREATE INDEX "document_requirements_scope_idx"    ON "document_requirements" ("customer_id", "lane_id", "vehicle_type");
```

```ts
export const documentRequirements = pgTable(
  "document_requirements",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    documentTypeId: uuid("document_type_id").notNull().references(() => documentTypes.id),
    requiredForCompletion: boolean("required_for_completion").notNull().default(false),
    requiredForBilling: boolean("required_for_billing").notNull().default(true),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("document_requirements_customer_idx").on(table.customerId),
    index("document_requirements_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
```

**Rules / invariants**
- **Applicability** (R2): a row applies to a trip when `customer_id` matches AND `active` AND (`lane_id` IS NULL OR = trip.lane_id) AND (`vehicle_type` IS NULL OR = trip.planned_vehicle_type). Unscoped rows apply to all the customer's trips; scoped rows **add** when matched (additive — the spec's "in addition to/over").
- **Absence of any rows for a customer ⇒ `DEFAULT_DOCUMENT_CHECKLIST`** (a `@brazil-tms/shared` constant — labeled scaffolding, e.g. `[{ typeCode: 'pod', requiredForBilling: true }]`) **AND that customer's document-checklist sign-off reported blocked** (FR-013, §29 Input #3). Never silently signed off.
- **Per-customer commercial config** → `manage_commercial_data` (R12). **Mutable** → **NO REVOKE**.

---

## 5. New table — `rates` (PRD §14.1, BILL-002/003)

```sql
CREATE TABLE "rates" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"         uuid NOT NULL REFERENCES "customers"("id"),
  "lane_id"             uuid REFERENCES "lanes"("id"),       -- optional scope
  "vehicle_type"        "vehicle_type",                      -- optional scope (reused enum)
  "base_amount_cents"   bigint NOT NULL,                     -- integer centavos, BRL (codebase convention)
  "currency"            text NOT NULL DEFAULT 'BRL',
  "toll_handling_rule"  text,                                -- §29 Input #5 — nullable, not interpreted in MVP
  "waiting_time_rule"   text,                                -- §29 Input #5
  "extra_stop_rule"     text,                                -- §29 Input #5
  "effective_start"     timestamptz,
  "effective_end"       timestamptz,
  "active"              boolean NOT NULL DEFAULT true,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX "rates_customer_idx" ON "rates" ("customer_id");
CREATE INDEX "rates_scope_idx"    ON "rates" ("customer_id", "lane_id", "vehicle_type");
```

```ts
export const rates = pgTable(
  "rates",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    laneId: uuid("lane_id").references(() => lanes.id),
    vehicleType: vehicleType("vehicle_type"),
    baseAmountCents: bigint("base_amount_cents", { mode: "number" }).notNull(),
    currency: text("currency").notNull().default("BRL"),
    tollHandlingRule: text("toll_handling_rule"),
    waitingTimeRule: text("waiting_time_rule"),
    extraStopRule: text("extra_stop_rule"),
    effectiveStart: timestamp("effective_start", { withTimezone: true }),
    effectiveEnd: timestamp("effective_end", { withTimezone: true }),
    active: boolean("active").notNull().default(true),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("rates_customer_idx").on(table.customerId),
    index("rates_scope_idx").on(table.customerId, table.laneId, table.vehicleType),
  ],
);
```

**Rules / invariants**
- **Money is `bigint` cents, `'BRL'`** (RECON: `lanes.standard_rate_cents` is `bigint('…', { mode: 'number' })`).
- **Single-applicable-rate precedence is resolved in the resolver query — NOT a DB constraint** (R4, mirroring 007's SLA-rule precedence): `WHERE customer_id = ? AND active AND (effective window covers the trip's pickup) AND (lane_id = trip.lane_id OR lane_id IS NULL) AND (vehicle_type = trip.planned_vehicle_type OR vehicle_type IS NULL) ORDER BY (lane_id IS NOT NULL) DESC, (vehicle_type IS NOT NULL) DESC, effective_start DESC NULLS LAST LIMIT 1`. **No match ⇒ manual billing amount + billing-rule sign-off blocked** (§29 Input #5, FR-018).
- `toll_handling_rule`/`waiting_time_rule`/`extra_stop_rule` are **nullable text** placeholders — **not interpreted in MVP** (gated §29 Input #5; manual values until supplied — never invented).
- **Mutable** (`edit_rates`) → **NO REVOKE**.

---

## 6. New tables — `billing_items` + `billing_adjustments` (PRD §14.1, BILL-001/003/004/005)

```sql
CREATE TABLE "billing_items" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "trip_id"            uuid NOT NULL REFERENCES "trips"("id"),
  "customer_id"        uuid NOT NULL REFERENCES "customers"("id"),
  "rate_id"            uuid REFERENCES "rates"("id"),        -- the rate applied, or NULL for a manual amount
  "base_freight_cents" bigint,                               -- executed value (rate-derived or manual); NULL until priced
  "currency"           text NOT NULL DEFAULT 'BRL',
  "billing_period"     text NOT NULL,                        -- 'YYYY-MM' (month of completion, America/Sao_Paulo; Q1)
  "dispute_status"     text NOT NULL DEFAULT 'none',
  "export_batch_id"    uuid REFERENCES "export_batches"("id"),
  "notes"              text,
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "updated_at"         timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "billing_items_dispute_status_ck" CHECK ("dispute_status" IN ('none','open','resolved'))
);
CREATE UNIQUE INDEX "billing_items_trip_uq"            ON "billing_items" ("trip_id");
CREATE INDEX        "billing_items_customer_period_idx" ON "billing_items" ("customer_id", "billing_period");
CREATE INDEX        "billing_items_export_batch_idx"    ON "billing_items" ("export_batch_id");

CREATE TABLE "billing_adjustments" (
  "id"                 uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "billing_item_id"    uuid NOT NULL REFERENCES "billing_items"("id"),
  "type"               "billing_adjustment_type" NOT NULL,
  "amount_cents"       bigint NOT NULL,
  "note"               text,
  "created_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "created_at"         timestamptz NOT NULL DEFAULT now(),
  "removed_at"         timestamptz,                          -- soft-remove (never hard delete — Constitution III)
  "removed_by_user_id" uuid REFERENCES "users"("id")
);
CREATE INDEX "billing_adjustments_item_idx" ON "billing_adjustments" ("billing_item_id");
```

```ts
export const billingItems = pgTable(
  "billing_items",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    tripId: uuid("trip_id").notNull().references(() => trips.id),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    rateId: uuid("rate_id").references(() => rates.id),
    baseFreightCents: bigint("base_freight_cents", { mode: "number" }),
    currency: text("currency").notNull().default("BRL"),
    billingPeriod: text("billing_period").notNull(),
    disputeStatus: text("dispute_status").notNull().default("none"),
    exportBatchId: uuid("export_batch_id").references(() => exportBatches.id),
    notes: text("notes"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("billing_items_dispute_status_ck", sql`${table.disputeStatus} IN ('none','open','resolved')`),
    uniqueIndex("billing_items_trip_uq").on(table.tripId),
    index("billing_items_customer_period_idx").on(table.customerId, table.billingPeriod),
    index("billing_items_export_batch_idx").on(table.exportBatchId),
  ],
);

export const billingAdjustments = pgTable(
  "billing_adjustments",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    billingItemId: uuid("billing_item_id").notNull().references(() => billingItems.id),
    type: billingAdjustmentType("type").notNull(),
    amountCents: bigint("amount_cents", { mode: "number" }).notNull(),
    note: text("note"),
    createdByUserId: uuid("created_by_user_id").notNull().references(() => users.id),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    removedAt: timestamp("removed_at", { withTimezone: true }),
    removedByUserId: uuid("removed_by_user_id").references(() => users.id),
  },
  (table) => [index("billing_adjustments_item_idx").on(table.billingItemId)],
);
```

**Rules / invariants**
- **One `billing_items` per trip** (unique `trip_id`), created at billing-phase entry by `ensureBillingItem` (R7). `base_freight_cents` = the **executed value** (rate-derived or manual; FR-017); NULL until priced.
- **Billing lifecycle status is the `billingStatus(current_status)` projection** — `billing_items` carries **no status column** (FR-011, R5). `dispute_status` is the open-billing-dispute flag the §19.4 gate reads (CHECK text; the `disputed` status round-trip + full dispute workflow stay owned by 003/later — spec scope).
- **`export_batch_id`** links the item to its export run (BILL-008). The `billing_items → export_batches` FK is a forward reference — in the migration `export_batches` is created **before** `billing_items` (or the FK added after) so the reference resolves.
- **Typed adjustments** (BILL-004): each `billing_adjustments` row is one `type` + `amount_cents` (bigint) + optional `note` + `created_by` (R6). Computed **planned / executed / adjustment / final billable** are **derived** by `computeBillingValues` (§9.2), never stored (R5 — no drift).
- **Adjustments are soft-removed**, not hard-deleted (`removed_at`/`removed_by_user_id` set — Constitution III "never hard-delete an auditable financial row", mirroring `documents.archived_at`); `computeBillingValues` / `loadBillingItemView` read only **live** rows (`removed_at IS NULL`).
- **Mutable** (`edit_rates` — pricing/adjustments) → **NO REVOKE**. Audited `billing_item.update`.

---

## 7. New table — `export_batches` (PRD §14.1, BILL-007/008) — mirrors `import_batches`

```sql
CREATE TABLE "export_batches" (
  "id"                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "customer_id"         uuid NOT NULL REFERENCES "customers"("id"),
  "billing_period"      text NOT NULL,                       -- 'YYYY-MM'
  "format"              text NOT NULL,                       -- 'csv' | 'xlsx'
  "file_storage_key"    text,                                -- set when status='completed'
  "generated_by_user_id" uuid NOT NULL REFERENCES "users"("id"),
  "status"              "export_batch_status" NOT NULL DEFAULT 'queued',
  "trip_count"          integer NOT NULL DEFAULT 0,
  "total_amount_cents"  bigint NOT NULL DEFAULT 0,
  "error_message"       text,
  "created_at"          timestamptz NOT NULL DEFAULT now(),
  "updated_at"          timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT "export_batches_format_ck" CHECK ("format" IN ('csv','xlsx'))
);

CREATE INDEX "export_batches_customer_idx" ON "export_batches" ("customer_id");
CREATE INDEX "export_batches_created_idx"  ON "export_batches" ("created_at" DESC);
```

```ts
export const exportBatches = pgTable(
  "export_batches",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    customerId: uuid("customer_id").notNull().references(() => customers.id),
    billingPeriod: text("billing_period").notNull(),
    format: text("format").notNull(),
    fileStorageKey: text("file_storage_key"),
    generatedByUserId: uuid("generated_by_user_id").notNull().references(() => users.id),
    status: exportBatchStatus("status").notNull().default("queued"),
    tripCount: integer("trip_count").notNull().default(0),
    totalAmountCents: bigint("total_amount_cents", { mode: "number" }).notNull().default(0),
    errorMessage: text("error_message"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    check("export_batches_format_ck", sql`${table.format} IN ('csv','xlsx')`),
    index("export_batches_customer_idx").on(table.customerId),
    index("export_batches_created_idx").on(table.createdAt.desc()),
  ],
);
```

**Rules / invariants**
- **Mirrors `import_batches`** (RECON): a durable batch record with a status pgEnum (`queued→running→completed|failed`), counts, and an `error_message` on failure. The file (`file_storage_key`) lands in the `billing-exports` bucket (R8).
- Created `queued` by the BFF (`createExportBatch`), advanced by the `billing.export` worker job (R11); satisfies **BILL-008** export history.
- **Mutable** (status progression) → **NO REVOKE** (like `import_batches`). Audited `billing.export` at creation.

---

## 8. Reused tables / domain (read-only / driven, not redefined)

| Reused | Used for | Key columns / symbols |
|--------|----------|------------------------|
| `trips` (003) | completion/billing transitions via `transitionTripStatus`; FK target for documents/billing; **no ALTER** | `current_status`, `customer_id`, `lane_id`, `planned_vehicle_type`, planned windows, `original_plan` |
| `trip_events` (003) | the `status_change` rows the reused `transitionTripStatus` writes for completed/billing-phase transitions | append-only (keeps REVOKE) |
| `trip-status.ts` (003/`@brazil-tms/shared`) | `transitionTripStatus`, `canTransition`, `TRANSITIONS`, **`billingStatus(s)`** projection over `{billing_pending, billing_ready, billed, disputed}`, `ACTIVE_TRIP_STATUSES` | reused, never redefined (FR-007/009/011) |
| `customers`/`lanes` (002) | document requirements, rates, billing, export grouping; checklist/rate scope | `id`, `archived_at` |
| `vehicleType` enum (002) | optional checklist + rate scope | reused (no new enum) |
| `users` (001) | uploader / verifier / waiver author / adjustment author / export generator | `id` |
| `audit_logs` (001) | append-only document/rate/billing/export audit | append-only (keeps REVOKE) |
| `alerts` (007) | the `documents.checks` sweep lights up the two deferred §17 cases | `alert_case` CHECK text already includes `completed_missing_documents`, `billing_blocked_missing_proof`; `alerts_trip_case_open_uq` partial-unique |
| `packages/db/src/storage.ts` (004) | the service-role Supabase Storage client (app + worker) | extended with `documents`/`billing-exports` bucket helpers (R8) |
| `import_batches` (004) | the durable-batch + worker-job pattern `export_batches` + `billing.export` mirror | — |

The 003 status machine + `transitionTripStatus` + `billingStatus` projection, the 002 master data, the 005 read models, the 007 `alerts` store, and the 004 Storage client + worker/queue are **reused, never redefined** (Constitution I/III).

---

## 9. Domain logic (shared, pure)

### 9.1 Documents — `packages/shared/src/domain/documents.ts` (NEW)

```ts
export const DOCUMENT_VERIFICATION_STATUSES = ["pending_review", "accepted", "rejected"] as const;
export type DocumentVerificationStatus = (typeof DOCUMENT_VERIFICATION_STATUSES)[number];

/** Labeled-configurable fallback when a customer has no document_requirements rows (Input #3). */
export const DEFAULT_DOCUMENT_CHECKLIST = [
  { typeCode: "pod", requiredForCompletion: false, requiredForBilling: true },
] as const;

export interface RequiredType { documentTypeId: string; requiredForCompletion: boolean; requiredForBilling: boolean; }

/** Which required types are unmet for completion vs billing, given the satisfied (accepted-or-waived) set. */
export function evaluateChecklist(
  required: RequiredType[],
  satisfiedTypeIds: ReadonlySet<string>,
): { completionMissing: string[]; billingMissing: string[] };
```

Barrel: `export * from "./domain/documents"` in `packages/shared/src/index.ts` after `./domain/exceptions`.

### 9.2 Billing — `packages/shared/src/domain/billing.ts` (NEW)

Pure; the BFF/service gather context, the UI never decides (Constitution III; STACK §3.13 names **billing-readiness rules** a Vitest focus — mirrors `evaluateSlaRisk`).

```ts
export const BILLING_ADJUSTMENT_TYPES = [
  "toll", "waiting_time", "redelivery", "extra_stop", "penalty", "discount", "manual_adjustment",
] as const;
export type BillingAdjustmentType = (typeof BILLING_ADJUSTMENT_TYPES)[number];

export const EXPORT_FORMATS = ["csv", "xlsx"] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

export const EXPORT_BATCH_STATUSES = ["queued", "running", "completed", "failed"] as const;
export type ExportBatchStatus = (typeof EXPORT_BATCH_STATUSES)[number];

export interface AdjustmentInput { type: BillingAdjustmentType; amountCents: number; }

/** planned = rate base (or null); executed = baseFreightCents; adjustment = Σ (discounts subtracted); final = executed + adjustment. */
export function computeBillingValues(
  baseFreightCents: number | null,
  adjustments: AdjustmentInput[],
): { plannedCents: number | null; executedCents: number | null; adjustmentCents: number; finalBillableCents: number | null };

export type CompletionBlocker = "not_unloaded" | "missing_completion_documents" | "cancelled";
export type BillingBlocker = "not_billing_pending" | "missing_billing_documents" | "no_pricing" | "open_billing_dispute";

export function evaluateCompletionReadiness(ctx: {
  currentStatus: TripStatus;
  completionMissingDocuments: number;   // unmet required-for-completion types after waivers
}): { canComplete: boolean; blockers: CompletionBlocker[] };

export function evaluateBillingReadiness(ctx: {
  currentStatus: TripStatus;
  billingMissingDocuments: number;      // unmet required-for-billing types after waivers
  hasPricing: boolean;                  // base_freight_cents != null
  disputeStatus: "none" | "open" | "resolved";
}): { canBillReady: boolean; blockers: BillingBlocker[] };
```

**Encoded rules**
- **`computeBillingValues`**: `executed = baseFreightCents`; `adjustment = Σ(type==='discount' ? −amount : amount)` (discounts subtracted, all else added, `manual_adjustment` signed); `final = executed + adjustment` (null if `executed` null); `planned` = the matching rate's base (passed in, or null). (FR-017, BILL-005.)
- **`evaluateCompletionReadiness`** (§19.3): blocked unless `currentStatus === 'unloaded'` (`not_unloaded`), not cancelled, and `completionMissingDocuments === 0` (`missing_completion_documents`).
- **`evaluateBillingReadiness`** (§19.4): blocked unless `currentStatus === 'billing_pending'` (`not_billing_pending`), `billingMissingDocuments === 0` (`missing_billing_documents`), `hasPricing` (`no_pricing`), and `disputeStatus !== 'open'` (`open_billing_dispute`).
- Block-vs-warn (clarify) is applied by the **caller** (default block); the evaluator always **reports** blockers (never silently passes).

Barrel: `export * from "./domain/billing"` after `./domain/documents`.

### 9.3 Job contracts — `packages/shared/src/billing/jobs.ts` + `documents/jobs.ts` (NEW, siblings of `import/jobs.ts`/`sla/jobs.ts`)

```ts
// billing/jobs.ts
export const BILLING_JOBS = { billingExport: "billing.export" } as const;
export type BillingJobName = (typeof BILLING_JOBS)[keyof typeof BILLING_JOBS];
export interface BillingExportPayload { exportBatchId: string; actorUserId: string; }
export interface BillingJobPayloads { "billing.export": BillingExportPayload; }

// documents/jobs.ts
export const DOCUMENT_JOBS = { documentChecks: "documents.checks" } as const;
export type DocumentJobName = (typeof DOCUMENT_JOBS)[keyof typeof DOCUMENT_JOBS];
export type DocumentChecksPayload = Record<string, never>;   // scheduled cron — no per-run input
export interface DocumentJobPayloads { "documents.checks": DocumentChecksPayload; }
```

Barrels: `export * from "./billing/jobs"` and `export * from "./documents/jobs"`. (`workers/lib/queue.ts` merges `BILLING_JOBS`/`DOCUMENT_JOBS` into `JOB`/`JobPayloads`/`setupQueues`, exactly as it merges `IMPORT_JOBS`/`SLA_JOBS`.)

### 9.4 Audit actions — `packages/shared/src/audit/actions.ts` (EXTEND)

Add to **both** the `AuditAction` union **and** `ALL_AUDIT_ACTIONS` (lockstep — `satisfies` + the i18n guard test enforce):
```
"document.upload", "document.verify", "document.waive", "document.archive",
"document_requirement.create", "document_requirement.update",
"document_type.create", "document_type.update",
"rate.create", "rate.update", "billing_item.update", "billing.export"
```
- **Completion / Billing-Ready / Billed transitions reuse the existing `trip.status_change`** (driven through `transitionTripStatus` — no new action).
- The **derived** billing-value computation is not separately audited (only the persisted `billing_item.update` is); export-file generation is covered by `billing.export` at batch creation.
- i18n (R12): each new action needs **nested** `Trips.auditActions.*` (e.g. `auditActions.document.upload`) **and** flat `AuditActions` (`document_upload`, `document_verify`, `document_waive`, `document_archive`, `document_requirement_create`, `document_requirement_update`, `document_type_create`, `document_type_update`, `rate_create`, `rate_update`, `billing_item_update`, `billing_export`) — **never a dotted key** (MEMORY `next_intl_no_dot_in_keys`).

---

## 10. Zod schemas (shared) — `packages/shared/src/schemas/` (NEW; each `export *` in `src/index.ts`)

- **`document.ts`** — `uploadDocumentMetaSchema` (`documentTypeId` uuid, `externalReference?` ≤200, `notes?` ≤2000, `fileName` min 1; the binary rides multipart, validated for type/size in the route — R9); `verifyDocumentSchema` (`verificationStatus` `z.enum(DOCUMENT_VERIFICATION_STATUSES)`, `notes?`).
- **`document-requirement.ts`** — `createDocumentRequirementSchema`/`updateDocumentRequirementSchema` (`customerId` uuid, `documentTypeId` uuid, `requiredForCompletion`/`requiredForBilling` booleans, optional `laneId`/`vehicleType`, `active`); `createDocumentTypeSchema`/`updateDocumentTypeSchema` (`code` min 1, `labelPt` min 1, `active`, `sortOrder?`).
- **`rate.ts`** — `createRateSchema`/`updateRateSchema` (`customerId` uuid; optional `laneId`/`vehicleType`; `baseAmountCents` `z.number().int().nonnegative()`; `currency` default `'BRL'`; optional rule texts; effective dates `z.coerce.date().optional()`; `active`).
- **`billing.ts`** — `addBillingAdjustmentSchema` (`type` `z.enum(BILLING_ADJUSTMENT_TYPES)`, `amountCents` `z.number().int()`, `note?` ≤500); `updateBillingItemSchema` (`baseFreightCents?` int, `billingPeriod?` `/^\d{4}-\d{2}$/`, `disputeStatus?` `z.enum(['none','open','resolved'])`, `notes?`); `markCompletedSchema`/`markBillingReadySchema` (`waivedRequirements?: { documentTypeId: uuid, reason: string }[]`); `createExportSchema` (`customerId` uuid, `billingPeriod` `/^\d{4}-\d{2}$/`, `format` `z.enum(EXPORT_FORMATS)`).
- **`trip-board.ts`** (EXTEND) — add a `missingDocuments` filter param (`optParam(z.enum(["true","false"]))`) for the "Missing documents" view; add to `PARAM_KEYS`.

---

## 11. Service functions — `packages/db/src/` (NEW + EXTEND)

All mirror `transitionTripStatus`/`cancelTrip` (RECON): pre-tx legality outside the tx (a refused action changes no state) → one `db.transaction` doing the row write(s) + `writeAudit(tx, …)` → return the reloaded `loadTripDetail(tx, tripId)`. Conflicts `throw new Conflict(CODE, "pt-BR message")`.

- **`documents/documents.ts`** (NEW): `uploadDocument(tripId, { documentTypeId, fileStorageKey, externalReference, notes }, actor)` (insert `pending_review` + `document.upload`); `verifyDocument(documentId, { verificationStatus, notes }, actor)` (set status + verifier/`verified_at` + `document.verify`); `archiveDocument(documentId, actor)` (set `archived_at` + `document.archive`). (Waivers are written by the completion/billing services, R3/§11 below.)
- **`documents/requirements.ts`** (NEW): `createDocumentRequirement`/`updateDocumentRequirement` (+ `document_requirement.*` audit); `createDocumentType`/`updateDocumentType` (+ `document_type.*` audit); `listDocumentRequirements(customerId?)`, `listDocumentTypes()`, `resolveRequiredTypes(trip)` (the applicable rows for a trip, or `DEFAULT_DOCUMENT_CHECKLIST`).
- **`billing/rates.ts`** (NEW): `createRate`/`updateRate` (+ `rate.*` audit); `listRates(filters)`; `resolveRate(trip): Rate | null` (the precedence query, R4).
- **`billing/billing-items.ts`** (NEW): `ensureBillingItem(tx, tripId)` (insert one per trip if absent, `billing_period` = month of completion, `base_freight_cents` from `resolveRate` or null); `updateBillingItem(tripId, input, actor)` (manual base/period/dispute/notes + `billing_item.update`); `addBillingAdjustment(tripId, input, actor)` / `removeBillingAdjustment(adjustmentId, actor)` (**soft-remove** — sets `removed_at`/`removed_by_user_id`, never hard-deletes) (+ `billing_item.update`); `loadBillingItemView(tx, tripId)` (item + **live** (`removed_at IS NULL`) adjustments + `computeBillingValues`).
- **`trips/completion.ts`** (NEW): `markCompleted(tripId, input, actor)` and `markBillingReady(tripId, input, actor)` — R7: gather ctx → pure evaluator → record `input.waivedRequirements` as waiver rows (+ `document.waive`) → `transitionTripStatus` (reused) → (completion) auto-advance to `billing_pending` + `ensureBillingItem`. Conflicts `COMPLETION_BLOCKED` / `BILLING_READY_BLOCKED` (with missing types as `findings`).
- **`billing/export.ts`** (NEW): `createExportBatch({ customerId, billingPeriod, format }, actor)` — verify a non-empty billing-ready set (`NO_BILLABLE_TRIPS` if none), insert `export_batches` (`queued`) + `billing.export` audit, **enqueue** the `billing.export` worker job (`apps/web/lib/billing/queue.ts`), return the batch.
- **Read-model extensions** (`trips/trip-dto.ts`, `trips/trips-read.ts`) — §13/R13.

New `packages/db/src/index.ts` re-exports: the document/requirement/rate/billing/completion/export services + the new read-model functions + `export * from "../schema"` (barrel already re-exports the new tables).

---

## 12. Worker jobs — `workers/jobs/` (NEW; R11)

- **`workers/jobs/billing-export/index.ts`** (NEW): `runBillingExport({ exportBatchId, actorUserId })` + `registerBillingExport(boss)` — `work(boss, JOB.billingExport, …)` (on-demand, no schedule). Set `running` → load batch `customer_id`+`billing_period` → select billing-ready trips + computed values → ExcelJS `.xlsx.writeBuffer()` / `.csv.writeBuffer()` (per `format`) → `putExport` → set `file_storage_key`/`trip_count`/`total_amount_cents`/`completed` → `transitionTripStatus(trip, { toStatus: 'billed', expectedFromStatus: 'billing_ready' }, actor)` per trip (configurable lock/flag; default lock); a throw ⇒ `setExportBatchFailed(error)` (durable status). Idempotent retry skips already-`billed` trips.
- **`workers/jobs/document-checks/index.ts`** (NEW): `runDocumentChecks()` + `registerDocumentChecks(boss)` — `work` + `boss.schedule(JOB.documentChecks, process.env.DOCUMENT_CHECKS_CRON ?? "*/5 * * * *", {}, {})` (the **second** scheduled job, mirroring `sla-sweep`). Sweep **billing-phase trips** (`current_status ∈ {billing_pending, billing_ready}`), per-trip fault isolation (try/catch skip-and-continue), evaluate **two distinct per-case conditions** and **generate/auto-resolve each independently** via the **007 `alerts` store**: **case 7 `completed_missing_documents`** = the trip has **≥1 unmet required document of any kind** (any non-archived required type lacking an accepted-or-waived document); **case 8 `billing_blocked_missing_proof`** = `evaluateBillingReadiness` returns the **`missing_billing_documents`** blocker (blocked *specifically* by missing required-for-billing proof — the spec's "once a Billing Item is blocked", FR-025/US2-AS5 — **not** merely `no_pricing`/`open_billing_dispute`). Per case: `INSERT … ON CONFLICT (alerts_trip_case_open_uq) DO NOTHING` to generate; conditional `UPDATE … state='resolved'` when that case clears. (Case 7 also feeds the `completedMissingDocuments` dashboard metric.) Per-sweep summary log (`evaluated`, `alerts_created`, `alerts_resolved`, `errors`).
- **`workers/jobs/index.ts`** (EXTEND): `await registerBillingExport(boss); await registerDocumentChecks(boss);`
- **`workers/lib/queue.ts`** (EXTEND): `JOB = { ...IMPORT_JOBS, ...SLA_JOBS, ...BILLING_JOBS, ...DOCUMENT_JOBS }`; `JobName`/`JobPayloads` unions extended; `setupQueues` loop already iterates `Object.values(JOB)`.
- **`apps/web/lib/billing/queue.ts`** (NEW): `enqueueBillingExport(payload)` (mirrors `apps/web/lib/imports/queue.ts` `getBoss()` + `enqueueImportJob`).

---

## 13. Read-model extensions — `packages/db/src/trips/` (EXTEND, R13)

### `trip-dto.ts` / `loadTripDetail`
- Add `documents: DocumentDto[]` (non-archived rows + type code/label, verification, waiver, external ref) and `billing: BillingItemView | null` (item + adjustments + computed `planned/executed/adjustment/finalBillable` from `computeBillingValues`, + `missingBillingDocuments`/`missingCompletionDocuments` summaries) to `TripDetail`, loaded in the **same** `loadTripDetail` executor (fills the 005 placeholders; DRY).

### `trips-read.ts`
- `queryDashboardMetrics` **fills `completedMissingDocuments`** (count of billing-phase trips with ≥1 unmet required-for-billing document) — replacing the hardcoded `null` (the dashboard `metric()` helper auto-flips placeholder→value).
- New reads: `queryBillingList({ scope: 'pending'|'ready', customerId?, billingPeriod? })` (FR-019 — reuses the `boardSelect` join shape filtered on the `billingStatus` projection + the computed final value + a missing-proof indicator); `queryExportBatches(customerId?, billingPeriod?)` (BILL-008 history); `queryRates`/`queryDocumentRequirements`/`queryDocumentTypes` (admin lists).
- `buildWhere` gains the `missingDocuments` board filter (trips with an unmet required-for-billing doc) for the "Missing documents" view.

---

## 14. Migration `packages/db/migrations/0007_*.sql` (R14)

One drizzle migration (next after `0006_large_carmella_unuscione.sql`; journal idx 0–6 ⇒ this is `0007`), from the new schema files + the `packages/db/schema/index.ts` barrel (add `export * from "./document-types"`, `"./documents"`, `"./document-requirements"`, `"./rates"`, `"./billing-items"`, `"./billing-adjustments"`, `"./export-batches"`). Contents:
- `CREATE TYPE` × 3 — `document_verification_status`, `export_batch_status`, `billing_adjustment_type` (§1), ordered before first use.
- `CREATE TABLE` × 7 — `document_types`, `documents`, `document_requirements`, `rates`, **`export_batches`** (before `billing_items` so the `export_batch_id` FK resolves), `billing_items`, `billing_adjustments` — with FKs, the `documents_file_or_waiver_ck` / `billing_items_dispute_status_ck` / `export_batches_format_ck` CHECKs, the `billing_items_trip_uq` unique, and all indexes.
- **No `trips` ALTER** (FR-011 — projection, not a column; the tables FK to `trips`).
- **NO REVOKE** for the seven tables — they **mutate** (verification, billing values/adjustments, export-batch status, soft-delete), like `import_batches`/`trip_assignments` (not append-only). `trip_events`/`audit_logs` keep their existing REVOKE.
- `meta/_journal.json` + snapshots updated by the tool.

**Hand-edit / hand-verify**: (1) `CREATE TYPE` × 3 ordered before first column use; (2) `documents_file_or_waiver_ck` two-column CHECK; (3) `billing_items_trip_uq` unique on `trip_id`; (4) `export_batches` created **before** `billing_items` (FK ordering) and the `billing_items.export_batch_id` FK; (5) `export_batches.format` + `billing_items.dispute_status` CHECK text. (No `text[]` column and no cross-feature FK on a pre-existing column this time.)

---

## 15. Seeds + Storage buckets

- **`db:seed:document-types`** (NEW): the 5 labeled-scaffolding types (`pod`, `cte`, `mdfe`, `gate_receipt`, `portal_ref`) with pt-BR labels — NOT final business sign-off (Constitution II; mirrors 007's reason-code seed).
- **`db:seed:rates`** (NEW, optional): one sample rate so billing is demonstrable; customers without a matching rate use a manual amount + billing-rule sign-off blocked.
- **Document requirements**: **not seeded** (per-customer, gated §29 Input #3) — absence ⇒ `DEFAULT_DOCUMENT_CHECKLIST` + sign-off blocked.
- **Storage buckets**: ensure `documents` and `billing-exports` buckets exist (idempotent `createBucket` at setup / documented step — mirrors how `imports` is provisioned, R8). New env vars `DOCUMENTS_BUCKET`, `EXPORTS_BUCKET`, `DOCUMENT_MAX_BYTES`, `DOCUMENT_CHECKS_CRON` added to `apps/web/.env.local.example`, `workers/.env`, and the docker-compose worker env.

---

## 16. State & lifecycle (reused, not redefined)

**Completion / billing transitions reuse the 003 machine** (no new edge — `markCompleted`/`markBillingReady`/export drive existing `TRANSITIONS`):
```
unloaded       --markCompleted-->        completed        (gate: §19.3 + completion docs; trip.status_change)
completed      --auto (§11.6 step6)-->   billing_pending  (+ ensureBillingItem)
billing_pending--markBillingReady-->     billing_ready    (gate: §19.4 + billing docs + pricing + dispute)
billing_ready  --billing.export job-->   billed           (per included trip; configurable lock/flag)
```
**Document lifecycle**: `pending_review → accepted | rejected` (verify); a row is `archived` (soft-delete) or is a **waiver** (no file, `waived_at`). Requirement satisfied = accepted OR waived.

**Billing-status** is the **`billingStatus(current_status)` projection** (never a hand-edited state; FR-011). **Billing values** (planned/executed/adjustment/final) are a **computed projection** of `base_freight_cents` + `billing_adjustments` (never stored; R5/R6).

**Export-batch lifecycle** (mirrors `import_batches`): `queued → running → completed | failed` (durable status, R11).
