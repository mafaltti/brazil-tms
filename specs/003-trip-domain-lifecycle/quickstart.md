# Quickstart: Trip Domain, Status Machine, and Audit Semantics (003)

**Feature**: 003-trip-domain-lifecycle | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) ·
**Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This feature builds on the running 001/002 stack (Supabase + app + master data). It adds three tables
(`trips`, `trip_events`, `cancellation_options`), four enums, the shared status machine, the reusable trip
service/domain API, and two read-only inspector endpoints. No new infra, no worker, no UI.

## Prerequisites (same stack as 001/002)

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
# Wait for GoTrue health: curl http://localhost:8000/auth/v1/health  -> 200
pnpm --filter "@brazil-tms/db" db:migrate                    # 001 + 002 migrations
pnpm --filter "@brazil-tms/db" db:seed                       # bootstrap first Admin (idempotent)
pnpm --filter "@brazil-tms/db" db:seed:master-data           # optional: customers/locations/lanes to anchor trips
```

## Apply this feature's migration

After adding the new schema files (`trips.ts`, `trip-events.ts`, `cancellation-options.ts`), extending
`enums.ts`, and exporting them from `schema/index.ts`:

```powershell
pnpm --filter "@brazil-tms/db" db:generate    # drizzle-kit generate -> new SQL in packages/db/migrations/
# IMPORTANT: hand-append the append-only guard to the generated migration (drizzle-kit won't emit it):
#   REVOKE UPDATE, DELETE ON public.trip_events FROM PUBLIC;
pnpm --filter "@brazil-tms/db" db:migrate     # apply trips + trip_events + cancellation_options + enums
pnpm --filter "@brazil-tms/db" db:seed:trip-domain   # seed cancellation_options (billing_impact scaffolding; reasons left empty)
```

> Reason codes are seeded **empty** on purpose (business-blocked): a production cancellation fails with
> `CANCELLATION_NOT_CONFIGURED` until business supplies codes. Tests/e2e seed their own.

## Verify the model (no UI — exercised via the service layer + inspector)

The mutating operations are service functions (see [contracts/trip-domain-api.md](./contracts/trip-domain-api.md));
this slice ships no operational endpoints. Verify end-to-end via the integration tests, or manually in a Node
REPL / a throwaway script using `@brazil-tms/db` + `apps/web/lib/trips/*`:

1. **Create + planned/executed separation (US1)**: `createTrip(...)` from a plan; assert `original_plan` is
   stored; record an executed milestone as a `trip_event`; assert `planned_*` unchanged.
2. **Status machine (US2)**: drive `received → validated → assigned → confirmed → at_origin → in_transit →
   at_destination → unloaded → completed` via `transitionTripStatus`; assert each accepted; attempt
   `received → in_transit` and assert `ILLEGAL_TRANSITION` with status unchanged; attempt a stale transition
   (wrong `expectedFromStatus`) and assert `STALE_TRANSITION` (409).
3. **Cancellation in transit (clarification)**: from `in_transit`, `cancelTrip(...)` with all five inputs;
   assert `cancelled` + audit `trip.cancel`. Omit `responsibleParty` → `400`. Empty reason config →
   `CANCELLATION_NOT_CONFIGURED`.
4. **Audit + immutability (US3)**: change `planned_vehicle_type` via `updateTripPlan`; assert one
   `trip.plan_update` audit row with before/after; attempt to `UPDATE`/`DELETE` an `audit_logs` or
   `trip_events` row directly → permission denied (DB `REVOKE`).
5. **Billing projection (US5)**: advance to `completed → billing_pending → billing_ready → billed`; assert the
   DTO's derived `billingStatus` follows; attempt `billing_pending → billed` → `ILLEGAL_TRANSITION`.
6. **Inspector**: `GET /api/trips` and `GET /api/trips/:id` as Admin return the trip + `billingStatus` +
   events + audit; without a session → `401`; as `customer_viewer` → `403`.

## Tests

```powershell
# Unit (no DB): transition-table legality, billingStatus projection, TRIP_CRITICAL_FIELDS, permission invariants
pnpm --filter "@brazil-tms/shared" test

# Service-layer integration (needs DATABASE_URL to the dev DB): create/transition/plan/cancel + audit atomicity + 409s
pnpm --filter "@brazil-tms/web" test

# API-level e2e (auth on the read-only inspector)
pnpm --filter "@brazil-tms/web" test:e2e
```

Test focus (STACK §3.13, constitution): status transitions (legal + illegal + stale), atomic status+event+
audit write, original-plan immutability, cancellation five-input validation + missing-config failure,
append-only enforcement, permission checks.

## Quality gate before PR (targets `dev`)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Open the PR against `dev` using the PR template (what changed / why / how to test / migration notes / risks).
**Migration note**: includes a manual `REVOKE UPDATE, DELETE ON public.trip_events`. **Blocked**: final
sign-off awaits business confirmation of cancellation reason codes and billing-impact values (scaffolded
config-driven, not invented). AI does not merge to `main`.
