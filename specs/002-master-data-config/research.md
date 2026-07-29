# Phase 0 Research: Master Data and Operational Configuration

**Feature**: 002-master-data-config | **Spec**: [spec.md](./spec.md) | **Date**: 2026-05-29

All four `/speckit-clarify` decisions (Session 2026-05-29) and the two `/speckit-specify` gating inputs
are resolved in the spec, so there are **no open `NEEDS CLARIFICATION` items**. This document records the
design decisions (Decision / Rationale / Alternatives) that turn the clarified spec into a buildable plan,
grounded in the **already-implemented feature 001 code** this feature extends.

## R0 — Build on feature 001's primitives (do not rebuild)

- **Decision**: Reuse, unchanged, the primitives 001 shipped: `requireAuth()` + `requirePermission(ctx, key)`
  (`apps/web/lib/auth/require-auth.ts`), the static permission catalog + `can()`
  (`packages/shared/src/auth/permissions.ts`), `writeAudit(tx, entry)` (`apps/web/lib/audit/write-audit.ts`)
  writing to `public.audit_logs`, `handleRouteError()` + `Conflict` (`apps/web/lib/api/respond.ts`),
  the `next-intl` pt-BR catalog (`apps/web/messages/pt-BR.json`), formatting helpers
  (`packages/shared/src/formatting.ts`), the Drizzle client `db` (`@brazil-tms/db`), and the `(shell)` layout.
- **Rationale**: Constitution I (DRY/YAGNI) and the 001 exit criterion that later features consume the
  reusable auth/audit foundation. 002 is a consumer of that foundation, not a re-implementer.
- **Alternatives**: A 002-local auth/audit layer — rejected (duplicates the single source of truth,
  violates FR-025/FR-028 intent and Constitution IV).

## R1 — Soft-delete (archive) representation

- **Decision**: Every master-data table gets a nullable `archived_at timestamptz` (NULL = active,
  non-NULL = archived). "Active status" in the PRD field lists is the derived predicate `archived_at IS NULL`.
  Lists default to active-only (`WHERE archived_at IS NULL`); an explicit `?includeArchived=true` returns all.
- **Rationale**: Constitution III mandates soft-delete/archival, never hard delete, for auditable entities.
  A single timestamp captures both the flag and *when*, is trivial to filter, and avoids a redundant boolean.
- **Alternatives**: (a) a `status` enum carrying `archived` (as 001's `users.status` does) — rejected for
  master data because resources *separately* need the 5-value operational status (R3); overloading one
  column would conflate "archived" with "inactive". (b) a boolean `is_active` — rejected (loses the timestamp).

## R2 — Reuse `delete_archive`; add exactly two new permission keys

- **Decision**: Add two `PermissionKey`s to the catalog: `manage_commercial_data` (customers, locations,
  lanes) and `manage_fleet_data` (drivers, vehicles, trailers, carriers). Map per Clarification Q1:
  `manage_commercial_data` → {admin, operations_manager}; `manage_fleet_data` → {admin, operations_manager,
  fleet_coordinator}. **Archive** of any master-data record reuses the existing Admin-only `delete_archive`
  key (PRD §18 "Delete / archive records"; FR-027). **Reads** of a master-data area require that area's
  *manage* permission (no separate view key).
- **Rationale**: §18 has no master-data create/edit row, and no existing key matches the clarified role sets
  (`assign_resources` includes Dispatcher, so it is not `manage_fleet_data`). Two keys are the minimum that
  expresses "Fleet Coordinator manages fleet but not commercial data" (STACK §3.8: a distinct permission only
  where roles genuinely differ). Gating reads by the manage permission avoids a no-op `view_master_data` key
  that every role would hold (YAGNI) — these are management screens for managers.
- **Alternatives**: (a) one `manage_master_data` key — rejected (cannot express the commercial/fleet split).
  (b) a `view_master_data` granted to all 7 roles — rejected (adds zero security; downstream features 006+
  read the same tables through their own permissions/services per SC-011). (c) a DB permissions table —
  rejected (Constitution V; roles stay a code enum).
- **Note**: This edits the code catalog (the matrix doc anticipated "no edits"); extending the single
  code-defined catalog is DRY-compliant and is the correct home for new keys. Recorded in plan.md.

## R3 — Operational status enum, orthogonal to archive

- **Decision**: New `resource_status` pgEnum `['active','inactive','unavailable','maintenance','blocked']`
  on drivers, vehicles, and trailers, default `'active'`. It is **independent** of `archived_at`: an archived
  resource is out of operational use regardless of status; `inactive` means "exists, not in service" (not
  soft-deleted). No constrained transition graph in MVP — any status→any status is allowed (audited).
- **Rationale**: RES-007 enumerates exactly these five values; the spec edge case explicitly separates
  `inactive` from `archived`. Constitution III wants explicit enumerated states (Postgres enum, not free text).
- **Alternatives**: A transition state-machine (like trips) — rejected (YAGNI; resource availability has no
  business-rule-bearing legal-transition set in the PRD). Customers/locations/lanes/carriers get **no**
  operational status (only `archived_at`), matching their PRD field lists.

## R4 — Owned vs subcontracted (Clarification Q2)

- **Decision**: New `ownership_type` pgEnum `['owned','subcontracted']` (NOT NULL) on drivers, vehicles, and
  trailers, plus a nullable `carrier_id` FK → `carriers.id`. A DB CHECK enforces the invariant:
  `(ownership_type='subcontracted' AND carrier_id IS NOT NULL) OR (ownership_type='owned' AND carrier_id IS NULL)`.
  One unified list per resource type (no separate owned/subcontracted areas). Vehicles/trailers also keep a
  free-text `owner` for the owned case (lease/finance party); drivers keep `employer` text.
- **Rationale**: Clarification Q2 + PRD §14.1 (resources carry both *owner* and *carrier* fields). The CHECK
  makes FR-022/FR-023 a database invariant, not just app logic. Assignment-policy consequences are feature
  006 (FR-024) and are out of scope.
- **Alternatives**: Derive ownership implicitly from `carrier_id IS NULL` (no explicit flag) — rejected by Q2
  (explicit mandatory flag chosen). Separate tables per ownership — rejected (Q2; duplicates UI/queries).

## R5 — Locations are customer-scoped (Clarification Q3)

- **Decision**: `locations.customer_id` is a NOT NULL FK → `customers.id`. Uniqueness is per customer:
  `UNIQUE (customer_id, code)`. Lane integrity (origin/destination belong to the lane's customer, both active,
  customer active) is enforced in the **service layer** at create/edit (it spans rows, so not a single CHECK);
  a CHECK enforces `origin_location_id <> destination_location_id` (degenerate-lane guard, FR edge case).
- **Rationale**: PRD §14.1 "Customer-specific code" + Clarification Q3. Per-customer scoping keeps one
  customer's sites out of another's lane picker and matches the per-customer import model.
- **Alternatives**: Global locations / global code uniqueness (Q3 option B) and global+alias (option C) —
  both rejected by the clarification.

## R6 — Vehicle/trailer type as fixed code enums (Clarification Q4)

- **Decision**: `vehicle_type` pgEnum (shared by `vehicles.vehicle_type` and `lanes.default_vehicle_type` for
  later DISP-006 compatibility) and a separate `trailer_type` pgEnum. MVP default sets (extensible only via
  migration), expressed as Brazilian linehaul classes:
  - `vehicle_type`: `['van','vuc','tres_quartos','toco','truck','bitruck','carreta','carreta_ls','bitrem','rodotrem']`
  - `trailer_type`: `['sider','bau','graneleiro','tanque','frigorifico','prancha','cacamba','porta_container']`
- **Rationale**: Q4 chose a fixed code enum (not free text, not admin-managed); §15.12 lists the
  admin-managed config areas and does not include vehicle types. Shared `vehicle_type` enables lane↔vehicle
  matching. Trailer type mirrors the same controlled-value rationale (Q4 by extension).
- **Alternatives**: Free text (Q4 option C) — rejected (breaks compatibility matching). Admin-managed lookup
  table (Q4 option B) — rejected (Q4 + §15.12; would add an admin CRUD area, YAGNI for MVP).
- **Labeling (Constitution II)**: The concrete value lists are **documented defaults**; they are confirmable
  with Ops but, being a code enum, do not block (a new class is a one-line migration). Recorded as such.

## R7 — Money as integer minor units; BRL is an app-wide constant

- **Decision**: `lanes.standard_rate_cents bigint` and `lanes.toll_estimate_cents bigint` (nullable),
  integer minor units (centavos). No per-row currency column for MVP — currency is the app-wide constant BRL
  (Constitution: currency BRL). Display via `formatBRL` (`packages/shared/src/formatting.ts`).
- **Rationale**: STACK/Constitution: money as integer minor units (never floats). A per-row currency code in a
  single-currency MVP is YAGNI; the formatter already hard-codes BRL.
- **Alternatives**: `numeric` money columns — rejected (float/precision risk). Per-row currency code now —
  deferred until multi-currency exists; the migration to add it later is additive.
- **Boundary**: Rate *tables* and billing rate logic remain feature 008 (FR-010); the lane stores a single
  reference amount as master data.

## R8 — Contacts modeled as `jsonb`, not a shared child table

- **Decision**: `customers.contacts jsonb` (array of `{name, email?, phone?, role?}`) + `customers.billing_contact
  jsonb` (nullable `{name, email?, phone?}`); `carriers.contact jsonb` (nullable); locations use scalar
  `gate_instructions text`. All validated by Zod at the BFF boundary.
- **Rationale**: Constitution I — abstract only after ≥3 identical repetitions. Contact shapes differ across
  the three entities (array vs single vs text), so a shared `contacts` table is premature. jsonb + Zod keeps
  the schema flat and the validation shared.
- **Alternatives**: A normalized `contacts` table with polymorphic owner — rejected (premature abstraction;
  no query needs cross-entity contact search in MVP).

## R9 — Documentation-expiry state is derived, not stored (Clarification Q5)

- **Decision**: Resources store the expiry **date(s)** only: `drivers.license_expiry date`,
  `vehicles.document_expiry date`, `trailers.document_expiry date`. The warning state is computed by a pure
  shared helper `documentExpiryState(expiry, now, windowDays = DOCUMENT_EXPIRY_WARNING_DAYS): 'ok' |
  'expiring' | 'expired'` (`packages/shared`). The window default is a single exported constant
  `DOCUMENT_EXPIRY_WARNING_DAYS = 30` in `packages/shared` (the configuration source of record — not hard-coded
  at call sites and not per-call literals); `expiring` = within the window; `expired` = on/after the date.
- **Rationale**: Q5 (30-day configurable window). Deriving from the date avoids a stored, drift-prone flag and
  keeps the rule in one tested place. Resolves the prior FR-017/SC-009 mismatch (both now cover
  expiring + expired).
- **Alternatives**: A stored `doc_status` column — rejected (must be recomputed daily; drifts). A per-document
  child table — deferred (MVP tracks one primary expiry per resource; multi-document is a fast-follow).

## R10 — Audit actions and write pattern

- **Decision**: Extend the `AuditAction` union (`packages/shared/src/audit/actions.ts`) with
  `<entity>.create`, `<entity>.update`, `<entity>.archive` for all seven entities, plus
  `<entity>.status_change` for `driver`/`vehicle`/`trailer`. Each mutation calls `writeAudit(tx, …)` inside the
  **same Drizzle transaction** (as 001's `users` service does), with `previousValue`/`newValue` snapshots of
  only the changed fields. `entity_type` is the singular entity name (`'customer'`, `'lane'`, …).
- **Rationale**: FR-028 + STACK §5.4 ("customer updates", "manual edits"); same-transaction write makes a
  critical change impossible to lose (SC-006). Matches the established 001 pattern exactly.
- **Alternatives**: DB triggers — rejected (STACK §6.2 keeps audited mutations in the testable BFF). A generic
  `audit(table, op)` wrapper — deferred until ≥3 entities prove an identical call site (Constitution I);
  start with explicit per-service calls.

## R11 — Validation, lists, and freshness

- **Decision**: Zod schemas in `packages/shared/src/schemas/master-data.ts` (one create/update schema per
  entity), imported by both BFF and forms (react-hook-form + zod resolver), with inline pt-BR messages.
  List endpoints return `{ items: T[] }` filtered by query params (`q`, entity-specific filters,
  `includeArchived`), ordered `created_at DESC`, no server-side pagination in MVP. UI uses TanStack Query
  polling (`staleTime ≈ 30s`); **no Realtime** (Constitution).
- **Rationale**: Mirrors 001's `listUsers` pattern and DRY validation. Master-data volumes are modest for MVP;
  a flat array keeps it simple.
- **Alternatives**: Cursor/offset pagination now — deferred (YAGNI); flagged as a fast-follow if a list
  (e.g. vehicles) grows large. Standardized on `{ items: T[] }` (vs 001's entity-named key) so the master-data
  list client is generic across seven entities.
- **Field formats**: CNPJ (`tax_id`) and BR plate (incl. Mercosul) get basic Zod format checks + DB
  uniqueness; no external validation service (KISS). `state` is the 2-letter UF; `country` defaults `'BR'`.

## R12 — What is explicitly NOT built (scope guard, Constitution II)

- No SLA, document-requirement, or import-template columns/UI (features 007/008/004) — the customer record is
  their future anchor; those columns are added by those features.
- No carrier `approved_customers` / `approved_lanes` associations (PRD §14.1) — enforcement is feature 006;
  storing them now would be unused (YAGNI). Added when 006 needs them.
- No resource calendars / planned unavailability (RES-008, Later).
- No `workers/` usage — master-data CRUD has no background work.
- No restore/unarchive UI in MVP — the model supports it (`archived_at = NULL`, `delete_archive`); a
  `*.unarchive` action + endpoint is a trivial fast-follow, intentionally deferred to keep the slice minimal.
