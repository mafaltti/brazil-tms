# Contract: BFF Endpoints (feature 002)

**Feature**: 002-master-data-config | **Spec**: [../spec.md](../spec.md) ·
**Data model**: [../data-model.md](../data-model.md)

The interface this feature exposes is the **BFF** — Next.js App Router Route Handlers under
`apps/web/app/api/master-data/*`. The browser never talks to Postgres/PostgREST directly (FR-031); all access
goes through these handlers. Every handler validates input with shared Zod schemas
(`packages/shared/src/schemas/master-data.ts`), enforces auth via `requireAuth()` + `requirePermission()`
(feature 001), and audits critical mutations via `writeAudit(tx, …)` in the same transaction.

**Conventions** (inherited from feature 001 `contracts/bff-endpoints.md`)
- **AuthZ**: `401` = no valid/active session; `403` = authenticated but lacks the permission; `409` =
  business-rule conflict (duplicate natural key, invalid lane reference, ownership/carrier mismatch, not-found);
  `400` = Zod validation error. Denied/failed requests cause **no state change** (SC-005).
- **Permissions** (R2): commercial entities (customers, locations, lanes) → `manage_commercial_data`
  (Admin, Ops Manager). Fleet entities (drivers, vehicles, trailers, carriers) → `manage_fleet_data`
  (Admin, Ops Manager, Fleet Coordinator). **Archive** of any entity (`DELETE`) → `delete_archive` (Admin only,
  FR-027). Reads require the entity's *manage* permission (no separate view key).
- **Bodies**: JSON. Timestamps returned as UTC ISO 8601 strings (formatted to `America/Sao_Paulo` in UI). Money
  returned as integer centavos (BRL), formatted by `formatBRL` in UI.
- **List shape**: `200 { items: T[] }`, ordered `created_at DESC`, active-only unless `?includeArchived=true`.
- **Archive = soft-delete**: `DELETE` sets `archived_at`; it never hard-deletes (FR-026). No physical-delete
  endpoint exists for any master-data entity.
- **Error envelope**: `{ error: { code, message, issues? } }` (via `handleRouteError`).

All seven entities follow the **same five-route shape**. The customer routes are shown in full; the other six
list only their entity-specific specifics.

---

## Customers — permission `manage_commercial_data` (archive: `delete_archive`)

### `GET /api/master-data/customers`
- **Permission**: `manage_commercial_data`.
- **Query**: `?q=` (name/code/tax_id search), `?includeArchived=true`.
- **Responses**: `200 { items: Customer[] }`; `401`; `403`.
- Traceability: FR-001, US1.

### `POST /api/master-data/customers`
- **Permission**: `manage_commercial_data`.
- **Body** (`createCustomerSchema`):
  ```jsonc
  {
    "name": "string (1–200)",
    "legalName": "string?",
    "customerCode": "string (unique, global)",
    "taxId": "string? (CNPJ)",
    "contacts": [{ "name": "string", "email": "string?", "phone": "string?", "role": "string?" }],
    "billingContact": { "name": "string", "email": "string?", "phone": "string?" }  // nullable
  }
  ```
- **Behavior**: insert `public.customers`; write audit `customer.create` in the same transaction.
- **Responses**: `201 { item }`; `400` validation; `409 DUPLICATE_CUSTOMER_CODE`.
- Traceability: CUST-001, CUST-002, FR-001, FR-002, US1.

### `GET /api/master-data/customers/:id`
- **Permission**: `manage_commercial_data`.
- **Responses**: `200 { item }`; `403`; `404`.
- Traceability: US1.

### `PATCH /api/master-data/customers/:id`
- **Permission**: `manage_commercial_data`.
- **Body** (`updateCustomerSchema`, partial): any subset of the create fields.
- **Behavior**: update row; write audit `customer.update` (snapshot of changed fields) in the same transaction.
- **Responses**: `200 { item }`; `400`; `403`; `404`; `409 DUPLICATE_CUSTOMER_CODE`.
- Traceability: CUST-001, FR-001, US1, US5 (audit).

### `DELETE /api/master-data/customers/:id`  *(archive)*
- **Permission**: `delete_archive` (Admin only — FR-027).
- **Behavior**: set `archived_at = now()` (idempotent if already archived); write audit `customer.archive`.
  Never hard-deletes (FR-026).
- **Responses**: `200 { item }`; `403`; `404`.
- Traceability: FR-026, FR-027, SC-002, US5.

---

## Locations — permission `manage_commercial_data` (archive: `delete_archive`)

Same five-route shape under `/api/master-data/locations`. Specifics:
- **GET list query**: `?customerId=` (filter to one customer), `?q=` (code/name), `?includeArchived=true`.
- **POST/PATCH body** (`createLocationSchema`): `{ customerId, code, name, address?, city?, state? (UF),
  country? (default 'BR'), latitude?, longitude?, gateInstructions? }`.
- **Integrity**: `customerId` must reference an active customer; `(customerId, code)` unique → `409
  DUPLICATE_LOCATION_CODE` (per-customer). Audit: `location.create|update|archive`.
- **Responses**: as customers, plus `409 DUPLICATE_LOCATION_CODE`.
- Traceability: LANE-001, LANE-002, FR-005, FR-006, US2.

---

## Lanes — permission `manage_commercial_data` (archive: `delete_archive`)

Under `/api/master-data/lanes`. Specifics:
- **GET list query**: `?customerId=`, `?originId=`, `?destinationId=`, `?includeArchived=true`.
- **POST/PATCH body** (`createLaneSchema`): `{ customerId, originLocationId, destinationLocationId,
  expectedTransitMinutes?, defaultVehicleType?, standardRateCents?, tollEstimateCents?, standardDistanceKm? }`.
- **Integrity (FR-009, R5)**: `customer`, `origin`, `destination` must all be **active** and **same customer**;
  `origin ≠ destination` → `409 INVALID_LANE_REFERENCE`. Money fields are non-negative centavos (BRL).
  Audit: `lane.create|update|archive`.
- **Responses**: as customers, plus `409 INVALID_LANE_REFERENCE`.
- Traceability: LANE-003, LANE-004, FR-007, FR-008, FR-009, SC-008, US2.

---

## Drivers — permission `manage_fleet_data` (archive: `delete_archive`)

Under `/api/master-data/drivers`. Specifics:
- **GET list query**: `?q=` (name/phone), `?status=` (resource_status), `?carrierId=`, `?ownership=`,
  `?expiry=expiring|expired`, `?includeArchived=true`. Each item includes a derived
  `documentExpiryState: 'ok'|'expiring'|'expired'` (R9, FR-017).
- **POST/PATCH body** (`createDriverSchema`): `{ name, phone?, email?, licenseNumber?, licenseCategory?,
  licenseExpiry? (date), ownershipType: 'owned'|'subcontracted', carrierId?, employer?,
  status? (default 'active'), notes? }`.
- **Ownership invariant (FR-022/FR-023)**: `subcontracted` ⇒ `carrierId` required; `owned` ⇒ `carrierId`
  forbidden → `409 OWNERSHIP_CARRIER_MISMATCH`. A `status` change in PATCH additionally writes
  `driver.status_change`. Audit: `driver.create|update|archive|status_change`.
- **Responses**: as customers, plus `409 OWNERSHIP_CARRIER_MISMATCH`.
- Traceability: RES-001, RES-002, RES-007, FR-011, FR-012, FR-017, FR-018, FR-019, FR-022, FR-023, US3, US4.

---

## Vehicles — permission `manage_fleet_data` (archive: `delete_archive`)

Under `/api/master-data/vehicles`. Specifics:
- **GET list query**: `?q=` (plate), `?status=`, `?vehicleType=`, `?carrierId=`, `?ownership=`, `?expiry=`,
  `?includeArchived=true`. Items include derived `documentExpiryState`.
- **POST/PATCH body** (`createVehicleSchema`): `{ plate (unique), vehicleType, capacityKg?, ownershipType,
  carrierId?, owner?, trackerProvider?, trackerId?, documentExpiry?, status?, notes? }`.
- **Invariants**: ownership/carrier as drivers; `plate` unique → `409 DUPLICATE_PLATE`. Audit:
  `vehicle.create|update|archive|status_change`.
- **Responses**: as customers, plus `409 DUPLICATE_PLATE`, `409 OWNERSHIP_CARRIER_MISMATCH`.
- Traceability: RES-003, RES-004, RES-007, FR-013, FR-014, FR-017, FR-018, US3, US4.

---

## Trailers — permission `manage_fleet_data` (archive: `delete_archive`)

Under `/api/master-data/trailers`. Same shape as vehicles with `trailerType` (no tracker fields). Optional to
use (RES-005 "where applicable"). `plate` unique → `409 DUPLICATE_PLATE`. Audit:
`trailer.create|update|archive|status_change`.
- Traceability: RES-005, RES-007, FR-015, FR-016, FR-017, FR-018, US3, US4.

---

## Carriers — permission `manage_fleet_data` (archive: `delete_archive`)

Under `/api/master-data/carriers`. Specifics:
- **GET list query**: `?q=` (name/tax_id), `?contractStatus=`, `?includeArchived=true`.
- **POST/PATCH body** (`createCarrierSchema`): `{ name, legalName?, taxId?, contact?, contractStatus?
  (active|suspended|expired, default active), documentationStatus? (pending|complete|expired, default pending) }`.
- **Invariants**: `taxId` unique when present → `409 DUPLICATE_TAX_ID`. Audit: `carrier.create|update|archive`.
- **Note**: archiving a carrier excludes it from new resource linking but leaves existing
  `driver/vehicle/trailer.carrier_id` references intact (FR edge case).
- Traceability: RES-006, FR-020, FR-021, US4.

---

## Shared returned shapes (sketch)

```ts
type Customer = { id; name; legalName: string|null; customerCode; taxId: string|null;
  contacts: Contact[]; billingContact: Contact|null; archived: boolean; archivedAt: string|null;
  createdAt: string; updatedAt: string };
type Location = { id; customerId; code; name; address; city; state; country;
  latitude: number|null; longitude: number|null; gateInstructions: string|null;
  archived: boolean; archivedAt: string|null; createdAt; updatedAt };
type Lane = { id; customerId; originLocationId; destinationLocationId;
  expectedTransitMinutes: number|null; defaultVehicleType: string|null;
  standardRateCents: number|null; tollEstimateCents: number|null; standardDistanceKm: number|null;
  archived: boolean; archivedAt: string|null; createdAt; updatedAt };
type Driver = { id; name; phone; email; licenseNumber; licenseCategory; licenseExpiry: string|null;
  ownershipType: 'owned'|'subcontracted'; carrierId: string|null; employer: string|null;
  status: ResourceStatus; documentExpiryState: 'ok'|'expiring'|'expired'; notes;
  archived: boolean; archivedAt: string|null; createdAt; updatedAt };
type Vehicle = { …Driver-like…; plate; vehicleType; capacityKg; owner; trackerProvider; trackerId;
  documentExpiry: string|null };
type Trailer = { …Vehicle-like, trailerType, no tracker… };
type Carrier = { id; name; legalName; taxId: string|null; contact: Contact|null;
  contractStatus: 'active'|'suspended'|'expired'; documentationStatus: 'pending'|'complete'|'expired';
  archived: boolean; archivedAt: string|null; createdAt; updatedAt };

type Contact = { name: string; email?: string; phone?: string; role?: string };
type ResourceStatus = 'active'|'inactive'|'unavailable'|'maintenance'|'blocked';
```
