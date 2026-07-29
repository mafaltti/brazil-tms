# Quickstart: Control Tower, Trip List, Trip Detail, and Daily Dashboard (005)

**Feature**: 005-control-tower | **Spec**: [spec.md](./spec.md) · **Plan**: [plan.md](./plan.md) · **Data model**: [data-model.md](./data-model.md) · **Contracts**: [contracts/](./contracts/)

This slice adds the operating surface over the trip domain: the **Trip Control Tower** list (search / filter / sort / paginate, default = active/open trips), the **Trip Detail** page (full §15.5 record with placeholder sections for 006/007/008), the **Home (daily) Dashboard** ("what needs attention today?"), a **CSV export** of the filtered list, and **inline editing of live planned fields before completion**. It is read-first (polling via TanStack Query, no Realtime), reuses 003/004, adds **no table/enum/permission key/worker**, and enforces the pre-declared `view_all_trips` for the first time.

## Prerequisites (same stack as 001/002/003/004)

```powershell
pnpm install
docker compose -f infra/docker-compose.yml up -d           # Supabase (Postgres/Auth/Storage), Caddy
curl http://localhost:54321/auth/v1/health                 # GoTrue healthy
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm db:migrate                                            # includes the 005 trips_pickup_start_idx migration
pnpm db:seed                                               # admin account
pnpm db:seed:master-data                                  # customers / locations / lanes (filter sources)
pnpm db:seed:trip-domain                                  # sample trips across statuses (board has content)
```

## Apply this feature's migration

005 adds exactly one schema object — an index. After editing `packages/db/schema/trips.ts` to add `trips_pickup_start_idx`:

```powershell
pnpm --filter "@brazil-tms/db" db:generate                # emit the migration for the new index
pnpm --filter "@brazil-tms/db" db:migrate                 # apply it
```

No `REVOKE`/hand-append step is needed (no new table; append-only enforcement on `trips`/`trip_events`/`audit_logs` is unchanged from 003).

## Run

```powershell
pnpm dev                                                   # Next.js app (BFF + UI). No worker needed for 005.
```

Sign in as the seeded admin and open **/trips** (Control Tower), a trip's **/trips/:id** (Detail), and **/** (Home Dashboard).

## Verify the feature (US-by-US)

1. **US1 — Control Tower (view / search / filter)**: open `/trips`. The board renders a dense, sortable, paginated table defaulting to **active/open** trips. Type an external trip ID, customer, or lane in the persistent search → matching rows surface. Apply each filter — customer, date (pickup range), status, origin, destination, lane, vehicle type, billing status — alone and combined (AND). Pick the **Today / Next 24h / In transit / Billing pending** default views. Reload from the URL → filters persist. Leave the page open → it refreshes every ~30 s without a manual reload. Confirm there are **no** assigned-driver/vehicle/carrier or SLA-risk filter controls (delivered by 006/007).
2. **US2 — Trip Detail**: click a trip. The detail page shows the **header** (customer, trip ID, lane, status, SLA risk, billing status), the **customer plan** (immutable original plan beside live planned schedule + actual milestone timestamps), the **timeline** (read-only events), **notes**, **audit history** (read-only), and labelled **placeholder** sections for assignment / exceptions / documents / billing. It loads within ~2 s.
3. **US3 — Edit before completion**: as Admin/Ops Manager, edit a live planned field on a `received`/`validated` trip → it saves, appears in audit history, and updates on the board within one ~30 s poll. Repeat on a `completed` (or later) trip → editing is disabled / rejected (`409 EDIT_NOT_ALLOWED`). Edit a trip past `confirmed` without review → `409 REVIEW_REQUIRED`. As Dispatcher → edit refused (`403`).
4. **US4 — Daily dashboard**: open `/`. All eight §15.2 widgets render; **trips today by status** and **billing pending count** show real numbers; the later-slice widgets (at risk / on-time % / unassigned / active exceptions / missing documents) show a labelled placeholder. Click a populated widget → the Control Tower opens filtered to those trips.
5. **US5 — Export**: filter the board, click Export → a **CSV** (UTF-8, opens with correct pt-BR accents in Excel) downloads containing exactly the filtered, permitted rows. Filter to an over-cap set (>10,000) → an error prompts narrowing filters (no silent truncation).
6. **Authz**: sign in as Dispatcher / Control Tower / Finance / Executive Viewer → all can **view** the board, detail, dashboard, and export (`view_all_trips`); none can edit plan fields. Unauthenticated requests to the trip read endpoints → `401`.

## Tests

```powershell
pnpm --filter "@brazil-tms/shared" test     # ACTIVE_TRIP_STATUSES/isActiveStatus, billingStatusToStatuses, trip-board Zod, view_all_trips invariants
$env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'
pnpm exec vitest run --project web          # board read model (filters/AND/sort/paginate/total), detail view, dashboard metrics (+nulls), export+cap, plan-edit guard/review/perm, read authz
pnpm --filter "@brazil-tms/web" test:e2e    # Playwright: Control Tower view/filter/export, Trip Detail sections+edit+authz, Dashboard widgets+deep-link
```

Run a single web integration file, e.g.: `pnpm exec vitest run --project web apps/web/lib/trips/trips-read.test.ts` (with `DATABASE_URL` set). Test focus per STACK §3.13 + constitution: status-aware read projections, permission checks (`view_all_trips` reads, `manage_trips` edit), the before-completion edit guard, and export bounding.

## Quality gate before PR (targets dev)

```powershell
pnpm lint
pnpm typecheck
pnpm build
pnpm test
```

Use the PR template (what/why/how-to-test/migration notes/risks). Note in the PR that 005 re-gates the trip read endpoints to `view_all_trips` (first enforcement) and that seven items remain BLOCKED on business inputs / upstream slices (labelled defaults, not invented). AI does not merge to `main`.
