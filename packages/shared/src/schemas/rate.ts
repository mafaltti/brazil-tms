import { z } from "zod";
import { vehicleTypeSchema } from "./master-data";

/**
 * Feature 008 — rate maintenance schemas (data-model §10, contracts §11–12). Money is integer
 * centavos (BRL). The toll/waiting/extra-stop rule texts are gated §29 Input #5 placeholders —
 * stored but NOT interpreted in MVP (manual values until supplied).
 */

export const createRateSchema = z.object({
  customerId: z.string().uuid("Cliente inválido."),
  laneId: z.string().uuid("Rota inválida.").optional(),
  vehicleType: vehicleTypeSchema.optional(),
  baseAmountCents: z.number().int("Valor inválido.").nonnegative("Valor inválido."),
  currency: z.string().trim().length(3, "Moeda inválida.").default("BRL"),
  tollHandlingRule: z.string().trim().max(2000).optional(),
  waitingTimeRule: z.string().trim().max(2000).optional(),
  extraStopRule: z.string().trim().max(2000).optional(),
  effectiveStart: z.coerce.date().optional(),
  effectiveEnd: z.coerce.date().optional(),
  active: z.boolean().default(true),
});

export type CreateRateInput = z.infer<typeof createRateSchema>;

export const updateRateSchema = createRateSchema.partial();

export type UpdateRateInput = z.infer<typeof updateRateSchema>;
