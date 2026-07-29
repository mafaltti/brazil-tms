---
description: "Task list for 002 — Master Data and Operational Configuration"
---

# Tasks: Master Data and Operational Configuration

**Input**: Design documents from `specs/002-master-data-config/`

**Prerequisites**: plan.md, spec.md, research.md (R0–R12), data-model.md, contracts/ (bff-endpoints.md, permission-matrix.md), quickstart.md

**Tests**: INCLUDED. The plan (Technical Context → Testing), quickstart (Tests), and the constitution
(permission checks are an explicit Vitest/Playwright quality gate) make Vitest + Playwright required for this
feature, so test tasks are first-class below.

**Organization**: Tasks are grouped by the five user stories from spec.md so each story is an independently
testable increment. This feature **extends the implemented feature-001 monorepo** — it reuses `requireAuth()` /
`requirePermission()`, `writeAudit()`, `handleRouteError()`/`Conflict`, `next-intl` (pt-BR), `formatBRL`, the
Drizzle `db`, and the `(shell)` layout (research R0). No new package/service; `workers/` stays unused.

## Format: `[ID] [P?] [Story] Description with file path`

- **[P]**: parallelizable (different files, no dependency on an incomplete task)
- **[Story]**: US1–US5 (story-phase tasks only); Setup/Foundational/Polish carry no story label

## Path conventions

Monorepo: `packages/db/` (Drizzle schema + migrations), `packages/shared/src/` (Zod/permissions/audit/format),
`apps/web/` (BFF route handlers, services, `(shell)` pages, components, e2e). Commercial entities = customers,
locations, lanes (`manage_commercial_data`); fleet entities = drivers, vehicles, trailers, carriers
(`manage_fleet_data`); archive = `delete_archive` (Admin only).

---

## Phase 1: Setup (Shared Infrastructure)

**Purpose**: Confirm the running stack and create this feature's source folders.

- [X] T001 Verify the dev stack runs per quickstart.md (`pnpm install`; `docker compose -f infra/supabase/docker-compose.yml up -d`; `pnpm --filter @brazil-tms/db db:migrate`; `pnpm --filter @brazil-tms/db db:seed`; `pnpm --filter @brazil-tms/web dev` boots at :3000)
- [X] T002 [P] Create feature source folders: `apps/web/lib/master-data/`, `apps/web/components/master-data/`, `apps/web/app/api/master-data/`, `apps/web/app/(shell)/admin/`, `apps/web/app/(shell)/resources/`

---

## Phase 2: Foundational (Blocking Prerequisites)

**Purpose**: Shared schema, migration, permissions, audit actions, validation helpers, and reusable UI that
ALL user stories depend on. The seven tables ship in one atomic migration because of cross-entity FKs
(resources → carriers; lanes → customers/locations).

**⚠️ CRITICAL**: No user-story work can begin until this phase is complete.

### Database (packages/db)

- [X] T003 Extend `packages/db/schema/enums.ts` with pgEnums `resource_status`, `ownership_type`, `vehicle_type`, `trailer_type` (value sets per data-model.md R3/R4/R6)
- [X] T004 [P] Create `packages/db/schema/customers.ts` (`customers` table per data-model §1; `customer_code` UNIQUE, `contacts`/`billing_contact` jsonb, `archived_at`)
- [X] T005 [P] Create `packages/db/schema/carriers.ts` (`carriers` table per data-model §7; `tax_id` UNIQUE, `contract_status`/`documentation_status` text + CHECK, `archived_at`)
- [X] T006 Create `packages/db/schema/locations.ts` (`locations` per data-model §2; `customer_id` FK NOT NULL, `UNIQUE(customer_id, code)`) — depends on T004
- [X] T007 [P] Create `packages/db/schema/drivers.ts` (`drivers` per data-model §4; `ownership_type`, nullable `carrier_id` FK, `status`, `license_expiry`, ownership/carrier CHECK) — depends on T003, T005
- [X] T008 [P] Create `packages/db/schema/vehicles.ts` (`vehicles` per data-model §5; `vehicle_type`, `ownership_type`+`carrier_id` CHECK, tracker fields, `document_expiry`, `plate` UNIQUE) — depends on T003, T005
- [X] T009 [P] Create `packages/db/schema/trailers.ts` (`trailers` per data-model §6; `trailer_type`, ownership CHECK, `document_expiry`, `plate` UNIQUE) — depends on T003, T005
- [X] T010 Create `packages/db/schema/lanes.ts` (`lanes` per data-model §3; FKs to customers + two locations, `default_vehicle_type`, `*_cents` money, `CHECK origin <> destination`) — depends on T003, T004, T006
- [X] T011 Export all new tables from `packages/db/schema/index.ts` — depends on T004–T010
- [X] T012 Generate the migration: `pnpm --filter @brazil-tms/db db:generate`; review the SQL in `packages/db/migrations/` (public schema only; auth.* untouched; confirm enums, FKs, CHECKs, UNIQUE indexes) — depends on T011
- [X] T013 Apply the migration: `pnpm --filter @brazil-tms/db db:migrate`; verify tables/enums exist — depends on T012

### Shared (packages/shared)

- [X] T014 [P] Extend the permission catalog in `packages/shared/src/auth/permissions.ts`: add `manage_commercial_data` and `manage_fleet_data` to `PermissionKey` + `ALL_PERMISSIONS`; grant `manage_commercial_data` and `manage_fleet_data` to `operations_manager`, and `manage_fleet_data` to `fleet_coordinator` in `ROLE_PERMISSIONS` (Admin inherits via `ADMIN_PERMISSIONS`) — per contracts/permission-matrix.md
- [X] T015 [P] Add permission-catalog invariants to `packages/shared/src/auth/permissions.test.ts` (Fleet Coord has `manage_fleet_data` but NOT `manage_commercial_data`; only admin+ops have commercial; `delete_archive` admin-only; Admin superset) — depends on T014
- [X] T016 [P] Extend the `AuditAction` union in `packages/shared/src/audit/actions.ts` with the ~24 master-data actions (`<entity>.create|update|archive` for all 7; `+ .status_change` for driver/vehicle/trailer) per data-model.md
- [X] T017 [P] Add exported constant `DOCUMENT_EXPIRY_WARNING_DAYS = 30` and pure helper `documentExpiryState(expiry, now, windowDays = DOCUMENT_EXPIRY_WARNING_DAYS): 'ok'|'expiring'|'expired'` to `packages/shared/src/formatting.ts` (the window's single config source — not hard-coded at call sites) and export both (R9)
- [X] T018 [P] Add Vitest for `documentExpiryState` in `packages/shared/src/formatting.test.ts` (past → expired; within 30d → expiring; beyond → ok; null → ok) — depends on T017
- [X] T019 Create `packages/shared/src/schemas/master-data.ts` with shared Zod building blocks reused by every entity: `contactSchema`, `cnpjSchema` (tax_id), `plateSchema` (BR/Mercosul), `ufSchema` (2-letter), `moneyCentsSchema` (non-neg int), `coordSchema`, `resourceStatusSchema`, `ownershipTypeSchema`, `vehicleTypeSchema`, `trailerTypeSchema`, and an `ownershipCarrierRefine` helper — pt-BR messages; export from `packages/shared/src/index.ts`

### Shared client + UI (apps/web)

- [X] T020 [P] Add `apps/web/lib/master-data/client.ts`: TanStack Query hooks + fetch wrappers (`staleTime ≈ 30s`, no Realtime) and the `{ items: T[] }` list-response types/error mapping reused by all master-data screens
- [X] T021 [P] Add reusable `apps/web/components/master-data/master-data-table.tsx` (TanStack Table list: search, `includeArchived` toggle, archived badge, row → detail, archive action gated by `delete_archive`) — justified by 7 immediate consumers (Constitution I, ≥3 rule)
- [X] T022 [P] Add reusable `apps/web/components/master-data/entity-form.tsx` (shadcn/ui + react-hook-form + zod resolver shell, field components, 400/409 error surfacing in pt-BR) — depends on T020
- [X] T023 [P] Scaffold i18n namespaces in `apps/web/messages/pt-BR.json` (`MasterData`, `Resources`, `Common` — shared labels: status values, ownership, archive/active, validation)

**Checkpoint**: Schema migrated, permissions/audit/validation/UI primitives ready — stories can begin.

---

## Phase 3: User Story 1 — Maintain customers (Priority: P1) 🎯 MVP

**Goal**: Authorized users (Admin, Ops Manager) create/edit/list customers and Admin archives them; duplicates rejected; changes audited.

**Independent Test**: Create a customer with required fields → appears in list; edit → persists; archive → leaves active list but retrievable via `includeArchived`; duplicate `customerCode` → rejected; SLA/docs/templates not editable here.

- [X] T024 [P] [US1] Add `createCustomerSchema` + `updateCustomerSchema` (partial) to `packages/shared/src/schemas/master-data.ts` (name, legalName?, customerCode, taxId?, contacts[], billingContact?) — depends on T019
- [X] T025 [P] [US1] Vitest for customer schemas in `packages/shared/src/schemas/master-data.test.ts` (required fields, CNPJ format, contacts shape)
- [X] T026 [US1] Implement `apps/web/lib/master-data/customers-service.ts` (`list/get/create/update/archive`; duplicate-code → `Conflict('DUPLICATE_CUSTOMER_CODE')`; `writeAudit` `customer.*` in the same transaction; map row → API shape) — depends on T013, T016, T024
- [X] T027 [US1] Vitest for customers-service in `apps/web/lib/master-data/customers-service.test.ts` (duplicate rejected, archive sets `archived_at` + emits `customer.archive`, create emits `customer.create`)
- [X] T028 [US1] Implement `apps/web/app/api/master-data/customers/route.ts` (`GET` list + `POST` create; `requireAuth` + `requirePermission(ctx,'manage_commercial_data')`; `handleRouteError`) — depends on T014, T026
- [X] T029 [P] [US1] Implement `apps/web/app/api/master-data/customers/[id]/route.ts` (`GET` detail, `PATCH` update → `manage_commercial_data`; `DELETE` archive → `delete_archive`) — depends on T026
- [X] T030 [US1] Build customers list page `apps/web/app/(shell)/admin/customers/page.tsx` using `MasterDataTable` + the list hook — depends on T021, T028
- [X] T031 [US1] Build customer detail/create page `apps/web/app/(shell)/admin/customers/[id]/page.tsx` (and `new`) using `EntityForm` + customer schema — depends on T022, T024, T029
- [X] T032 [US1] Register the Customers nav item in `apps/web/lib/nav.ts` (`/admin/customers`, permission `manage_commercial_data`)
- [X] T033 [US1] Add customer pt-BR strings to `apps/web/messages/pt-BR.json` (`MasterData.customers.*`)
- [X] T034 [US1] Playwright e2e `apps/web/e2e/master-data-customers.spec.ts` (create → list → edit → archive → duplicate-code rejected; SLA/docs/templates absent)

**Checkpoint**: Customers fully functional and independently testable (MVP).

---

## Phase 4: User Story 2 — Maintain locations and lanes (Priority: P1)

**Goal**: Maintain customer-scoped locations and create lanes between two of a customer's locations with operational attributes; integrity + archive enforced; changes audited.

**Independent Test**: Create a customer + two of its locations; create a lane between them (transit, default vehicle type, rate, toll); a lane with a different-customer location or origin = destination is rejected; archiving a referenced location excludes it from new lane selection but leaves existing lanes intact.

- [X] T035 [P] [US2] Add `createLocationSchema`/`updateLocationSchema` to `packages/shared/src/schemas/master-data.ts` (customerId, code, name, address?, city?, state? (UF), country='BR', lat?/lng?, gateInstructions?) — depends on T019
- [X] T036 [P] [US2] Add `createLaneSchema`/`updateLaneSchema` (customerId, originLocationId, destinationLocationId, expectedTransitMinutes?, defaultVehicleType?, standardRateCents?, tollEstimateCents?, standardDistanceKm?; refine origin ≠ destination) — depends on T019
- [X] T037 [P] [US2] Vitest for location + lane schemas in `packages/shared/src/schemas/master-data.test.ts` (UF, money non-negative, degenerate-lane refinement)
- [X] T038 [US2] Implement `apps/web/lib/master-data/locations-service.ts` (`list?customerId`, CRUD, archive; `(customer_id,code)` duplicate → `Conflict('DUPLICATE_LOCATION_CODE')`; `location.*` audit) — depends on T013, T035
- [X] T039 [US2] Implement `apps/web/lib/master-data/lanes-service.ts` (CRUD, archive; service-layer integrity: customer/origin/destination active + same customer + origin ≠ destination → `Conflict('INVALID_LANE_REFERENCE')`; `lane.*` audit) — depends on T013, T036, T038
- [X] T040 [US2] Vitest for lanes-service integrity in `apps/web/lib/master-data/lanes-service.test.ts` (different-customer location rejected, archived reference rejected, audit emitted)
- [X] T041 [P] [US2] Implement location routes `apps/web/app/api/master-data/locations/route.ts` + `[id]/route.ts` (`manage_commercial_data`; archive → `delete_archive`) — depends on T038
- [X] T042 [P] [US2] Implement lane routes `apps/web/app/api/master-data/lanes/route.ts` + `[id]/route.ts` — depends on T039
- [X] T043 [US2] Build location pages `apps/web/app/(shell)/admin/locations/page.tsx` + `[id]/page.tsx` (customer filter/selector) — depends on T021, T022, T041
- [X] T044 [US2] Build lane pages `apps/web/app/(shell)/admin/lanes/page.tsx` + `[id]/page.tsx` (cascading customer → origin/destination pickers filtered to active same-customer locations; BRL money inputs via `formatBRL`; vehicle-type select) — depends on T042, T043
- [X] T045 [US2] Register Locations + Lanes nav items in `apps/web/lib/nav.ts` (`manage_commercial_data`)
- [X] T046 [US2] Add location + lane pt-BR strings to `apps/web/messages/pt-BR.json`
- [X] T047 [US2] Playwright e2e `apps/web/e2e/master-data-lanes.spec.ts` (location+lane create, different-customer/degenerate rejected, archive-location behavior)

**Checkpoint**: Customers + Locations + Lanes all independently functional.

---

## Phase 5: User Story 3 — Maintain fleet resources: drivers, vehicles, trailers (Priority: P1)

**Goal**: Fleet managers (Admin, Ops Manager, Fleet Coordinator) create/edit drivers, vehicles, and trailers; set the five operational statuses; see documentation-expiry flags; archive. (Owned ownership; subcontracted carrier linking is completed in US4.)

**Independent Test**: Create an owned driver, vehicle, trailer; cycle each through active/inactive/unavailable/maintenance/blocked (reflected in lists, audited `*.status_change`); a past expiry shows *vencido*, within 30 days *a vencer*; archive hides from active list but retains the record.

- [X] T048 [P] [US3] Add `createDriverSchema`/`updateDriverSchema` (name, phone?, email?, license*, licenseExpiry?, ownershipType, carrierId?, employer?, status?, notes?; `ownershipCarrierRefine`) to `master-data.ts` — depends on T019
- [X] T049 [P] [US3] Add `createVehicleSchema`/`updateVehicleSchema` (plate, vehicleType, capacityKg?, ownershipType, carrierId?, owner?, tracker*, documentExpiry?, status?, notes?; refine) — depends on T019
- [X] T050 [P] [US3] Add `createTrailerSchema`/`updateTrailerSchema` (plate, trailerType, capacityKg?, ownershipType, carrierId?, owner?, documentExpiry?, status?, notes?; refine) — depends on T019
- [X] T051 [P] [US3] Vitest for the three resource schemas in `master-data.test.ts` (plate format, ownership invariant: subcontracted⇒carrierId, owned⇒no carrierId, status enum)
- [X] T052 [P] [US3] Implement `apps/web/lib/master-data/drivers-service.ts` (CRUD, archive, status change → `driver.status_change`; ownership invariant; `documentExpiryState` in output) — depends on T013, T016, T048
- [X] T053 [P] [US3] Implement `apps/web/lib/master-data/vehicles-service.ts` (CRUD, archive, status change, `DUPLICATE_PLATE`, `documentExpiryState`) — depends on T013, T016, T049
- [X] T054 [P] [US3] Implement `apps/web/lib/master-data/trailers-service.ts` (CRUD, archive, status change, `DUPLICATE_PLATE`, `documentExpiryState`) — depends on T013, T016, T050
- [X] T055 [US3] Vitest for resource services in `apps/web/lib/master-data/resources-service.test.ts` (status_change audit, duplicate plate, ownership invariant, archive)
- [X] T056 [P] [US3] Implement driver routes `apps/web/app/api/master-data/drivers/route.ts` + `[id]/route.ts` (`manage_fleet_data`; PATCH handles status; archive → `delete_archive`) — depends on T052
- [X] T057 [P] [US3] Implement vehicle routes `apps/web/app/api/master-data/vehicles/route.ts` + `[id]/route.ts` — depends on T053
- [X] T058 [P] [US3] Implement trailer routes `apps/web/app/api/master-data/trailers/route.ts` + `[id]/route.ts` — depends on T054
- [X] T059 [US3] Build driver pages `apps/web/app/(shell)/resources/drivers/page.tsx` + `[id]/page.tsx` (status select, license fields, expiry badge from `documentExpiryState`) — depends on T021, T022, T056
- [X] T060 [P] [US3] Build vehicle pages `apps/web/app/(shell)/resources/vehicles/page.tsx` + `[id]/page.tsx` (vehicle type, capacity, tracker, document expiry badge) — depends on T021, T022, T057
- [X] T061 [P] [US3] Build trailer pages `apps/web/app/(shell)/resources/trailers/page.tsx` + `[id]/page.tsx` — depends on T021, T022, T058
- [X] T062 [US3] Register Drivers + Vehicles + Trailers nav items in `apps/web/lib/nav.ts` (`manage_fleet_data`)
- [X] T063 [US3] Add resource pt-BR strings to `apps/web/messages/pt-BR.json` (`Resources.*`, status/expiry labels)
- [X] T064 [US3] Playwright e2e `apps/web/e2e/master-data-resources.spec.ts` (owned driver/vehicle/trailer CRUD, status cycle, expiry flag)

**Checkpoint**: Owned-fleet resources fully functional alongside customers/locations/lanes.

---

## Phase 6: User Story 4 — Maintain carriers and classify owned vs subcontracted (Priority: P2)

**Goal**: Maintain carrier records and complete the owned/subcontracted classification — subcontracted resources link to a carrier, owned carry none; archiving a carrier excludes it from new linking.

**Independent Test**: Create a carrier; mark a vehicle/driver subcontracted linked to it and another owned; saving a subcontracted resource with no carrier is rejected; archive the carrier → excluded from new linking, existing links retained.

- [X] T065 [P] [US4] Add `createCarrierSchema`/`updateCarrierSchema` (name, legalName?, taxId?, contact?, contractStatus?, documentationStatus?) to `master-data.ts` — depends on T019
- [X] T066 [P] [US4] Vitest for carrier schema in `master-data.test.ts` (CNPJ, contract/documentation status sets)
- [X] T067 [US4] Implement `apps/web/lib/master-data/carriers-service.ts` (CRUD, archive; `taxId` duplicate → `Conflict('DUPLICATE_TAX_ID')`; `carrier.*` audit) — depends on T013, T016, T065
- [X] T068 [US4] Vitest for carriers-service in `apps/web/lib/master-data/carriers-service.test.ts` (duplicate tax_id, archive + audit)
- [X] T069 [US4] Implement carrier routes `apps/web/app/api/master-data/carriers/route.ts` + `[id]/route.ts` (`manage_fleet_data`; archive → `delete_archive`) — depends on T067
- [X] T070 [US4] Build carrier pages `apps/web/app/(shell)/resources/carriers/page.tsx` + `[id]/page.tsx` (contract/documentation status) — depends on T021, T022, T069
- [X] T071 [US4] Register Carriers nav item in `apps/web/lib/nav.ts` (`manage_fleet_data`)
- [X] T072 [US4] Enhance the driver/vehicle/trailer forms (T059–T061) with the subcontracted option + active-carrier picker (loaded via the carriers list hook), enforcing the ownership/carrier invariant in the UI — depends on T059, T060, T061, T069
- [X] T073 [US4] Add carrier + ownership pt-BR strings to `apps/web/messages/pt-BR.json`
- [X] T074 [US4] Playwright e2e `apps/web/e2e/master-data-carriers.spec.ts` (carrier CRUD; owned vs subcontracted; subcontracted-without-carrier rejected; archived carrier excluded from new linking, existing links intact)

**Checkpoint**: All seven entities functional; ownership split complete.

---

## Phase 7: User Story 5 — Governed master data: permissions, non-destructive removal, audit (Priority: P2)

**Goal**: Verify the cross-cutting guarantees that the entity endpoints already implement — permission gating (UI + API), archive-not-delete, and immutable audit — hold uniformly across all entities.

**Independent Test**: A Dispatcher sees no master-data nav and gets `403` on any create/edit/archive (UI and direct request); a Fleet Coordinator manages fleet but is `403` on commercial endpoints; archived records are retained and retrievable; each critical change has a matching, immutable audit entry.

> Depends on the entities from US1–US4 (run against whatever is built; complete coverage after US4).

- [X] T075 [US5] Playwright e2e `apps/web/e2e/master-data-authz.spec.ts`: signed-in Dispatcher — master-data nav hidden; direct `POST/PATCH/DELETE` to a commercial and a fleet endpoint return `403` with no state change
- [X] T076 [US5] Extend `master-data-authz.spec.ts`: Fleet Coordinator succeeds on fleet endpoints (drivers/vehicles/trailers/carriers) and gets `403` on commercial endpoints (customers/locations/lanes); Ops Manager succeeds on both; archive (`DELETE`) by a non-Admin returns `403`
- [X] T077 [US5] Playwright e2e `apps/web/e2e/master-data-archive.spec.ts`: archiving one entity per domain hides it from the active list, keeps it retrievable via `?includeArchived=true`, and never hard-deletes (record still present)
- [X] T078 [US5] Audit coverage test `apps/web/e2e/master-data-audit.spec.ts` (+ a Vitest assertion per service): every create/update/archive/status_change writes one `audit_logs` row with entity_type/entity_id/action/actor/timestamp and correct previous/new snapshot; confirm no application path updates or deletes an audit row (append-only)

**Checkpoint**: All five stories independently functional and governance verified end-to-end.

---

## Phase 8: Polish & Cross-Cutting Concerns

- [X] T079 [P] i18n completeness pass: no hard-coded user-facing strings in master-data screens (`apps/web/app/(shell)/admin/*`, `/resources/*`, `components/master-data/*`); all via `t()` (SC-010)
- [X] T080 [P] Optional demo seed `packages/db/seed/master-data-sample.ts` (one customer + 2 locations + 1 lane + 1 owned vehicle + 1 subcontracted vehicle/carrier); add a `db:seed:master-data` script
- [X] T081 Run quickstart.md validation end-to-end (US1–US5 walkthrough) and confirm Success Criteria SC-001…SC-011
- [X] T082 Quality gate: `pnpm lint && pnpm typecheck && pnpm build && pnpm test && pnpm test:e2e` all green
- [X] T083 [P] Update PR notes/migration docs (new tables + enums + the two new permission keys) per the DELIVERY-WORKFLOW PR template; open PR against `dev`

---

## Dependencies & Execution Order

### Phase dependencies

- **Setup (P1)** → no deps.
- **Foundational (P2)** → after Setup; **blocks all stories**. Within P2: enums (T003) → schema files (T004–T010, ordered by FK) → index (T011) → generate (T012) → migrate (T013); shared tasks T014–T023 run alongside the DB chain (only T015⇐T014, T018⇐T017, T022⇐T020).
- **US1 (P3)** → after Foundational. **MVP.**
- **US2 (P4)**, **US3 (P5)** → after Foundational; independent of US1 and of each other (can run in parallel by different developers).
- **US4 (P6)** → after Foundational; the carrier *table* exists from P2, but T072 enhances US3's resource forms, so US4's resource-form enhancement depends on US3 pages.
- **US5 (P7)** → after the entities it asserts exist (US1–US4); fullest after US4.
- **Polish (P8)** → after all desired stories.

### Within each story

Schema (Zod) → service → routes → pages → nav/i18n → e2e. Vitest for schema/service precede or accompany the implementation they cover (constitution quality gate).

### Parallel opportunities

- Setup: T002 ‖ (T001 first).
- Foundational: T004 ‖ T005; then T006/T007/T008/T009 ‖; the shared block T014, T016, T017, T020, T021, T023 ‖ the DB chain (T015⇐T014, T018⇐T017, T022⇐T020).
- US1: T024 ‖ T025; T029 ‖ after T026.
- US2: T035 ‖ T036 ‖ T037; T041 ‖ T042.
- US3: T048 ‖ T049 ‖ T050 ‖ T051; T052 ‖ T053 ‖ T054; T056 ‖ T057 ‖ T058; T060 ‖ T061.
- US4: T065 ‖ T066.
- Cross-story: once Foundational is done, **US1, US2, US3 can proceed in parallel**; US4 then US5 follow.

---

## Parallel Example: Foundational schema files

```bash
# After T003 (enums):
Task: "T004 customers.ts" ; Task: "T005 carriers.ts"          # independent
# then:
Task: "T006 locations.ts (needs customers)"
Task: "T007 drivers.ts" ; Task: "T008 vehicles.ts" ; Task: "T009 trailers.ts"   # need carriers+enums
# then T010 lanes.ts (needs customers+locations) → T011 index → T012 generate → T013 migrate
```

## Parallel Example: User Story 3 schemas + services

```bash
Task: "T048 driver schema" ; Task: "T049 vehicle schema" ; Task: "T050 trailer schema"
Task: "T052 drivers-service" ; Task: "T053 vehicles-service" ; Task: "T054 trailers-service"
```

---

## Implementation Strategy

### MVP first (User Story 1 only)

1. Phase 1 Setup → 2. Phase 2 Foundational (CRITICAL — migrates all tables) → 3. Phase 3 US1 (customers).
4. **STOP & VALIDATE**: customers CRUD + archive + audit independently. Demo.

> Note: the feature's *primary outcome* ("maintain master data needed to execute trips") is meaningfully
> demonstrable after **US1–US3** (a customer, a lane, and resources). US1 alone is the smallest shippable slice.

### Incremental delivery

Foundational → **US1** (MVP) → **US2** (lanes) → **US3** (resources) → **US4** (carriers/ownership) →
**US5** (governance verification) → Polish. Each story is independently testable and adds value without
breaking earlier ones.

### Parallel team strategy

After Foundational: Dev A → US1, Dev B → US2, Dev C → US3 (all independent). US4 joins once US3 forms exist
(T072); US5 runs last as the cross-cutting governance suite.

---

## Notes

- **[P]** = different files, no incomplete dependency. Same-file edits (e.g. `nav.ts`, `pt-BR.json`,
  `master-data.ts`, `permissions.ts`) are intentionally **not** marked [P] across stories — they serialize.
- All mutation services call `writeAudit(tx, …)` inside the same Drizzle transaction (research R10); a denied
  request changes no state (handled by `handleRouteError`).
- Archive = soft-delete (`DELETE` sets `archived_at`); no hard-delete path exists for any entity (FR-026).
- Reuse 001 primitives — do not re-implement auth, audit, i18n, or formatting.
- Commit after each task or logical group; open the PR against **`dev`** (never `main`).
- Out of scope (do NOT build): SLA/docs/import-template columns or UI, carrier approved-customers/lanes,
  resource calendars, restore/unarchive UI, assignment policy (see research R12 / spec Out of Scope).
- **Documented defaults (Constitution II)**: the `vehicle_type`/`trailer_type` enum members and the carrier
  `contract_status`/`documentation_status` value sets (T003, T005, T065) are labeled scaffolding — confirm the
  concrete sets with Ops; do not treat them as final sign-off (they are cheap one-line changes).
