# Phase 1 Data Model: Trip Domain, Status Machine, and Audit Semantics

**Feature**: 003-trip-domain-lifecycle | **Spec**: [spec.md](./spec.md) · **Research**: [research.md](./research.md)

Conventions (inherited from features 001/002, STACK §3.7): all tables live in `public`, `snake_case`, UUID PKs
(`gen_random_uuid()`; `defaultRandom()` in Drizzle), `created_at`/`updated_at` as `timestamptz NOT NULL
DEFAULT now()` (`updated_at` set manually by services), money as integer centavos (BRL), timestamps stored
UTC (displayed `America/Sao_Paulo`). DDL blocks below are design sketches; the authoritative SQL is the
`drizzle-kit generate` output committed under `packages/db/migrations/`, **plus** a hand-added `REVOKE` for
`trip_events` (see Append-only enforcement). Trips are **never** archived or hard-deleted; they reach terminal
state via `cancelled`/`billed` (Constitution III).

## Enums (extend `packages/db/schema/enums.ts`)

```sql
-- The single trip status machine (18 values, in lifecycle order). R2, spec FR-008.
CREATE TYPE trip_status AS ENUM (
  'received','validation_error','validated','assigned','confirmed',
  'at_origin','loading','loaded','in_transit','at_destination','unloading','unloaded',
  'completed','billing_pending','billing_ready','billed','cancelled','disputed'
);

-- Trip event vocabulary (foundation set; 007 extends via migration). R6, FR-006/FR-007.
CREATE TYPE trip_event_type AS ENUM (
  'status_change','origin_arrived','loaded','departed','destination_arrived','unloaded','completed'
);

-- How an event was recorded (007 adds 'gps','driver_input'). R6.
CREATE TYPE trip_event_source AS ENUM ('system','operator_manual','import');

-- Fixed cancellation responsible-party set — verbatim PRD §19.5. R8, FR-020.
CREATE TYPE cancellation_responsible_party AS ENUM (
  'customer_caused','brazil_transports_caused','carrier_caused','unknown'
);
```

`cancellation_reason` codes and `billing_impact` values are **not** enums — they are config rows in
`cancellation_options` (R8, Constitution V; business-blocked value sets).

> **Documented defaults (Constitution II — labeled scaffolding).** The `trip_event_type` / `trip_event_source`
> member lists are foundation defaults that slice 007 will extend. The seeded `cancellation_options` rows
> (R8) are labeled scaffolding and MUST NOT be treated as final sign-off until business confirms them.

## 1. Trip  (`public.trips`) — TRIP-006, TRIP-007, FR-001..FR-012, FR-015..FR-022

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| customer_id | uuid FK → customers | NOT NULL (002) |
| external_trip_id | text | nullable; customer's own id for matching/updates; UNIQUE per customer when present |
| import_batch_id | uuid | nullable; **no FK yet** (import batches owned by 004) |
| origin_location_id | uuid FK → locations | NOT NULL (002) |
| destination_location_id | uuid FK → locations | NOT NULL; CHECK `<> origin` |
| lane_id | uuid FK → lanes | nullable (preferred when known) |
| current_status | trip_status | NOT NULL DEFAULT `'received'` (R2) |
| sla_status | text | nullable **placeholder** — NOT computed here (007 owns it) |
| **original_plan** | jsonb | NOT NULL; **immutable** import snapshot (R4); never updated after create |
| planned_pickup_window_start | timestamptz | nullable; live accepted plan (R4) |
| planned_pickup_window_end | timestamptz | nullable |
| planned_delivery_window_start | timestamptz | nullable |
| planned_delivery_window_end | timestamptz | nullable |
| planned_vehicle_type | vehicle_type | nullable (002 enum; lane default is fallback) |
| planned_volume_units | integer | nullable |
| planned_weight_kg | integer | nullable |
| planned_pallet_count | integer | nullable |
| planned_route_notes | text | nullable |
| planned_service_requirements | jsonb | nullable (open-ended customer requirements) |
| cancellation_reason_code | text | nullable; set only when `cancelled` (validated vs config, R8) |
| cancellation_responsible_party | cancellation_responsible_party | nullable; set only when `cancelled` |
| cancellation_billing_impact | text | nullable; set only when `cancelled` (validated vs config) |
| cancelled_at | timestamptz | nullable; the cancellation timestamp |
| disputed_from_status | trip_status | nullable; the status `disputed` was entered from (FR-011) |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() (`updated_at` set by services) |

```sql
CREATE TABLE public.trips (
  id                             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id                    uuid NOT NULL REFERENCES public.customers(id),
  external_trip_id               text,
  import_batch_id                uuid,
  origin_location_id             uuid NOT NULL REFERENCES public.locations(id),
  destination_location_id        uuid NOT NULL REFERENCES public.locations(id),
  lane_id                        uuid REFERENCES public.lanes(id),
  current_status                 trip_status NOT NULL DEFAULT 'received',
  sla_status                     text,
  original_plan                  jsonb NOT NULL,
  planned_pickup_window_start    timestamptz,
  planned_pickup_window_end      timestamptz,
  planned_delivery_window_start  timestamptz,
  planned_delivery_window_end    timestamptz,
  planned_vehicle_type           vehicle_type,
  planned_volume_units           integer,
  planned_weight_kg              integer,
  planned_pallet_count           integer,
  planned_route_notes            text,
  planned_service_requirements   jsonb,
  cancellation_reason_code       text,
  cancellation_responsible_party cancellation_responsible_party,
  cancellation_billing_impact    text,
  cancelled_at                   timestamptz,
  disputed_from_status           trip_status,
  created_at                     timestamptz NOT NULL DEFAULT now(),
  updated_at                     timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT trips_origin_dest_ck CHECK (origin_location_id <> destination_location_id)
);
CREATE UNIQUE INDEX trips_customer_external_id_uq
  ON public.trips (customer_id, external_trip_id) WHERE external_trip_id IS NOT NULL;
CREATE INDEX trips_customer_idx ON public.trips (customer_id);
CREATE INDEX trips_status_idx   ON public.trips (current_status);
CREATE INDEX trips_created_idx  ON public.trips (created_at DESC);
```

**Deferred (NOT added here — R12)**: assignment columns/`trip_assignments` (006); `exceptions` (007);
SLA computation of `sla_status` (007); document/rate/billing-export columns (008). Those features anchor on
this row.

## 2. Trip Event  (`public.trip_events`) — FR-006, FR-007, FR-015 (append-only)

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| trip_id | uuid FK → trips | NOT NULL |
| event_type | trip_event_type | NOT NULL |
| status_before | trip_status | nullable (set for `status_change`) |
| status_after | trip_status | nullable (set for `status_change`) |
| event_timestamp | timestamptz | nullable — the **actual** time of the milestone (UTC) |
| source | trip_event_source | NOT NULL |
| actor_user_id | uuid FK → users | nullable (null for `system`/`import`) |
| location_id | uuid FK → locations | nullable |
| notes | text | nullable |
| exception_id | uuid | nullable; forward hook, **no FK** until 007 |
| created_at | timestamptz | NOT NULL DEFAULT now() (DB-recorded time) |

```sql
CREATE TABLE public.trip_events (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  trip_id         uuid NOT NULL REFERENCES public.trips(id),
  event_type      trip_event_type NOT NULL,
  status_before   trip_status,
  status_after    trip_status,
  event_timestamp timestamptz,
  source          trip_event_source NOT NULL,
  actor_user_id   uuid REFERENCES public.users(id),
  location_id     uuid REFERENCES public.locations(id),
  notes           text,
  exception_id    uuid,
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX trip_events_trip_idx    ON public.trip_events (trip_id, created_at DESC);
CREATE INDEX trip_events_type_idx    ON public.trip_events (event_type);
```

## 3. Cancellation Options  (`public.cancellation_options`) — FR-021 (config-driven, business-blocked)

One table holds both config value-sets via a `kind` discriminator (R8).

| Field | Type | Rules |
|---|---|---|
| id | uuid PK | `gen_random_uuid()` |
| kind | text | NOT NULL; CHECK `in ('reason','billing_impact')` |
| code | text | NOT NULL; the stored value (e.g., `no_charge`); UNIQUE per kind |
| label_pt | text | NOT NULL; pt-BR display label |
| active | boolean | NOT NULL DEFAULT true |
| sort_order | integer | NOT NULL DEFAULT 0 |
| created_at / updated_at | timestamptz | NOT NULL DEFAULT now() |

```sql
CREATE TABLE public.cancellation_options (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  kind        text NOT NULL,
  code        text NOT NULL,
  label_pt    text NOT NULL,
  active      boolean NOT NULL DEFAULT true,
  sort_order  integer NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT cancellation_options_kind_ck CHECK (kind IN ('reason','billing_impact')),
  CONSTRAINT cancellation_options_kind_code_uq UNIQUE (kind, code)
);
```

**Seeding (labeled scaffolding, R8)**: `billing_impact` → `no_charge`, `cancellation_fee`, `manual_review`
(§19.5 examples). `reason` → **none** (business-blocked): production cancellations fail with
`CANCELLATION_NOT_CONFIGURED` until business supplies codes; tests/e2e seed their own.

## Append-only enforcement

`audit_logs` is already hardened by feature 001 (`REVOKE UPDATE, DELETE ON audit_logs FROM PUBLIC`). Add the
same for `trip_events` (FR-017) — `drizzle-kit` won't emit it, so append it to the generated migration:

```sql
REVOKE UPDATE, DELETE ON public.trip_events FROM PUBLIC;
```

The app exposes only `insert` and `select` for `trip_events` and `audit_logs`. `trips` rows mutate (status,
plan, cancel fields) but `original_plan` is never overwritten by any service.

## Relationships

- `trips.customer_id → customers.id`; `origin_location_id`/`destination_location_id → locations.id`;
  `lane_id → lanes.id` (nullable). FKs use default `ON DELETE NO ACTION` — master data is archived (soft),
  not deleted, so trips never dangle.
- `trip_events.trip_id → trips.id`; `actor_user_id → users.id`; `location_id → locations.id`.
- `audit_logs` (reused): `entity_type = 'trip'`, `entity_id = trips.id`, `actor_user_id → users.id`.
- Forward hooks (no FK yet): `trips.import_batch_id` (004), `trip_events.exception_id` (007).

## Trip status lifecycle (the single machine — FR-008..FR-012)

`current_status` moves only along declared legal transitions. The **authoritative table** lives in
`packages/shared/src/domain/trip-status.ts` and is the single source slices 004–009 import (FR-023). It
encodes (clarification 2026-05-29: `Cancelled` is legal through `At Destination`):

```text
received          → validated | validation_error | cancelled
validation_error  → received
validated         → assigned | cancelled
assigned          → confirmed | validated (unassign) | cancelled
confirmed         → at_origin | cancelled
at_origin         → loading | in_transit | cancelled
loading           → loaded | cancelled
loaded            → in_transit | cancelled
in_transit        → at_destination | cancelled            # cancellable (clarification)
at_destination    → unloading | unloaded | cancelled      # cancellable (clarification)
unloading         → unloaded
unloaded          → completed
completed         → billing_pending | disputed
billing_pending   → billing_ready | disputed
billing_ready     → billed | disputed
billed            → disputed
disputed          → <status it was entered from> | cancelled
cancelled         → (terminal — none)
```

- **Optional sub-states** (FR-010): `loading`/`unloading` may be skipped (`at_origin → in_transit`,
  `at_destination → unloaded`).
- **Cancellation availability** (FR-011): legal from any non-terminal status up to and including
  `at_destination`; once `unloading`/`unloaded` begins, the trip goes to `completed` or `disputed`.
- **Disputed round-trip**: entering `disputed` records `disputed_from_status`; resolution returns there.
- **Billing-phase projection** (R3): `billingStatus(s)` = `s` when `s ∈ {billing_pending, billing_ready,
  billed, disputed}`, else `null`. No stored column.
- **Warning** (FR-012): a validation warning is an attention flag on a `received`/`validated` trip, **not** a
  status.

## Audit actions (extend `packages/shared/src/audit/actions.ts`)

```typescript
export type AuditAction =
  // … existing 001/002 actions …
  | "trip.create"        // newValue = original_plan summary + initial status
  | "trip.plan_update"   // accepted customer update to live planned_* fields (per-field prev/new)
  | "trip.status_change" // prev/new current_status (also recorded as a trip_event)
  | "trip.cancel";       // reason_code, responsible_party, billing_impact, cancelled_at
```

Critical-field default set (labeled constant `TRIP_CRITICAL_FIELDS`, R9): planned pickup/delivery windows,
`planned_vehicle_type`, `current_status`, billing-status projection, `cancellation_reason_code`, assignment
references (added by 006). A change to any of these produces an audit row (SC-003).

## Validation rules (Zod — `packages/shared/src/schemas/trip.ts`)

- **createTrip**: `customer_id`, `origin_location_id`, `destination_location_id` required (origin ≠ dest);
  `external_trip_id` optional; planned window fields optional `timestamptz`; `planned_vehicle_type` ∈
  `vehicle_type`; the service captures `original_plan` from the create payload and sets `current_status =
  'received'`.
- **transitionTrip**: `{ toStatus: trip_status, expectedFromStatus: trip_status, eventTimestamp?: datetime,
  source?: trip_event_source, notes?: string }`. Rejected `400` if `toStatus` ∉ enum; `409 ILLEGAL_TRANSITION`
  if `!canTransition(from, to)`; `409 STALE_TRANSITION` if the guarded update matches 0 rows (R7).
- **updateTripPlan**: partial set of live `planned_*` fields; if `current_status` past `confirmed`, requires
  an explicit authorized-review flag (FR-005) else `409 REVIEW_REQUIRED`.
- **cancelTrip**: `{ reason_code, cancellation_timestamp?, responsible_party (enum), billing_impact }` — all
  required; `reason_code`/`billing_impact` validated against active `cancellation_options`; empty config →
  `409 CANCELLATION_NOT_CONFIGURED`; trip not in a cancellable status → `409 NOT_CANCELLABLE` (R8, FR-019..022).
- Denied/failed mutations cause **no state change** (SC-001, SC-004).
