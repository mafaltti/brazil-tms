import { z } from "zod";
import { vehicleTypeSchema } from "./master-data";

/**
 * Feature 007 — per-customer SLA-rule write schemas (data-model §10, CUST-005, FR-022). Tolerances /
 * cutoff / warning window are minutes (integer ≥ 0) for unambiguous UTC arithmetic. Optional
 * lane/vehicle-type scope + effective dates drive the evaluator's precedence resolution
 * (lane > vehicle-type > customer-default). Administered via the reused `manage_commercial_data` key.
 */

const uuid = (label: string) => z.string().uuid(`${label} inválido.`);

const optionalUuid = (label: string) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), uuid(label).optional());

const minutes = z.number().int("Deve ser um número inteiro.").nonnegative("Não pode ser negativo.");

export const createSlaRuleSchema = z.object({
  customerId: uuid("Cliente"),
  laneId: optionalUuid("Rota"),
  vehicleType: vehicleTypeSchema.optional(),
  pickupToleranceMinutes: minutes,
  deliveryToleranceMinutes: minutes,
  confirmationCutoffMinutes: minutes,
  atRiskWarningMinutes: minutes,
  effectiveStart: z.coerce.date().optional(),
  effectiveEnd: z.coerce.date().optional(),
});

export type CreateSlaRuleInput = z.infer<typeof createSlaRuleSchema>;

export const updateSlaRuleSchema = z
  .object({
    laneId: optionalUuid("Rota"),
    vehicleType: vehicleTypeSchema.optional(),
    pickupToleranceMinutes: minutes.optional(),
    deliveryToleranceMinutes: minutes.optional(),
    confirmationCutoffMinutes: minutes.optional(),
    atRiskWarningMinutes: minutes.optional(),
    effectiveStart: z.coerce.date().optional(),
    effectiveEnd: z.coerce.date().optional(),
    active: z.boolean().optional(),
  })
  .superRefine((v, ctx) => {
    if (Object.values(v).every((x) => x === undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe ao menos um campo para atualizar.",
        path: [],
      });
    }
  });

export type UpdateSlaRuleInput = z.infer<typeof updateSlaRuleSchema>;
