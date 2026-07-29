# Quickstart: Dispatch Assignment and Conflict Warnings (006)

**Feature**: 006-dispatch-assignment | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This slice adds the **dispatch/assignment write surface**: assign driver / vehicle / trailer / carrier to a trip with **server-authoritative conflict & eligibility warnings** (§19.2), **override** of WARN findings with a reason, **reassignment** that supersedes + retains history, **confirmation** that re-checks for drift, the new **Dispatch Board**, and the assignment **panel / filters / "Unassigned" view / row indicator / dashboard count** that fill slice 005's shell. It reuses 002 (fleet) + 003 (trip model/status machine/transition service/audit) + 005 (board/detail/dashboard read models + UI framework), adds **one new table** (`trip_assignments`) and **no new enum/permission key/package/worker**, and enforces the pre-declared `assign_resources` for the first time.

## Prerequisites (same stack as 001–005)

```powershell
pnpm install
docker compose -f infra/docker-compose.yml up -d           # Supabase (Postgres/Auth/Storage), Caddy
curl http://localhost:54321/auth/v1/health                 # GoTrue healthy
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm db:migrate                                            # 001–005 migrations
pnpm db:seed                                               # admin account
pnpm db:seed:master-data                                  # customers / locations / lanes
pnpm db:seed:fleet                                         # drivers / vehicles / trailers / carriers (assignable resources)
pnpm db:seed:trip-domain                                  # sample trips incl. some in `validated` (assignable)
```

## Apply this feature's migration

006 adds one table. After editing `packages/db/schema/trip-assignments.ts` and exporting it from `packages/db/schema/index.ts`:

```powershell
pnpm --filter "@brazil-tms/db" db:generate                # emit 0005_*.sql (CREATE TABLE trip_assignments + indexes)
pnpm --filter "@brazil-tms/db" db:migrate                 # apply it
```

No `REVOKE`/hand-append step (assignments are mutable — see data-model R4); no new enum (`CREATE TYPE`) and no `ALTER TABLE trips`.

## Run

```powershell
pnpm dev                                                   # Next.js app (BFF + UI). No worker needed for 006.
```

Sign in (use Ops Manager / Dispatcher / Fleet Coordinator — they hold `assign_resources`) and open **/dispatch** (Dispatch Board), a `validated` trip's **/trips/:id** (assignment panel), **/trips** (Control Tower — assignment filters / "Unassigned" view / row indicator), and **/** (Home Dashboard — "unassigned trips" count).

## Verify the feature (US-by-US)

1. **US1 — Assign & confirm**: open a `validated` trip's detail (or the Dispatch Board). In the assignment panel pick a **driver + vehicle** (and a **carrier** for a subcontracted trip; a **trailer** optionally). Save → the trip becomes **`assigned`**, the panel shows assigned-by + assigned-at + notes, and exactly one current assignment exists. Click **Confirm** → status becomes **`confirmed`** with a confirmation timestamp. Open audit history → `Viagem atribuída` / `Atribuição confirmada` entries appear. Try saving with only a driver → `409 INCOMPLETE_ASSIGNMENT`.
2. **US2 — Conflict & eligibility warnings**: construct each problem and confirm the inline finding + severity: (a) a driver already on a time-overlapping current assignment → **schedule_conflict** (WARN); (b) a vehicle with status `maintenance`/`blocked` → **resource_status** (BLOCK); (c) a vehicle whose type ≠ the trip's planned type → **vehicle_type** (WARN); (d) a carrier with `contract_status = expired`/archived → **carrier_eligibility** (BLOCK); (e) a driver whose `license_expiry` is past → **documentation** (BLOCK), or a missing doc → WARN. A **BLOCK** prevents saving (`409 ASSIGNMENT_BLOCKED`); a **WARN** needs an override (next step). Then bypass the UI and `POST /api/trips/:id/assignment` directly with a BLOCK combination → the server still refuses (UI does not own authority).
3. **US3 — Override a warning**: trigger a WARN, save without a reason → `409 OVERRIDE_REQUIRED` (panel prompts for a reason). Enter a reason → the assignment completes; the reason is stored and shown in audit history. As a user **without** `assign_resources` (Finance/Control Tower) → assign refused `403`. Attempt to override a BLOCK → still refused (BLOCK is absolute).
4. **US4 — Reassign / history**: on an `assigned` (or `confirmed`) trip, substitute a different driver/vehicle → the trip still has **exactly one** current assignment (the new one), the prior assignment is retained as **history** (superseded + timestamp), and the trip **status is unchanged**. Eligibility re-runs for the new resources. Un-assign a trip → status returns to `validated`, prior assignment retained.
5. **US5 — Dispatch Board & board integration**: open `/dispatch` → unassigned trips ordered by pickup time with availability + inline warnings; assign/confirm from it. In `/trips`: the **assigned-driver / assigned-vehicle / carrier** filters narrow the list, the **"Unassigned"** view shows only unassigned trips, and the **assignment row indicator** reflects state. On `/` the **"unassigned trips"** widget shows the live count and deep-links to the Unassigned view. Leave a surface open → it refreshes every ~30 s (polling; no Realtime).

## Tests

```powershell
pnpm --filter "@brazil-tms/shared" test     # evaluateAssignmentEligibility (every §19.2 check + severity), DEFAULT_ASSIGNMENT_POLICY, requiredResourcesFor, trip-assignment Zod, assign_resources invariants, transition legality (validated→assigned / assigned→confirmed / assigned→validated)
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web          # assignment services: assign happy-path + single-current-assignment race; reassign supersede+retain (status unchanged); unassign; confirm re-check + BLOCK refusal; gatherEligibilityContext overlap query; board/detail/dashboard read-model assignment fields + unassigned count
pnpm --filter "@brazil-tms/web" test:e2e    # Playwright: assign/confirm flow, warnings+override, reassign history, Dispatch Board, Control Tower assignment filters/view/indicator, dashboard count; authz (assign_resources 200 vs 403; view-only roles read but cannot assign)
```

Run a single web integration file, e.g.: `pnpm exec vitest run --project web apps/web/lib/trips/trip-assignments.test.ts` (with `DATABASE_URL` set). Test focus per STACK §3.13 + constitution: **assignment-conflict checks** (the pure evaluator), status transitions (assign/reassign/unassign/confirm), single-current-assignment, and permission checks (`assign_resources`). HTTP-status assertions (401/403/404/409 + finding payloads) live in Playwright `e2e/`, not `route.test.ts`. Reset polluted accounts with `pnpm db:seed:e2e` before e2e.

## Performance sanity (SC-003 / SC-006)

Not a perf harness — a manual spot-check at the medium design scale (≤~10k active trips, inherited from 005). With the partial indexes on `trip_assignments` current-resource columns (`*_active_idx`) and the partial-unique current-assignment lookup:

- **Assignment attempt + full conflict check** (`POST /api/trips/:id/assignment` and the `…/assignment/check` dry-run) should return in **< 2 s** (SC-003). The eligibility context is a bounded set of indexed lookups (the candidate resources + the overlapping current assignments joined to active trips).
- **Dispatch Board load** (`/dispatch` → `GET /api/trips?assigned=false&scope=active&sort=pickupStart`) should render in **< 3 s** (SC-006); the board's current-assignment LEFT JOIN rides the same `is_current` partial indexes.

Observe in the browser devtools Network tab (or server timing logs) while exercising US1/US5; if either exceeds the bound at medium scale, check that the `trip_assignments_*_active_idx` partial indexes are present (`\d trip_assignments`).

## Quality gate before PR (targets dev)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Use the PR template (what/why/how-to-test/migration notes/risks). Note in the PR that 006 **first-enforces `assign_resources`** and adds the `trip_assignments` table (one new table; no new enum/key/package/worker), and that the carrier approved-for-customer/lane rule, per-customer severity overrides, and the broader ownership policy are **out of MVP scope / configurable defaults** (not invented — Constitution II). AI does not merge to `main`.
