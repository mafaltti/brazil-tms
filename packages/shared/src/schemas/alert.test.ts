import { describe, expect, it } from "vitest";
import { acknowledgeAlertSchema } from "./alert";

/**
 * Unit test for the alert acknowledgement schema (data-model §10). It is intentionally empty (the id
 * comes from the route param) — it must accept an empty body.
 */

describe("acknowledgeAlertSchema", () => {
  it("accepts an empty body", () => {
    expect(acknowledgeAlertSchema.safeParse({}).success).toBe(true);
  });
});
