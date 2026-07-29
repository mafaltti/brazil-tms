import { z } from "zod";

/**
 * Feature 007 — alert acknowledgement schema (data-model §10, FR-024). Minimal: the alert id comes
 * from the route param; acknowledgement carries no body. Kept as a schema so the route shape mirrors
 * the rest of the BFF and can grow later without a contract change.
 */

export const acknowledgeAlertSchema = z.object({});

export type AcknowledgeAlertInput = z.infer<typeof acknowledgeAlertSchema>;
