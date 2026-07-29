import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { customers, customerSlaRules, lanes } from "../../schema";
import { type CreateSlaRuleInput, type UpdateSlaRuleInput } from "@brazil-tms/shared";
import { writeAudit } from "../audit/write-audit";
import { Conflict } from "../errors";

/**
 * Feature 007 US5 — per-customer SLA-rule admin services (data-model §11, CUST-005). The precedence
 * resolution + default fallback already live in `recomputeTripSla`/`resolveSlaPolicy` (T023); these
 * just CRUD the rows (administered via the reused `manage_commercial_data` key). Each mutation is one
 * transaction + a single audit row; `NOT_FOUND` on a missing customer/rule, or a lane that does not
 * belong to the rule's customer. Rows are mutable → never hard-deleted (deactivate via `active=false`).
 */

export type CustomerSlaRuleRow = typeof customerSlaRules.$inferSelect;

/**
 * Create a per-customer SLA rule. Validates the customer exists and, when the rule is lane-scoped,
 * that the lane belongs to THAT customer — a cross-customer lane could never match the customer's
 * trips (they carry the customer's own lanes), silently leaving them on `DEFAULT_SLA_POLICY`.
 */
export async function createCustomerSlaRule(
  input: CreateSlaRuleInput,
  actorUserId: string,
): Promise<CustomerSlaRuleRow> {
  const cust = await db
    .select({ id: customers.id })
    .from(customers)
    .where(eq(customers.id, input.customerId))
    .limit(1);
  if (!cust[0]) throw new Conflict("NOT_FOUND", "Cliente não encontrado.");

  if (input.laneId) {
    const lane = await db
      .select({ id: lanes.id })
      .from(lanes)
      .where(and(eq(lanes.id, input.laneId), eq(lanes.customerId, input.customerId)))
      .limit(1);
    if (!lane[0]) throw new Conflict("NOT_FOUND", "Rota não encontrada para este cliente.");
  }

  return db.transaction(async (tx) => {
    const [created] = await tx
      .insert(customerSlaRules)
      .values({
        customerId: input.customerId,
        laneId: input.laneId ?? null,
        vehicleType: input.vehicleType ?? null,
        pickupToleranceMinutes: input.pickupToleranceMinutes,
        deliveryToleranceMinutes: input.deliveryToleranceMinutes,
        confirmationCutoffMinutes: input.confirmationCutoffMinutes,
        atRiskWarningMinutes: input.atRiskWarningMinutes,
        effectiveStart: input.effectiveStart ?? null,
        effectiveEnd: input.effectiveEnd ?? null,
      })
      .returning();

    await writeAudit(tx, {
      entityType: "customer_sla_rule",
      entityId: created!.id,
      action: "sla_rule.create",
      previousValue: null,
      newValue: { ...input },
      actorUserId,
    });
    return created!;
  });
}

/**
 * Update a per-customer SLA rule (partial; incl. `active`). `NOT_FOUND` on a missing rule, or a
 * re-scoped lane that does not belong to the rule's customer (customerId is not editable on update).
 */
export async function updateCustomerSlaRule(
  ruleId: string,
  input: UpdateSlaRuleInput,
  actorUserId: string,
): Promise<CustomerSlaRuleRow> {
  const existing = await db
    .select({ id: customerSlaRules.id, customerId: customerSlaRules.customerId })
    .from(customerSlaRules)
    .where(eq(customerSlaRules.id, ruleId))
    .limit(1);
  if (!existing[0]) throw new Conflict("NOT_FOUND", "Regra de SLA não encontrada.");

  if (input.laneId) {
    const lane = await db
      .select({ id: lanes.id })
      .from(lanes)
      .where(and(eq(lanes.id, input.laneId), eq(lanes.customerId, existing[0].customerId)))
      .limit(1);
    if (!lane[0]) throw new Conflict("NOT_FOUND", "Rota não encontrada para este cliente.");
  }

  const patch: Partial<typeof customerSlaRules.$inferInsert> = { updatedAt: new Date() };
  if (input.laneId !== undefined) patch.laneId = input.laneId;
  if (input.vehicleType !== undefined) patch.vehicleType = input.vehicleType;
  if (input.pickupToleranceMinutes !== undefined) patch.pickupToleranceMinutes = input.pickupToleranceMinutes;
  if (input.deliveryToleranceMinutes !== undefined) patch.deliveryToleranceMinutes = input.deliveryToleranceMinutes;
  if (input.confirmationCutoffMinutes !== undefined) patch.confirmationCutoffMinutes = input.confirmationCutoffMinutes;
  if (input.atRiskWarningMinutes !== undefined) patch.atRiskWarningMinutes = input.atRiskWarningMinutes;
  if (input.effectiveStart !== undefined) patch.effectiveStart = input.effectiveStart;
  if (input.effectiveEnd !== undefined) patch.effectiveEnd = input.effectiveEnd;
  if (input.active !== undefined) patch.active = input.active;

  return db.transaction(async (tx) => {
    const [updated] = await tx
      .update(customerSlaRules)
      .set(patch)
      .where(eq(customerSlaRules.id, ruleId))
      .returning();

    await writeAudit(tx, {
      entityType: "customer_sla_rule",
      entityId: ruleId,
      action: "sla_rule.update",
      previousValue: null,
      newValue: { ...input },
      actorUserId,
    });
    return updated!;
  });
}
