import { z } from "zod";
import {
  CANCELLATION_RESPONSIBLE_PARTIES,
  TRIP_EVENT_SOURCES,
  TRIP_STATUSES,
} from "../domain/trip-status";
import { vehicleTypeSchema } from "./master-data";

/**
 * Shared Zod schemas for the feature 003 trip domain (data-model.md §Validation; pt-BR messages).
 * These validate the inputs to the reusable service functions (`apps/web/lib/trips/*`) — and the
 * later slices' route handlers that call them — at the boundary (400) before any row is touched.
 * The DB also enforces hard invariants (enum membership, FKs, the origin≠dest CHECK); a denied/failed
 * mutation causes no state change (SC-001, SC-004). Status legality and the billing projection are
 * NOT here — they live in `../domain/trip-status` (the single source of truth).
 */

const uuid = (label: string) => z.string().uuid(`${label} inválido.`);

/** Optional timestamp accepting an ISO string or a Date; absent/blank stays undefined/null. */
const optionalTimestamp = z.coerce.date().nullable().optional();

/** Optional non-negative integer (volumes, weight, pallet counts). */
const optionalCount = z
  .number()
  .int("Deve ser um número inteiro.")
  .nonnegative("Não pode ser negativo.")
  .nullable()
  .optional();

// ---------------------------------------------------------------------------
// createTrip — capture the imported/seeded plan; the service snapshots `original_plan`. The born status
// is the service's `initialStatus` param (default `received`; `validated` for imports — slice 014),
// NOT a field on this schema.
// ---------------------------------------------------------------------------

export const createTripSchema = z
  .object({
    customerId: uuid("Cliente"),
    externalTripId: z.string().trim().min(1).max(200).nullable().optional(),
    importBatchId: uuid("Lote de importação").nullable().optional(),
    originLocationId: uuid("Local de origem"),
    destinationLocationId: uuid("Local de destino"),
    laneId: uuid("Rota").nullable().optional(),
    plannedPickupWindowStart: optionalTimestamp,
    plannedPickupWindowEnd: optionalTimestamp,
    plannedDeliveryWindowStart: optionalTimestamp,
    plannedDeliveryWindowEnd: optionalTimestamp,
    plannedVehicleType: vehicleTypeSchema.nullable().optional(),
    plannedVolumeUnits: optionalCount,
    plannedWeightKg: optionalCount,
    plannedPalletCount: optionalCount,
    plannedRouteNotes: z.string().trim().max(2000).nullable().optional(),
    plannedServiceRequirements: z.record(z.string(), z.unknown()).nullable().optional(),
  })
  .refine((v) => v.originLocationId !== v.destinationLocationId, {
    message: "Origem e destino devem ser diferentes.",
    path: ["destinationLocationId"],
  });

export type CreateTripInput = z.infer<typeof createTripSchema>;

// ---------------------------------------------------------------------------
// transitionTripStatus — status-guarded, atomic transition (R7)
// ---------------------------------------------------------------------------

export const transitionTripSchema = z.object({
  toStatus: z.enum(TRIP_STATUSES, { message: "Status de destino inválido." }),
  expectedFromStatus: z.enum(TRIP_STATUSES, { message: "Status de origem inválido." }),
  eventTimestamp: z.coerce.date().optional(),
  source: z.enum(TRIP_EVENT_SOURCES).optional(),
  notes: z.string().trim().max(2000).optional(),
});

export type TransitionTripInput = z.infer<typeof transitionTripSchema>;

// ---------------------------------------------------------------------------
// updateTripPlan — accepted customer update to live planned_* fields; original_plan untouched
// ---------------------------------------------------------------------------

/** The live, updatable planned fields (the immutable `original_plan` snapshot is never among these). */
export const tripPlanFieldsSchema = z.object({
  plannedPickupWindowStart: optionalTimestamp,
  plannedPickupWindowEnd: optionalTimestamp,
  plannedDeliveryWindowStart: optionalTimestamp,
  plannedDeliveryWindowEnd: optionalTimestamp,
  plannedVehicleType: vehicleTypeSchema.nullable().optional(),
  plannedVolumeUnits: optionalCount,
  plannedWeightKg: optionalCount,
  plannedPalletCount: optionalCount,
  plannedRouteNotes: z.string().trim().max(2000).nullable().optional(),
  plannedServiceRequirements: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type TripPlanFields = z.infer<typeof tripPlanFieldsSchema>;

/** The 10 live planned-field keys, derived from `tripPlanFieldsSchema` (single source of truth). */
export const PLAN_FIELD_KEYS = Object.keys(tripPlanFieldsSchema.shape) as (keyof TripPlanFields)[];

/**
 * Plan-update boundary schema: partial planned_* + the post-`confirmed` authorized-review flag
 * (003 FR-005). Feature 005 (TRIP-005) tightens it for the inline editor: at least one plan field must
 * be present (an empty edit is a 400, not a no-op) and each provided window's start must be ≤ its end.
 * The route adds the orthogonal "before completion" status guard (`409 EDIT_NOT_ALLOWED`).
 */
export const updateTripPlanSchema = tripPlanFieldsSchema
  .extend({ authorizedReview: z.boolean().optional() })
  .superRefine((v, ctx) => {
    if (!PLAN_FIELD_KEYS.some((k) => v[k] !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe ao menos um campo para atualizar.",
        path: [],
      });
    }
    if (
      v.plannedPickupWindowStart instanceof Date &&
      v.plannedPickupWindowEnd instanceof Date &&
      v.plannedPickupWindowStart > v.plannedPickupWindowEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O início da janela de coleta deve ser anterior ou igual ao fim.",
        path: ["plannedPickupWindowEnd"],
      });
    }
    if (
      v.plannedDeliveryWindowStart instanceof Date &&
      v.plannedDeliveryWindowEnd instanceof Date &&
      v.plannedDeliveryWindowStart > v.plannedDeliveryWindowEnd
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "O início da janela de entrega deve ser anterior ou igual ao fim.",
        path: ["plannedDeliveryWindowEnd"],
      });
    }
  });

export type UpdateTripPlanInput = z.infer<typeof updateTripPlanSchema>;

// ---------------------------------------------------------------------------
// cancelTrip — the five required inputs (R8, FR-019..FR-022)
// ---------------------------------------------------------------------------

export const cancelTripSchema = z.object({
  reasonCode: z.string().trim().min(1, "Informe o motivo do cancelamento."),
  cancellationTimestamp: z.coerce.date().optional(),
  responsibleParty: z.enum(CANCELLATION_RESPONSIBLE_PARTIES, {
    message: "Informe a parte responsável pelo cancelamento.",
  }),
  billingImpact: z.string().trim().min(1, "Informe o impacto de faturamento."),
});

export type CancelTripInput = z.infer<typeof cancelTripSchema>;
