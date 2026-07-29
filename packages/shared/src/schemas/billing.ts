import { z } from "zod";
import { BILLING_ADJUSTMENT_TYPES, EXPORT_FORMATS } from "../domain/billing";

/**
 * Feature 008 — billing-value, adjustment, completion/billing-ready, and export input schemas
 * (data-model §10, contracts §5–6, §13–16). Money is integer centavos (BRL); `billingPeriod` is
 * `YYYY-MM`.
 */

const billingPeriodSchema = z
  .string()
  .regex(/^\d{4}-\d{2}$/, "Período de faturamento inválido (use AAAA-MM).");

export const addBillingAdjustmentSchema = z.object({
  type: z.enum(BILLING_ADJUSTMENT_TYPES),
  amountCents: z.number().int("Valor inválido."),
  note: z.string().trim().max(500, "Observação muito longa.").optional(),
});

export type AddBillingAdjustmentInput = z.infer<typeof addBillingAdjustmentSchema>;

export const updateBillingItemSchema = z.object({
  baseFreightCents: z.number().int("Valor inválido.").optional(),
  billingPeriod: billingPeriodSchema.optional(),
  disputeStatus: z.enum(["none", "open", "resolved"]).optional(),
  notes: z.string().trim().max(2000, "Observações muito longas.").optional(),
});

export type UpdateBillingItemInput = z.infer<typeof updateBillingItemSchema>;

const waivedRequirementsSchema = z
  .array(
    z.object({
      documentTypeId: z.string().uuid("Tipo de documento inválido."),
      reason: z.string().trim().min(1, "Justificativa é obrigatória.").max(2000, "Justificativa muito longa."),
    }),
  )
  .optional();

export const markCompletedSchema = z.object({
  waivedRequirements: waivedRequirementsSchema,
});

export type MarkCompletedInput = z.infer<typeof markCompletedSchema>;

export const markBillingReadySchema = z.object({
  waivedRequirements: waivedRequirementsSchema,
});

export type MarkBillingReadyInput = z.infer<typeof markBillingReadySchema>;

export const createExportSchema = z.object({
  customerId: z.string().uuid("Cliente inválido."),
  billingPeriod: billingPeriodSchema,
  format: z.enum(EXPORT_FORMATS),
});

export type CreateExportInput = z.infer<typeof createExportSchema>;
