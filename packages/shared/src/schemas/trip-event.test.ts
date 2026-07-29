import { describe, expect, it } from "vitest";
import { addTripNoteSchema } from "./trip-event";

/**
 * Unit tests for the free-form trip-note schema (data-model §10). `notes` is required (1..2000);
 * location/exception ids are optional UUIDs; eventTimestamp coerces to a Date.
 */

const UUID = "11111111-1111-1111-1111-111111111111";

describe("addTripNoteSchema", () => {
  it("requires a non-empty trimmed note", () => {
    expect(addTripNoteSchema.safeParse({ notes: "" }).success).toBe(false);
    expect(addTripNoteSchema.safeParse({ notes: "   " }).success).toBe(false);
    expect(addTripNoteSchema.parse({ notes: "  chegou atrasado  " }).notes).toBe("chegou atrasado");
  });

  it("accepts optional locationId/exceptionId/eventTimestamp", () => {
    const r = addTripNoteSchema.parse({
      notes: "ok",
      locationId: UUID,
      exceptionId: UUID,
      eventTimestamp: "2026-06-01T10:00:00.000Z",
    });
    expect(r.locationId).toBe(UUID);
    expect(r.exceptionId).toBe(UUID);
    expect(r.eventTimestamp).toBeInstanceOf(Date);
  });

  it("treats a blank optional uuid as absent and rejects a bad uuid", () => {
    expect(addTripNoteSchema.parse({ notes: "ok", locationId: "" }).locationId).toBeUndefined();
    expect(addTripNoteSchema.safeParse({ notes: "ok", exceptionId: "x" }).success).toBe(false);
  });

  it("rejects a note over 2000 chars", () => {
    expect(addTripNoteSchema.safeParse({ notes: "a".repeat(2001) }).success).toBe(false);
  });
});
