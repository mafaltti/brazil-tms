import { z } from "zod";

/**
 * Slice 025 (issue #32 [0009]) — shared contracts for the driver/vehicle "Documentos" tab.
 * Registry attachments are an APPEND-ONLY history; the document type is FREE TEXT (≤ 60) with
 * per-entity UI suggestions — deliberately no config table until the business asks (KISS).
 */

export const RESOURCE_DOCUMENT_ENTITY_TYPES = ["driver", "vehicle"] as const;
export type ResourceDocumentEntityType = (typeof RESOURCE_DOCUMENT_ENTITY_TYPES)[number];

/** Upload metadata (the file itself travels as multipart alongside this). */
export const uploadResourceDocumentMetaSchema = z.object({
  docType: z
    .string()
    .trim()
    .min(1, "Informe o tipo do documento.")
    .max(60, "O tipo deve ter no máximo 60 caracteres."),
});
export type UploadResourceDocumentMeta = z.infer<typeof uploadResourceDocumentMetaSchema>;

/** What the list endpoint returns per history entry (newest first). */
export interface ResourceDocumentDto {
  id: string;
  entityType: ResourceDocumentEntityType;
  entityId: string;
  docType: string;
  fileName: string;
  contentType: string;
  sizeBytes: number;
  uploadedByUserId: string;
  createdAt: string;
}

/** UI suggestions for the free-text type field (not a validation constraint). */
export const RESOURCE_DOCUMENT_TYPE_SUGGESTIONS: Record<ResourceDocumentEntityType, string[]> = {
  driver: ["CNH digital", "Photocheck", "Comprovante de endereço", "Exame toxicológico"],
  vehicle: ["CRLV digital", "ANTT", "Seguro", "Laudo de inspeção", "Foto do veículo"],
};
