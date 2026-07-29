import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { eq, inArray } from "drizzle-orm";
import {
  auditLogs,
  customers,
  db,
  drivers,
  lanes,
  locations,
  tripAssignments,
  tripEvents,
  trips,
  users,
  vehicles,
} from "@brazil-tms/db";
import { dayRangeSaoPaulo } from "@brazil-tms/shared";
import {
  exportTripRows,
  getTripDetailView,
  getTripFilterOptions,
  queryDashboardMetrics,
  queryTripBoard,
} from "./trips-read";

/**
 * Integration test for the feature 005 read models against the live dev DB. Static imports per
 * project convention (`test.skipIf` on lazily-imported modules does NOT work). Skips when
 * DATABASE_URL is unset so the default `pnpm test` stays green. To run it:
 *   $env:DATABASE_URL='postgres://postgres:postgres@localhost:5433/postgres'; pnpm exec vitest run --project web
 *
 * Focus: the board defaults to the active scope (closed/billing statuses excluded); explicit
 * status/billing/customer/AND filters and `q`; whitelist sort by pickup; pagination + full `total`;
 * the enriched detail view (names + importBatchId); the dashboard today-by-status + billing-pending
 * counts with every later-slice metric null; and the export rows + the `EXPORT_TOO_LARGE` cap.
 */
const hasDb = Boolean(process.env.DATABASE_URL);

describe.skipIf(!hasDb)("trips-read (integration)", () => {
  let customerId = "";
  let originId = "";
  let destId = "";
  let laneId = "";

  // Seeded trip ids, captured for FK-safe cleanup.
  let inTransitId = "";
  let receivedId = "";
  let completedId = "";
  let billingPendingId = "";
  let todayPickupId = "";
  let extSearchId = "";

  const createdTripIds: string[] = [];
  const createdLaneIds: string[] = [];
  const createdLocationIds: string[] = [];
  const createdCustomerIds: string[] = [];

  // Feature 006 — a fleet fixture + an assignment on `receivedId` so the board assignment filters,
  // the dashboard unassigned count, and the extended getTripFilterOptions have data to assert against.
  let actorId = "";
  let asgDriverId = "";
  let asgVehicleId = "";
  const createdDriverIds: string[] = [];
  const createdVehicleIds: string[] = [];

  // Unique external id token to scope the board `q`/customer queries to THIS test's seed only.
  const seedToken = `RT${Date.now()}${Math.floor(Math.random() * 1e6)}`;
  let counter = 0;
  function code(prefix = "TRIP-READ-TEST"): string {
    return `${prefix}-${Date.now()}-${Math.floor(Math.random() * 1e6)}`;
  }
  function ext(): string {
    return `${seedToken}-${counter++}`;
  }

  async function seedTrip(
    currentStatus: (typeof trips.$inferSelect)["currentStatus"],
    pickup: Date | null,
  ): Promise<string> {
    const externalTripId = ext();
    const inserted = await db
      .insert(trips)
      .values({
        customerId,
        externalTripId,
        originLocationId: originId,
        destinationLocationId: destId,
        laneId,
        currentStatus,
        originalPlan: { customerId, originLocationId: originId, destinationLocationId: destId },
        plannedPickupWindowStart: pickup,
      })
      .returning({ id: trips.id });
    const id = inserted[0]!.id;
    createdTripIds.push(id);
    return id;
  }

  beforeAll(async () => {
    const cust = await db
      .insert(customers)
      .values({ name: `Cliente Control Tower ${seedToken}`, customerCode: code("CUST") })
      .returning({ id: customers.id });
    customerId = cust[0]!.id;
    createdCustomerIds.push(customerId);

    const origin = await db
      .insert(locations)
      .values({ customerId, code: code("ORIG"), name: `Origem ${seedToken}` })
      .returning({ id: locations.id });
    originId = origin[0]!.id;
    createdLocationIds.push(originId);

    const dest = await db
      .insert(locations)
      .values({ customerId, code: code("DEST"), name: `Destino ${seedToken}` })
      .returning({ id: locations.id });
    destId = dest[0]!.id;
    createdLocationIds.push(destId);

    const lane = await db
      .insert(lanes)
      .values({ customerId, originLocationId: originId, destinationLocationId: destId })
      .returning({ id: lanes.id });
    laneId = lane[0]!.id;
    createdLaneIds.push(laneId);

    // Trips across different statuses + pickup dates. The "today" trip pins its pickup to the middle
    // of the current São Paulo day so the dashboard groups it regardless of the host timezone.
    const { from } = dayRangeSaoPaulo(new Date());
    const todayMidday = new Date(new Date(from).getTime() + 12 * 60 * 60 * 1000);

    inTransitId = await seedTrip("in_transit", new Date("2026-06-01T08:00:00.000Z"));
    receivedId = await seedTrip("received", new Date("2026-06-02T08:00:00.000Z"));
    completedId = await seedTrip("completed", new Date("2026-06-03T08:00:00.000Z"));
    billingPendingId = await seedTrip("billing_pending", new Date("2026-06-04T08:00:00.000Z"));
    todayPickupId = await seedTrip("in_transit", todayMidday);
    extSearchId = inTransitId;

    // 006 fleet + a current assignment on the received trip (so board/dashboard/options have data).
    const admin = await db
      .select({ id: users.id })
      .from(users)
      .where(eq(users.email, "admin@braziltransports.com.br"))
      .limit(1);
    actorId = admin[0]?.id ?? "";

    const driver = await db
      .insert(drivers)
      .values({ name: `Motorista ${seedToken}`, ownershipType: "owned", status: "active" })
      .returning({ id: drivers.id });
    asgDriverId = driver[0]!.id;
    createdDriverIds.push(asgDriverId);

    const vehicle = await db
      .insert(vehicles)
      .values({ plate: `RT${seedToken}`.slice(0, 12), vehicleType: "truck", ownershipType: "owned", status: "active" })
      .returning({ id: vehicles.id });
    asgVehicleId = vehicle[0]!.id;
    createdVehicleIds.push(asgVehicleId);

    // Bind the fleet to `receivedId` as the single current assignment (direct insert — the read
    // models only care about the `is_current` join, not the write-path transitions).
    await db.insert(tripAssignments).values({
      tripId: receivedId,
      driverId: asgDriverId,
      vehicleId: asgVehicleId,
      assignedByUserId: actorId,
      isCurrent: true,
    });
  });

  afterAll(async () => {
    // FK-safe order: assignments → trip_events + audit (for trips) → trips → fleet → lanes → locations → customers.
    if (createdTripIds.length) {
      await db.delete(tripAssignments).where(inArray(tripAssignments.tripId, createdTripIds));
      await db.delete(tripEvents).where(inArray(tripEvents.tripId, createdTripIds));
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, createdTripIds));
      await db.delete(trips).where(inArray(trips.id, createdTripIds));
    }
    if (createdDriverIds.length) {
      await db.delete(drivers).where(inArray(drivers.id, createdDriverIds));
    }
    if (createdVehicleIds.length) {
      await db.delete(vehicles).where(inArray(vehicles.id, createdVehicleIds));
    }
    if (createdLaneIds.length) {
      await db.delete(lanes).where(inArray(lanes.id, createdLaneIds));
    }
    if (createdLocationIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, createdLocationIds));
      await db.delete(locations).where(inArray(locations.id, createdLocationIds));
    }
    if (createdCustomerIds.length) {
      await db.delete(auditLogs).where(inArray(auditLogs.entityId, createdCustomerIds));
      await db.delete(customers).where(inArray(customers.id, createdCustomerIds));
    }
  });

  // A board query scoped to this seed's customer with sane defaults.
  function boardQuery(overrides: Partial<Parameters<typeof queryTripBoard>[0]> = {}) {
    return {
      customerId,
      scope: "active" as const,
      sort: "pickupStart" as const,
      dir: "asc" as const,
      limit: 50,
      offset: 0,
      ...overrides,
    } as Parameters<typeof queryTripBoard>[0];
  }

  it("default active scope excludes completed/billing statuses", async () => {
    const { rows } = await queryTripBoard(boardQuery());
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inTransitId);
    expect(ids).toContain(receivedId);
    expect(ids).toContain(todayPickupId);
    expect(ids).not.toContain(completedId);
    expect(ids).not.toContain(billingPendingId);
  });

  it("explicit status filter overrides the active default", async () => {
    const { rows } = await queryTripBoard(boardQuery({ status: ["completed"] }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(completedId);
    expect(ids).not.toContain(inTransitId);
  });

  it("billingStatus filter maps to the matching current_status", async () => {
    const { rows } = await queryTripBoard(boardQuery({ billingStatus: "billing_pending" }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(billingPendingId);
    expect(ids).not.toContain(inTransitId);
    expect(rows.every((r) => r.billingStatus === "billing_pending")).toBe(true);
  });

  it("AND-combines customer + status filters", async () => {
    const { rows } = await queryTripBoard(boardQuery({ status: ["received"] }));
    expect(rows.every((r) => r.customerId === customerId)).toBe(true);
    expect(rows.map((r) => r.id)).toEqual([receivedId]);
  });

  it("status + billingStatus compose with AND (intersection), not else-if", async () => {
    // Contradictory pair → empty: a trip cannot be both in_transit AND billing_pending.
    const contradictory = await queryTripBoard(
      boardQuery({ status: ["in_transit"], billingStatus: "billing_pending" }),
    );
    expect(contradictory.rows).toHaveLength(0);

    // Consistent pair → the intersection (the billing_pending trip).
    const consistent = await queryTripBoard(
      boardQuery({ status: ["billing_pending"], billingStatus: "billing_pending" }),
    );
    expect(consistent.rows.map((r) => r.id)).toEqual([billingPendingId]);
  });

  it("getTripFilterOptions returns the active customers / locations / lanes for dropdowns", async () => {
    const options = await getTripFilterOptions();
    expect(options.customers.some((c) => c.id === customerId)).toBe(true);
    expect(options.locations.some((l) => l.id === originId && l.code !== "")).toBe(true);
    expect(options.locations.some((l) => l.id === destId)).toBe(true);
    expect(
      options.lanes.some(
        (l) => l.id === laneId && l.originLocationId === originId && l.destinationLocationId === destId,
      ),
    ).toBe(true);
  });

  it("q matches the external trip id and enriches names + laneLabel", async () => {
    const target = await db
      .select({ externalTripId: trips.externalTripId })
      .from(trips)
      .where(eq(trips.id, extSearchId))
      .limit(1);
    const { rows } = await queryTripBoard(boardQuery({ q: target[0]!.externalTripId! }));
    expect(rows.map((r) => r.id)).toEqual([extSearchId]);
    const row = rows[0]!;
    expect(row.customerName).toContain(seedToken);
    expect(row.originName).toContain(seedToken);
    expect(row.laneLabel).toBe(`${row.originCode} → ${row.destinationCode}`);
  });

  it("sorts by pickupStart ascending", async () => {
    const { rows } = await queryTripBoard(boardQuery({ scope: "all" }));
    const pickups = rows
      .map((r) => r.plannedPickupWindowStart)
      .filter((p): p is string => p !== null);
    const sorted = [...pickups].sort();
    expect(pickups).toEqual(sorted);
  });

  it("paginates while reporting the full match total", async () => {
    const full = await queryTripBoard(boardQuery({ scope: "all" }));
    expect(full.total).toBe(createdTripIds.length);
    expect(full.rows.length).toBe(createdTripIds.length);

    const page = await queryTripBoard(boardQuery({ scope: "all", limit: 2, offset: 0 }));
    expect(page.rows.length).toBe(2);
    // total is independent of limit/offset.
    expect(page.total).toBe(createdTripIds.length);
  });

  it("getTripDetailView returns enriched names + importBatchId", async () => {
    const detail = await getTripDetailView(inTransitId);
    expect(detail).not.toBeNull();
    expect(detail!.id).toBe(inTransitId);
    expect(detail!.customerName).toContain(seedToken);
    expect(detail!.originName).toContain(seedToken);
    expect(detail!.destinationCode).not.toBe("");
    expect(detail!.laneLabel).toBe(`${detail!.originCode} → ${detail!.destinationCode}`);
    // importBatchId is surfaced (null for this seed) — the field exists on the view.
    expect(detail!.importBatchId).toBeNull();
    expect(Array.isArray(detail!.events)).toBe(true);
  });

  it("getTripDetailView returns null for an unknown id", async () => {
    const missing = await getTripDetailView("00000000-0000-0000-0000-000000000000");
    expect(missing).toBeNull();
  });

  it("queryDashboardMetrics counts today's pickup by status + billing pending; 006/007 fill their metrics", async () => {
    const metrics = await queryDashboardMetrics();

    const todayInTransit = metrics.tripsTodayByStatus.find((s) => s.status === "in_transit");
    expect(todayInTransit).toBeDefined();
    expect(todayInTransit!.count).toBeGreaterThanOrEqual(1);

    expect(metrics.billingPendingCount).toBeGreaterThanOrEqual(1);

    // 006 — unassignedTrips is now a COUNT (active trips with no current assignment), no longer null.
    // This seed has active+unassigned trips (in_transit + today), so the count is ≥ 2; the assigned
    // `receivedId` is excluded.
    expect(metrics.unassignedTrips).not.toBeNull();
    expect(metrics.unassignedTrips!).toBeGreaterThanOrEqual(2);

    // 007 — tripsAtRisk + activeExceptions are now COUNTS (always numbers); the on-time percentages
    // are a number or null (null only when there is no denominator).
    expect(typeof metrics.tripsAtRisk).toBe("number");
    expect(typeof metrics.activeExceptions).toBe("number");
    expect(metrics.onTimePickupPct === null || typeof metrics.onTimePickupPct === "number").toBe(true);
    expect(metrics.onTimeArrivalPct === null || typeof metrics.onTimeArrivalPct === "number").toBe(true);
    // 008 — completedMissingDocuments is now a COUNT (billing-phase trips missing required-for-billing
    // proof), no longer the null placeholder.
    expect(typeof metrics.completedMissingDocuments).toBe("number");
    expect(metrics.completedMissingDocuments!).toBeGreaterThanOrEqual(0);
  });

  // -------------------------------------------------------------------------
  // Feature 006 — board assignment filters, dashboard unassigned count, fleet options (T067)
  // -------------------------------------------------------------------------

  it("board assigned=true returns only assigned trips with the joined driver/vehicle names", async () => {
    const { rows } = await queryTripBoard(boardQuery({ scope: "all", assigned: "true" }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(receivedId); // the only assigned trip in this seed.
    expect(ids).not.toContain(inTransitId);
    expect(rows.every((r) => r.isAssigned)).toBe(true);

    const assignedRow = rows.find((r) => r.id === receivedId)!;
    expect(assignedRow.assignedDriverName).toContain(seedToken);
    expect(assignedRow.assignedVehiclePlate).not.toBeNull();
  });

  it("board assigned=false returns only unassigned trips (isAssigned=false, no resource names)", async () => {
    const { rows } = await queryTripBoard(boardQuery({ scope: "all", assigned: "false" }));
    const ids = rows.map((r) => r.id);
    expect(ids).toContain(inTransitId);
    expect(ids).toContain(completedId);
    expect(ids).not.toContain(receivedId); // assigned → excluded.
    expect(rows.every((r) => !r.isAssigned)).toBe(true);
    expect(rows.every((r) => r.assignedDriverName === null)).toBe(true);
  });

  it("queryDashboardMetrics counts active trips with no current assignment", async () => {
    const metrics = await queryDashboardMetrics();
    expect(metrics.unassignedTrips).not.toBeNull();
    // The active+unassigned trips in this seed (in_transit + today pickup) are counted; the ASSIGNED
    // received trip is excluded and completed/billing_pending are not active. This is a GLOBAL count
    // over the shared dev DB (concurrent suites mutate the total), so assert a floor — the two
    // active+unassigned trips this seed owns — never an exact value.
    expect(metrics.unassignedTrips!).toBeGreaterThanOrEqual(2);

    // The assigned received trip must NOT be in the count: the board's assigned=false lens (the same
    // "no current assignment" predicate the dashboard uses) excludes it.
    const unassignedBoard = await queryTripBoard(boardQuery({ scope: "active", assigned: "false" }));
    expect(unassignedBoard.rows.map((r) => r.id)).not.toContain(receivedId);
  });

  it("getTripFilterOptions returns the active (non-archived) fleet lists", async () => {
    const options = await getTripFilterOptions();
    expect(options.drivers.some((d) => d.id === asgDriverId && d.label.includes(seedToken))).toBe(
      true,
    );
    expect(options.vehicles.some((v) => v.id === asgVehicleId && v.label !== "")).toBe(true);
    // The fleet facets are present (arrays), per the extended TripFilterOptions shape.
    expect(Array.isArray(options.trailers)).toBe(true);
    expect(Array.isArray(options.carriers)).toBe(true);
  });

  it("exportTripRows returns the filtered rows without pagination", async () => {
    const { customerId: c, scope, sort, dir } = boardQuery({ scope: "all" });
    const rows = await exportTripRows({ customerId: c, scope, sort, dir } as Parameters<
      typeof exportTripRows
    >[0]);
    expect(rows.length).toBe(createdTripIds.length);
  });

  it("exportTripRows throws Conflict EXPORT_TOO_LARGE when the cap is exceeded", async () => {
    const { customerId: c, scope, sort, dir } = boardQuery({ scope: "all" });
    const query = { customerId: c, scope, sort, dir } as Parameters<typeof exportTripRows>[0];
    let caught: unknown;
    try {
      await exportTripRows(query, 0);
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeDefined();
    expect((caught as { code?: string }).code).toBe("EXPORT_TOO_LARGE");
  });
});
