import { z } from "zod";
import { vehicleTypeSchema } from "./master-data";

/**
 * Feature 008 — per-customer document-requirement checklist + the document-type master schemas
 * (data-model §10, contracts §7–10). Administered via the reused `manage_commercial_data` key.
 */

export const createDocumentRequirementSchema = z.object({
  customerId: z.string().uuid("Cliente inválido."),
  documentTypeId: z.string().uuid("Tipo de documento inválido."),
  requiredForCompletion: z.boolean().default(false),
  requiredForBilling: z.boolean().default(true),
  laneId: z.string().uuid("Rota inválida.").optional(),
  vehicleType: vehicleTypeSchema.optional(),
  active: z.boolean().default(true),
});

export type CreateDocumentRequirementInput = z.infer<typeof createDocumentRequirementSchema>;

export const updateDocumentRequirementSchema = createDocumentRequirementSchema.partial();

export type UpdateDocumentRequirementInput = z.infer<typeof updateDocumentRequirementSchema>;

export const createDocumentTypeSchema = z.object({
  code: z.string().trim().min(1, "Código é obrigatório.").max(50, "Código muito longo."),
  labelPt: z.string().trim().min(1, "Rótulo é obrigatório.").max(120, "Rótulo muito longo."),
  active: z.boolean().default(true),
  sortOrder: z.number().int("Ordem inválida.").optional(),
});

export type CreateDocumentTypeInput = z.infer<typeof createDocumentTypeSchema>;

export const updateDocumentTypeSchema = createDocumentTypeSchema.partial();

export type UpdateDocumentTypeInput = z.infer<typeof updateDocumentTypeSchema>;
