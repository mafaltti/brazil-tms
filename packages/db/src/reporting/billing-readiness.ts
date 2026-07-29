import { and, eq, inArray, sql, type SQL } from "drizzle-orm";
import {
  billingPeriodMonths,
  BILLING_PROVISIONAL_REASON,
  resolveReportPeriod,
  type BillingPhaseCounts,
  type BillingReadinessGroupRow,
  type BillingReadinessReport,
  type ReportFilter,
} from "@brazil-tms/shared";
import { db } from "../client";
import { billingItems, customers, documentRequirements, trips } from "../../schema";
import { missingBillingDocumentsSql } from "../trips/trips-read";

/**
 * Feature 009 — billing-readiness read model (REP-004, US3; data-model §4, research R4/R8). Read-only
 * projection over `billing_items` (period = `billing_period`, the 008 month-of-completion) joined to
 * `trips`. Phase counts come from the `billingStatus(current_status)` projection (003 — counted by
 * `current_status`, never a stored billing_status); `completedMissingDocuments` reuses the EXACT 008
 * missing-proof predicate (`missingBillingDocumentsSql`); `pctReadyWithin24h` is the share of completed
 * trips whose `completed`→`billing_ready` `trip_events` gap is ≤ 24h (clarify Q3). `provisional` is true
 * when an included customer has no explicit document checklist (default rules → sign-off blocked, R8).
 * Grouping is fixed to customer.
 */

// completion→billing_ready cycle-time, from the append-only trip_events (R4). Min event instant per kind.
const completedAt = sql`(
  SELECT min(coalesce(e.event_timestamp, e.created_at))
  FROM trip_events e WHERE e.trip_id = ${trips.id} AND e.status_after = 'completed'
)`;
const billingReadyAt = sql`(
  SELECT min(coalesce(e.event_timestamp, e.created_at))
  FROM trip_events e WHERE e.trip_id = ${trips.id} AND e.status_after = 'billing_ready'
)`;
const readyWithin24h = sql`${completedAt} IS NOT NULL AND ${billingReadyAt} IS NOT NULL AND ${billingReadyAt} <= ${completedAt} + interval '24 hours'`;

function phaseAgg() {
  return {
    billing_pending: sql<number>`count(*) FILTER (WHERE ${trips.currentStatus} = 'billing_pending')::int`,
    billing_ready: sql<number>`count(*) FILTER (WHERE ${trips.currentStatus} = 'billing_ready')::int`,
    billed: sql<number>`count(*) FILTER (WHERE ${trips.currentStatus} = 'billed')::int`,
    disputed: sql<number>`count(*) FILTER (WHERE ${trips.currentStatus} = 'disputed')::int`,
  };
}

const pct = (num: number, denom: number): number | null =>
  denom > 0 ? Math.round((Number(num) / Number(denom)) * 100) : null;

export async function queryBillingReadinessReport(
  filters: ReportFilter,
): Promise<BillingReadinessReport> {
  const period = resolveReportPeriod(filters, new Date());
  const months = billingPeriodMonths(period);

  const conditions: SQL[] = [inArray(billingItems.billingPeriod, months)];
  if (filters.customerId) conditions.push(eq(billingItems.customerId, filters.customerId));
  const where = and(...conditions);

  const phase = phaseAgg();

  const [overallRows, groupRows] = await Promise.all([
    db
      .select({
        ...phase,
        completedMissingDocuments: sql<number>`count(*) FILTER (WHERE ${missingBillingDocumentsSql()})::int`,
        readyDenom: sql<number>`count(*) FILTER (WHERE ${completedAt} IS NOT NULL)::int`,
        readyNum: sql<number>`count(*) FILTER (WHERE ${readyWithin24h})::int`,
      })
      .from(billingItems)
      .innerJoin(trips, eq(billingItems.tripId, trips.id))
      .where(where),
    db
      .select({ customerId: billingItems.customerId, customerName: customers.name, ...phase })
      .from(billingItems)
      .innerJoin(trips, eq(billingItems.tripId, trips.id))
      .leftJoin(customers, eq(billingItems.customerId, customers.id))
      .where(where)
      .groupBy(billingItems.customerId, customers.name),
  ]);

  const o = overallRows[0];
  const phaseCounts: BillingPhaseCounts = {
    billing_pending: Number(o?.billing_pending ?? 0),
    billing_ready: Number(o?.billing_ready ?? 0),
    billed: Number(o?.billed ?? 0),
    disputed: Number(o?.disputed ?? 0),
  };

  const groups: BillingReadinessGroupRow[] = groupRows
    .map((r) => ({
      groupKey: r.customerId,
      groupLabel: r.customerName ?? "",
      billing_pending: Number(r.billing_pending),
      billing_ready: Number(r.billing_ready),
      billed: Number(r.billed),
      disputed: Number(r.disputed),
    }))
    .sort((a, b) => a.groupLabel.localeCompare(b.groupLabel, "pt-BR"));

  // provisional: any included customer without an explicit (active) document checklist runs on the
  // default rules (§29 #3/#5) → billing-readiness sign-off blocked (R8).
  const customerRows = await db
    .selectDistinct({ customerId: billingItems.customerId })
    .from(billingItems)
    .where(where);
  const includedCustomerIds = customerRows.map((r) => r.customerId);
  let provisional = false;
  if (includedCustomerIds.length > 0) {
    const ruled = await db
      .selectDistinct({ customerId: documentRequirements.customerId })
      .from(documentRequirements)
      .where(
        and(
          inArray(documentRequirements.customerId, includedCustomerIds),
          eq(documentRequirements.active, true),
        ),
      );
    const ruledSet = new Set(ruled.map((r) => r.customerId));
    provisional = includedCustomerIds.some((id) => !ruledSet.has(id));
  }

  return {
    period,
    provisional,
    ...(provisional ? { provisionalReason: BILLING_PROVISIONAL_REASON } : {}),
    phaseCounts,
    completedMissingDocuments: Number(o?.completedMissingDocuments ?? 0),
    pctReadyWithin24h: pct(Number(o?.readyNum ?? 0), Number(o?.readyDenom ?? 0)),
    groups,
  };
}
