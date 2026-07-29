import { z } from "zod";
import {
  EXCEPTION_RESPONSIBLE_PARTIES,
  EXCEPTION_SEVERITIES,
  EXCEPTION_STATUSES,
} from "../domain/exceptions";

/**
 * Feature 007 — exception write + filter schemas (data-model §10, FR-008..FR-013). They validate the
 * inputs to the exception service functions and the BFF routes at the boundary (400) before any row is
 * touched. Severity/responsible-party are optional on create (reason-code defaults pre-fill them
 * server-side); the category is DERIVED from the reason code, never an input.
 */

const uuid = (label: string) => z.string().uuid(`${label} inválido.`);

const optionalUuid = (label: string) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), uuid(label).optional());

const optionalDescription = z.string().trim().max(2000, "Máximo de 2000 caracteres.").optional();

// ---------------------------------------------------------------------------
// createException — reason code suggests defaults; owner defaults to the actor
// ---------------------------------------------------------------------------

export const createExceptionSchema = z.object({
  reasonCodeId: uuid("Código de motivo"),
  severity: z.enum(EXCEPTION_SEVERITIES, { message: "Severidade inválida." }).optional(),
  responsibleParty: z
    .enum(EXCEPTION_RESPONSIBLE_PARTIES, { message: "Parte responsável inválida." })
    .optional(),
  ownerUserId: optionalUuid("Responsável"),
  description: optionalDescription,
});

export type CreateExceptionInput = z.infer<typeof createExceptionSchema>;

// ---------------------------------------------------------------------------
// updateException — edit owner/severity/responsible-party/description (≥1 present)
// ---------------------------------------------------------------------------

export const updateExceptionSchema = z
  .object({
    ownerUserId: optionalUuid("Responsável"),
    severity: z.enum(EXCEPTION_SEVERITIES, { message: "Severidade inválida." }).optional(),
    responsibleParty: z
      .enum(EXCEPTION_RESPONSIBLE_PARTIES, { message: "Parte responsável inválida." })
      .optional(),
    description: optionalDescription,
  })
  .superRefine((v, ctx) => {
    if (
      v.ownerUserId === undefined &&
      v.severity === undefined &&
      v.responsibleParty === undefined &&
      v.description === undefined
    ) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe ao menos um campo para atualizar.",
        path: [],
      });
    }
  });

export type UpdateExceptionInput = z.infer<typeof updateExceptionSchema>;

// ---------------------------------------------------------------------------
// transitionException — Open↔Monitoring; →Resolved/Cancelled (closure notes on Resolve)
// ---------------------------------------------------------------------------

export const transitionExceptionSchema = z
  .object({
    expectedFromStatus: z.enum(EXCEPTION_STATUSES, { message: "Status de origem inválido." }),
    toStatus: z.enum(EXCEPTION_STATUSES, { message: "Status de destino inválido." }),
    closureNotes: z.string().trim().max(2000, "Máximo de 2000 caracteres.").optional(),
  })
  .superRefine((v, ctx) => {
    if (v.toStatus === "resolved" && (v.closureNotes == null || v.closureNotes.length === 0)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Informe as notas de encerramento para resolver a exceção.",
        path: ["closureNotes"],
      });
    }
  });

export type TransitionExceptionInput = z.infer<typeof transitionExceptionSchema>;

// ---------------------------------------------------------------------------
// exceptionFilterSchema — Exception Management list (FR-013)
// ---------------------------------------------------------------------------

const optParam = <T extends z.ZodTypeAny>(schema: T) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), schema.optional());

const uuidParam = (label: string) => optParam(z.string().uuid(`${label} inválido.`));

export const exceptionFilterSchema = z.object({
  severity: optParam(z.enum(EXCEPTION_SEVERITIES)),
  status: optParam(z.enum(EXCEPTION_STATUSES)),
  customerId: uuidParam("Cliente"),
  laneId: uuidParam("Rota"),
  reasonCodeId: uuidParam("Código de motivo"),
  ownerUserId: uuidParam("Responsável"),
  /** Minimum age in hours since `opened_at` (FR-013 age filter). */
  minAgeHours: optParam(z.coerce.number().int().nonnegative()),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export type ExceptionFilter = z.infer<typeof exceptionFilterSchema>;
