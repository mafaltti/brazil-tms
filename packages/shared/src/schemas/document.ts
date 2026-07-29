import { z } from "zod";
import { DOCUMENT_VERIFICATION_STATUSES } from "../domain/documents";

/**
 * Feature 008 — document upload-metadata + verification input schemas (data-model §10, contracts §1–2).
 * The binary rides multipart `file`; this validates the JSON `meta` part. File type/size are validated
 * in the upload route BEFORE storing (R9), not here.
 */

export const uploadDocumentMetaSchema = z.object({
  documentTypeId: z.string().uuid("Tipo de documento inválido."),
  externalReference: z.string().trim().max(200, "Referência externa muito longa.").optional(),
  notes: z.string().trim().max(2000, "Observações muito longas.").optional(),
  fileName: z.string().trim().min(1, "Nome do arquivo é obrigatório."),
});

export type UploadDocumentMeta = z.infer<typeof uploadDocumentMetaSchema>;

export const verifyDocumentSchema = z.object({
  verificationStatus: z.enum(DOCUMENT_VERIFICATION_STATUSES),
  notes: z.string().trim().max(2000, "Observações muito longas.").optional(),
});

export type VerifyDocumentInput = z.infer<typeof verifyDocumentSchema>;
