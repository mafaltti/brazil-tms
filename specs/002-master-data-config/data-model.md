# Phase 1 Data Model: Master Data and Operational Configuration

**Feature**: 002-master-data-config | **Spec**: [spec.md](./spec.md) ·
**Research**: [research.md](./research.md)

Conventions (inherited from feature 001 / STACK §3.7): all tables live in `public`, `snake_case`, UUID PKs
(`gen_random_uuid()` for owned entities; `defaultRandom()` in Drizzle), `created_at`/`updated_at` as
`timestamptz NOT NULL DEFAULT now()`, money as integer minor units (centavos, BRL), timestamps stored UTC
(displayed `America/Sao_Paulo`). **Soft-delete** = nullable `archived_at` (NULL ⇒ active). DDL blocks below
are design sketches; the authoritative SQL is the `drizzle-kit generate` output committed under
`packages/db/migrations/`.

New Drizzle schema files: `packages/db/schema/{customers,locations,lanes,drivers,vehicles,trailers,carriers}.ts`
(+ exports from `schema/index.ts`); new enums in `packages/db/schema/enums.ts`.

## Enums (extend `packages/db/schema/enums.ts`)

```sql
CREATE TYPE resource_status AS ENUM ('active','inactive','unavailable','maintenance','blocked'); -- R3, RES-007
CREATE TYPE ownership_type  AS ENUM ('owned','subcontracted');                                   -- R4, §29#6
CREATE TYPE vehicle_type    AS ENUM ('van','vuc','tres_quartos','toco','truck','bitruck',
                                     'carreta','carreta_ls','bitrem','rodotrem');                 -- R6 (default set)
CREATE TYPE trailer_type    AS ENUM ('sider','bau','graneleiro','tanque','frigorifico',
                                     'prancha','cacamba','porta_container');                      -- R6 (default set)
```

`carrier_contract_status` and `carrier_documentation_status` are **not** Postgres enums — they are `text` +
CHECK (documented-default value sets, R6/Constitution II labeling), so Ops can adjust the small set without a
type migration. Roles continue to use the existing `app_role` enum (feature 001); no role changes.

> **Documented defaults (Constitution II — labeled scaffolding).** The concrete member lists of `vehicle_type`
> and `trailer_type`, and the `carrier_contract_status` / `carrier_documentation_status` value sets, are
> **documented defaults**, not PRD-specified. They are confirmable with Ops and MUST NOT be treated as final
> sign-off until confirmed. Each is cheap to change (a one-line enum migration, or editing a `text`+CHECK set),
> so this does not block implementation. See spec Assumptions ("Vehicle & trailer type", "Carrier status value
> sets").

---

## 1. Customer  (`public.customers`) — CUST-001, CUST-002

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| name | text | NOT NULL (1–200) |
| legal_name | text | nullable |
| customer_code | text | NOT NULL, **UNIQUE (global)** |
| tax_id | text | nullable; CNPJ format (Zod) |
| contacts | jsonb | NOT NULL default `[]`; array of `{name, email?, phone?, role?}` (R8) |
| billing_contact | jsonb | nullable `{name, email?, phone?}` (R8) |
| archived_at | timestamptz | nullable (NULL ⇒ active) |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.customers (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name          text NOT NULL,
  legal_name    text,
  customer_code text NOT NULL UNIQUE,
  tax_id        text,
  contacts      jsonb NOT NULL DEFAULT '[]'::jsonb,
  billing_contact jsonb,
  archived_at   timestamptz,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now()
);
```

**Deferred (NOT added here — R12)**: `sla_config` (007), `document_requirements` (008), `import_templates` (004).
Those features add their own columns/tables; the customer row is their anchor.

---

## 2. Location  (`public.locations`) — LANE-001, LANE-002, Clarification Q3

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | |
| customer_id | uuid FK→customers | **NOT NULL** (customer-scoped, R5) |
| code | text | NOT NULL; **UNIQUE (customer_id, code)** |
| name | text | NOT NULL |
| address | text | nullable |
| city | text | nullable |
| state | text | nullable; 2-letter UF |
| country | text | NOT NULL DEFAULT `'BR'` |
| latitude | double precision | nullable |
| longitude | double precision | nullable |
| gate_instructions | text | nullable (contact/gate instructions) |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.locations (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id  uuid NOT NULL REFERENCES public.customers(id),
  code         text NOT NULL,
  name         text NOT NULL,
  address text, city text, state text,
  country      text NOT NULL DEFAULT 'BR',
  latitude     double precision,
  longitude    double precision,
  gate_instructions text,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  UNIQUE (customer_id, code)
);
CREATE INDEX locations_customer_idx ON public.locations (customer_id);
```

---

## 3. Lane  (`public.lanes`) — LANE-003, LANE-004

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | |
| customer_id | uuid FK→customers | NOT NULL |
| origin_location_id | uuid FK→locations | NOT NULL |
| destination_location_id | uuid FK→locations | NOT NULL; CHECK `<> origin` |
| expected_transit_minutes | integer | nullable; ≥ 0 |
| default_vehicle_type | vehicle_type | nullable |
| standard_rate_cents | bigint | nullable; ≥ 0 (centavos, BRL — R7) |
| toll_estimate_cents | bigint | nullable; ≥ 0 (centavos, BRL — R7) |
| standard_distance_km | numeric | nullable; ≥ 0 |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.lanes (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES public.customers(id),
  origin_location_id      uuid NOT NULL REFERENCES public.locations(id),
  destination_location_id uuid NOT NULL REFERENCES public.locations(id),
  expected_transit_minutes integer,
  default_vehicle_type  vehicle_type,
  standard_rate_cents   bigint,
  toll_estimate_cents   bigint,
  standard_distance_km  numeric,
  archived_at  timestamptz,
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CHECK (origin_location_id <> destination_location_id)
);
CREATE INDEX lanes_customer_idx ON public.lanes (customer_id);
CREATE INDEX lanes_origin_idx   ON public.lanes (origin_location_id);
CREATE INDEX lanes_dest_idx     ON public.lanes (destination_location_id);
```

**Service-layer integrity (R5, FR-009; cannot be a single CHECK — spans rows):** at create/edit assert that
`customer`, `origin`, and `destination` are all active (`archived_at IS NULL`) **and** that
`origin.customer_id = destination.customer_id = lanes.customer_id`. Violations → `409 INVALID_LANE_REFERENCE`.

---

## 4. Driver  (`public.drivers`) — RES-001, RES-002

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | |
| name | text | NOT NULL |
| phone | text | nullable |
| email | text | nullable |
| license_number | text | nullable |
| license_category | text | nullable (CNH: A–E) |
| license_expiry | date | nullable (drives expiry warning — R9) |
| ownership_type | ownership_type | **NOT NULL** (R4) |
| carrier_id | uuid FK→carriers | nullable; required iff subcontracted (CHECK) |
| employer | text | nullable (owned-case employer label) |
| status | resource_status | NOT NULL DEFAULT `'active'` (RES-007) |
| notes | text | nullable |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.drivers (
  id        uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name      text NOT NULL,
  phone text, email text,
  license_number text, license_category text,
  license_expiry date,
  ownership_type ownership_type NOT NULL,
  carrier_id uuid REFERENCES public.carriers(id),
  employer  text,
  status    resource_status NOT NULL DEFAULT 'active',
  notes     text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT drivers_ownership_carrier_ck CHECK (
    (ownership_type = 'subcontracted' AND carrier_id IS NOT NULL) OR
    (ownership_type = 'owned'         AND carrier_id IS NULL)
  )
);
CREATE INDEX drivers_carrier_idx ON public.drivers (carrier_id);
CREATE INDEX drivers_status_idx  ON public.drivers (status);
```

---

## 5. Vehicle  (`public.vehicles`) — RES-003, RES-004

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | |
| plate | text | NOT NULL, **UNIQUE (global)**; BR/Mercosul format (Zod) |
| vehicle_type | vehicle_type | NOT NULL (R6) |
| capacity_kg | integer | nullable; ≥ 0 |
| ownership_type | ownership_type | NOT NULL |
| carrier_id | uuid FK→carriers | nullable; required iff subcontracted (CHECK) |
| owner | text | nullable (owned-case owner/lessor) |
| tracker_provider | text | nullable |
| tracker_id | text | nullable |
| document_expiry | date | nullable (R9) |
| status | resource_status | NOT NULL DEFAULT `'active'` |
| notes | text | nullable |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.vehicles (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate text NOT NULL UNIQUE,
  vehicle_type vehicle_type NOT NULL,
  capacity_kg integer,
  ownership_type ownership_type NOT NULL,
  carrier_id uuid REFERENCES public.carriers(id),
  owner text, tracker_provider text, tracker_id text,
  document_expiry date,
  status resource_status NOT NULL DEFAULT 'active',
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT vehicles_ownership_carrier_ck CHECK (
    (ownership_type = 'subcontracted' AND carrier_id IS NOT NULL) OR
    (ownership_type = 'owned'         AND carrier_id IS NULL)
  )
);
CREATE INDEX vehicles_carrier_idx ON public.vehicles (carrier_id);
CREATE INDEX vehicles_status_idx  ON public.vehicles (status);
```

---

## 6. Trailer  (`public.trailers`) — RES-005 (where applicable)

Same shape as Vehicle but `trailer_type` and no tracker fields. `plate` UNIQUE (global). Optional to use:
operations without trailers simply create none.

```sql
CREATE TABLE public.trailers (
  id    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  plate text NOT NULL UNIQUE,
  trailer_type trailer_type NOT NULL,
  capacity_kg integer,
  ownership_type ownership_type NOT NULL,
  carrier_id uuid REFERENCES public.carriers(id),
  owner text,
  document_expiry date,
  status resource_status NOT NULL DEFAULT 'active',
  notes text,
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trailers_ownership_carrier_ck CHECK (
    (ownership_type = 'subcontracted' AND carrier_id IS NOT NULL) OR
    (ownership_type = 'owned'         AND carrier_id IS NULL)
  )
);
CREATE INDEX trailers_carrier_idx ON public.trailers (carrier_id);
CREATE INDEX trailers_status_idx  ON public.trailers (status);
```

---

## 7. Carrier  (`public.carriers`) — RES-006

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | |
| name | text | NOT NULL |
| legal_name | text | nullable |
| tax_id | text | nullable, UNIQUE when present; CNPJ format (Zod) |
| contact | jsonb | nullable `{name?, email?, phone?, address?}` (R8) |
| contract_status | text | NOT NULL DEFAULT `'active'`; CHECK in (`active`,`suspended`,`expired`) — documented default (R6) |
| documentation_status | text | NOT NULL DEFAULT `'pending'`; CHECK in (`pending`,`complete`,`expired`) — documented default |
| archived_at | timestamptz | nullable |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.carriers (
  id   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  name text NOT NULL,
  legal_name text,
  tax_id text UNIQUE,
  contact jsonb,
  contract_status      text NOT NULL DEFAULT 'active',
  documentation_status text NOT NULL DEFAULT 'pending',
  archived_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT carriers_contract_status_ck      CHECK (contract_status IN ('active','suspended','expired')),
  CONSTRAINT carriers_documentation_status_ck CHECK (documentation_status IN ('pending','complete','expired'))
);
```

**Deferred (R12)**: `approved_customers` / `approved_lanes` (PRD §14.1) — enforcement is feature 006; not stored here.

---

## Relationships

```
customers 1──* locations            (locations.customer_id, NOT NULL — customer-scoped)
customers 1──* lanes                 (lanes.customer_id)
locations 1──* lanes (origin)        (lanes.origin_location_id; same customer as lane — service-enforced)
locations 1──* lanes (destination)   (lanes.destination_location_id; same customer; <> origin — CHECK)
carriers  1──* drivers|vehicles|trailers  (…​.carrier_id, set iff ownership_type='subcontracted')
public.users 1──* audit_logs         (actor — reused from 001; unchanged)
```

FK delete behavior: master-data rows are **never hard-deleted** (archive only), so referential cleanup is not
needed; FKs use the default `NO ACTION` (a referenced row cannot be hard-deleted, which is fine because we
never hard-delete). Archiving a referenced customer/location/carrier is allowed and leaves existing references
intact (FR-026 / spec edge case): existing lanes/resources keep their FK; the archived row is excluded only
from *new* selection (service filters pick-lists by `archived_at IS NULL`).

## State & lifecycle

**Archive lifecycle (all 7 entities)** — orthogonal to operational status:

```
(created) ── archived_at = NULL  ──▶ ACTIVE  ──(DELETE = archive; delete_archive)──▶ ARCHIVED (archived_at set)
                                       ▲                                                    │
                                       └──────────────── restore (fast-follow, deferred) ───┘
```

**Operational status (drivers, vehicles, trailers only)** — `resource_status`, free transitions, audited:

```
active ⇄ inactive ⇄ unavailable ⇄ maintenance ⇄ blocked   (any → any; no business-rule legal-transition set in MVP — R3)
```

## Audit actions (extend `packages/shared/src/audit/actions.ts`)

Add to the `AuditAction` union (written via `writeAudit(tx, …)` in the same transaction as the mutation, R10):

```
customer.create | customer.update | customer.archive
location.create | location.update | location.archive
lane.create     | lane.update     | lane.archive
driver.create   | driver.update   | driver.archive   | driver.status_change
vehicle.create  | vehicle.update  | vehicle.archive  | vehicle.status_change
trailer.create  | trailer.update  | trailer.archive  | trailer.status_change
carrier.create  | carrier.update  | carrier.archive
```

`entity_type` = singular entity name (`'customer'`, `'location'`, `'lane'`, `'driver'`, `'vehicle'`,
`'trailer'`, `'carrier'`); `entity_id` = the row id; `previous_value`/`new_value` = snapshots of changed
fields only (e.g. status_change → `{status: old}` / `{status: new}`; archive → `{archived_at: null}` /
`{archived_at: <ts>}`).

## Validation rules (Zod — `packages/shared/src/schemas/master-data.ts`, pt-BR messages)

- **Required**: customer.name + customer_code; location.customer_id + code + name; lane.customer_id + origin +
  destination; driver.name + ownership_type; vehicle.plate + vehicle_type + ownership_type; trailer.plate +
  trailer_type + ownership_type; carrier.name.
- **Enums**: `status` ∈ resource_status; `ownership_type` ∈ {owned, subcontracted}; `vehicle_type`/`trailer_type`
  ∈ the fixed sets; carrier `contract_status`/`documentation_status` ∈ their sets.
- **Ownership invariant (mirror of the DB CHECK)**: subcontracted ⇒ `carrier_id` required; owned ⇒ `carrier_id`
  must be absent (`409`/`400 OWNERSHIP_CARRIER_MISMATCH`).
- **Formats**: `tax_id` = CNPJ (14 digits, basic check); `plate` = BR/Mercosul pattern; `state` = 2-letter UF;
  money fields = non-negative integers (centavos); `latitude`/`longitude` within valid ranges.
- **Uniqueness** (DB-enforced, surfaced as `409`): customer_code (global), location (customer_id, code),
  vehicle.plate, trailer.plate, carrier.tax_id (when present).
- **Lane references** (service): customer/origin/destination active and same-customer; origin ≠ destination.
- **Derived (not stored)**: `documentExpiryState(expiry, now, 30)` → `ok|expiring|expired` (R9), surfaced in
  list/detail responses for drivers, vehicles, trailers.
