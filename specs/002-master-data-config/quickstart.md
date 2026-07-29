# Quickstart: Master Data and Operational Configuration (002)

**Feature**: 002-master-data-config | **Spec**: [spec.md](./spec.md) ·
**Plan**: [plan.md](./plan.md) · **Data model**: [data-model.md](./data-model.md) ·
**Contracts**: [contracts/](./contracts/)

This feature builds on the running feature-001 stack (Supabase + app). It adds seven master-data tables, their
BFF endpoints, and the Administration / Resource Management screens. No new infra, no worker.

## Prerequisites (same stack as 001)

```powershell
pnpm install
docker compose -f infra/supabase/docker-compose.yml up -d   # Postgres + GoTrue + gateway + Mailpit
# Wait for GoTrue health: curl http://localhost:8000/auth/v1/health  -> 200
pnpm --filter @brazil-tms/db db:migrate                      # 001 migrations (users, audit_logs, app_role)
pnpm --filter @brazil-tms/db db:seed                         # bootstrap first Admin (idempotent)
```

## Apply this feature's migration

After adding the new schema files (`packages/db/schema/{customers,locations,lanes,drivers,vehicles,trailers,
carriers}.ts` + enums) and exporting them from `schema/index.ts`:

```powershell
pnpm --filter @brazil-tms/db db:generate    # drizzle-kit generate -> new SQL in packages/db/migrations/
# Review the generated SQL (public schema only; auth.* untouched), then:
pnpm --filter @brazil-tms/db db:migrate     # apply the master-data tables + enums
pnpm --filter @brazil-tms/web dev           # Next.js on http://localhost:3000
```

Optional: extend `packages/db/seed/` with a `master-data-sample.ts` seed (a Shopee/DHL/ML customer, a couple of
locations + a lane, one owned vehicle + one subcontracted vehicle with a carrier) to exercise the screens.

## Sign in and exercise the feature

Sign in as the seeded Admin. To verify the permission split, also create (via 001's Users admin) one
Operations Manager, one Fleet Coordinator, and one Dispatcher.

1. **Customers** (`/admin/customers`): create a customer (name, legal name, code, CNPJ, a contact, a billing
   contact) → appears in the list; edit it; archive it → leaves the active list, still retrievable with
   "incluir arquivados". Try a duplicate code → rejected. *(US1)*
2. **Locations & Lanes** (`/admin/locations`, `/admin/lanes`): create two locations under the customer; create
   a lane between them (transit time, default vehicle type, standard rate, toll) → lists customer/origin/dest.
   Try a lane with a different-customer location, or origin = destination → rejected. *(US2)*
3. **Resources** (`/resources/drivers`, `/vehicles`, `/trailers`): create a driver and a vehicle; set each
   through the five statuses (active → maintenance → blocked …); set a past `licenseExpiry`/`documentExpiry` →
   row flagged *vencido*; set one within 30 days → *a vencer*. *(US3)*
4. **Carriers & ownership** (`/resources/carriers`): create a carrier; mark a vehicle **subcontracted** linked
   to it, another **owned** (no carrier). Saving a subcontracted resource with no carrier → rejected. Archive
   the carrier → excluded from new linking, existing links intact. *(US4)*
5. **Governance** (`/resources/*`, `/admin/*`): as the Dispatcher, the master-data nav is hidden and direct
   `POST/PATCH/DELETE` calls return `403`. As Fleet Coordinator, fleet areas work but `/admin/customers`
   returns `403`. Every create/edit/archive/status change appears in the audit log (Admin → `/admin/audit`).
   No record can be hard-deleted. *(US5)*

## Tests

```powershell
pnpm test        # Vitest: master-data Zod schemas (required fields, CNPJ/plate, ownership invariant,
                 #         money non-negative, lane same-customer rule); permission catalog invariants
                 #         (manage_commercial_data / manage_fleet_data / delete_archive per the matrix);
                 #         documentExpiryState(ok|expiring|expired); service-layer lane integrity + audit writes.
pnpm test:e2e    # Playwright: customer CRUD + archive; location/lane create with integrity guards;
                 #         resource status cycle + expiry flag; owned vs subcontracted (carrier required);
                 #         Dispatcher denied (UI hidden + API 403); Fleet Coord blocked on commercial;
                 #         archive-not-delete; audit entry present for each critical change.
```

## Quality gate before PR (targets `dev`)

```powershell
pnpm lint && pnpm typecheck && pnpm build && pnpm test
```

Open the PR against **`dev`** (never `main`) using the PR template (what/why/how-to-test/migration notes/risks).
The migration note must mention the new master-data tables + enums.
