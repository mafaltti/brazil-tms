import { z } from "zod";

/**
 * Feature 007 — free-form trip note write surface (data-model §10, FR-004/EVT-003). Milestone
 * recording REUSES 003's `transitionTripSchema` (`./trip`) — it is NOT redefined here. A note is a
 * `trip_events` row with `event_type='note'` and no status change.
 */

const uuid = (label: string) => z.string().uuid(`${label} inválido.`);

/** Optional, clearable UUID: a blank/null value collapses to undefined. */
const optionalUuid = (label: string) =>
  z.preprocess((v) => (v === "" || v === null ? undefined : v), uuid(label).optional());

export const addTripNoteSchema = z.object({
  notes: z
    .string()
    .trim()
    .min(1, "A nota não pode ser vazia.")
    .max(2000, "Máximo de 2000 caracteres."),
  locationId: optionalUuid("Local"),
  exceptionId: optionalUuid("Exceção"),
  eventTimestamp: z.coerce.date().optional(),
});

export type AddTripNoteInput = z.infer<typeof addTripNoteSchema>;
