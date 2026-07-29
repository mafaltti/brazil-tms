import { describe, expect, it } from "vitest";
import {
  cnpjSchema,
  createCarrierSchema,
  createCustomerSchema,
  createDriverSchema,
  createLaneSchema,
  createLocationSchema,
  createTrailerSchema,
  createVehicleSchema,
  isOwnershipCarrierValid,
  plateSchema,
  ufSchema,
  updateCustomerSchema,
  updateDriverSchema,
  updateVehicleSchema,
} from "./master-data";

const UUID_A = "11111111-1111-1111-1111-111111111111";
const UUID_B = "22222222-2222-2222-2222-222222222222";
const UUID_C = "33333333-3333-3333-3333-333333333333";

describe("building blocks", () => {
  it("cnpjSchema strips punctuation and requires 14 digits", () => {
    expect(cnpjSchema.parse("12.345.678/0001-95")).toBe("12345678000195");
    expect(cnpjSchema.safeParse("123").success).toBe(false);
  });

  it("plateSchema accepts BR and Mercosul, normalizes case/hyphen", () => {
    expect(plateSchema.parse("abc-1234")).toBe("ABC1234"); // old BR
    expect(plateSchema.parse("ABC1D23")).toBe("ABC1D23"); // Mercosul
    expect(plateSchema.safeParse("12AB345").success).toBe(false);
  });

  it("ufSchema rejects non-UF strings", () => {
    expect(ufSchema.parse("SP")).toBe("SP");
    expect(ufSchema.safeParse("XX").success).toBe(false);
  });
});

describe("customer schema (US1)", () => {
  it("requires name and customerCode", () => {
    expect(createCustomerSchema.safeParse({ name: "", customerCode: "" }).success).toBe(false);
    const ok = createCustomerSchema.safeParse({ name: "Shopee", customerCode: "SHP" });
    expect(ok.success).toBe(true);
    if (ok.success) expect(ok.data.contacts).toEqual([]);
  });

  it("validates a CNPJ taxId and contact shape", () => {
    const res = createCustomerSchema.safeParse({
      name: "DHL",
      customerCode: "DHL",
      taxId: "12.345.678/0001-95",
      contacts: [{ name: "Ana", email: "ana@dhl.com" }],
    });
    expect(res.success).toBe(true);
  });
});

describe("location schema (US2)", () => {
  it("requires customerId, code, name; defaults country to BR", () => {
    const res = createLocationSchema.safeParse({
      customerId: UUID_A,
      code: "CD-SP",
      name: "CD São Paulo",
      state: "SP",
    });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.country).toBe("BR");
  });

  it("rejects an invalid UF", () => {
    expect(
      createLocationSchema.safeParse({ customerId: UUID_A, code: "X", name: "Y", state: "ZZ" })
        .success,
    ).toBe(false);
  });
});

describe("lane schema (US2)", () => {
  it("rejects origin === destination (degenerate lane)", () => {
    const res = createLaneSchema.safeParse({
      customerId: UUID_A,
      originLocationId: UUID_B,
      destinationLocationId: UUID_B,
    });
    expect(res.success).toBe(false);
  });

  it("accepts distinct endpoints and non-negative money", () => {
    const res = createLaneSchema.safeParse({
      customerId: UUID_A,
      originLocationId: UUID_B,
      destinationLocationId: UUID_C,
      standardRateCents: 150000,
      tollEstimateCents: 0,
    });
    expect(res.success).toBe(true);
  });

  it("rejects negative money", () => {
    expect(
      createLaneSchema.safeParse({
        customerId: UUID_A,
        originLocationId: UUID_B,
        destinationLocationId: UUID_C,
        standardRateCents: -1,
      }).success,
    ).toBe(false);
  });
});

describe("ownership/carrier invariant (US3/US4)", () => {
  it("isOwnershipCarrierValid enforces the rule", () => {
    expect(isOwnershipCarrierValid({ ownershipType: "owned" })).toBe(true);
    expect(isOwnershipCarrierValid({ ownershipType: "owned", carrierId: UUID_A })).toBe(false);
    expect(isOwnershipCarrierValid({ ownershipType: "subcontracted" })).toBe(false);
    expect(isOwnershipCarrierValid({ ownershipType: "subcontracted", carrierId: UUID_A })).toBe(
      true,
    );
    expect(isOwnershipCarrierValid({})).toBe(true); // partial update, ownership absent
  });

  it("driver: subcontracted requires carrierId, owned forbids it", () => {
    expect(
      createDriverSchema.safeParse({ name: "João", ownershipType: "subcontracted" }).success,
    ).toBe(false);
    expect(
      createDriverSchema.safeParse({
        name: "João",
        ownershipType: "subcontracted",
        carrierId: UUID_A,
      }).success,
    ).toBe(true);
    expect(
      createDriverSchema.safeParse({ name: "João", ownershipType: "owned", carrierId: UUID_A })
        .success,
    ).toBe(false);
    expect(createDriverSchema.safeParse({ name: "João", ownershipType: "owned" }).success).toBe(
      true,
    );
  });

  it("driver: CPF normalizes punctuation to 11 digits; wrong length rejected; blank clears (issue #28)", () => {
    const punctuated = createDriverSchema.safeParse({
      name: "João",
      ownershipType: "owned",
      cpf: "390.533.447-05",
    });
    expect(punctuated.success).toBe(true);
    if (punctuated.success) expect(punctuated.data.cpf).toBe("39053344705");

    expect(
      createDriverSchema.safeParse({ name: "João", ownershipType: "owned", cpf: "12345" }).success,
    ).toBe(false);

    // Regression (Codex review, 2026-07-28): stray letters/symbols around an otherwise-valid CPF
    // must FAIL — only supported separators (dot/hyphen/space) are stripped, never \D wholesale.
    expect(
      createDriverSchema.safeParse({
        name: "João",
        ownershipType: "owned",
        cpf: "abc390.533.447-05xyz",
      }).success,
    ).toBe(false);

    const cleared = updateDriverSchema.parse({ cpf: "" });
    expect(cleared.cpf).toBeNull();
    const absent = updateDriverSchema.parse({ name: "João" });
    expect("cpf" in absent).toBe(false);

    // The e-mail field left the driver surface: an unknown key is stripped, never validated.
    const withEmail = createDriverSchema.safeParse({
      name: "João",
      ownershipType: "owned",
      email: "x@y.com",
    });
    expect(withEmail.success).toBe(true);
    if (withEmail.success) expect("email" in withEmail.data).toBe(false);
  });

  it("vehicle: Renavam strips punctuation (9–11 digits); chassi normalizes to VIN-17; ANTT free text (issue #30)", () => {
    const ok = createVehicleSchema.safeParse({
      plate: "ABC1D23",
      vehicleType: "truck",
      ownershipType: "owned",
      renavam: "1234.567.890-1",
      chassis: "9bwzzz377 vt-004251",
      anttNumber: "12345678",
    });
    expect(ok.success).toBe(true);
    if (ok.success) {
      expect(ok.data.renavam).toBe("12345678901");
      expect(ok.data.chassis).toBe("9BWZZZ377VT004251");
      expect(ok.data.anttNumber).toBe("12345678");
    }

    const base = { plate: "ABC1D23", vehicleType: "truck", ownershipType: "owned" };
    // Renavam: legacy 9 digits pass; 8 digits fail.
    expect(createVehicleSchema.safeParse({ ...base, renavam: "123456789" }).success).toBe(true);
    expect(createVehicleSchema.safeParse({ ...base, renavam: "12345678" }).success).toBe(false);
    // Regression: stray letters/symbols must FAIL, never be silently stripped into a valid value.
    expect(
      createVehicleSchema.safeParse({ ...base, renavam: "abc1234.567.890-1xyz" }).success,
    ).toBe(false);
    // Upper bound (AC3): 12 digits fail with the pt-BR message.
    const tooLong = createVehicleSchema.safeParse({ ...base, renavam: "123456789012" });
    expect(tooLong.success).toBe(false);
    if (!tooLong.success) {
      expect(tooLong.error.issues[0]?.message).toBe("Renavam deve ter de 9 a 11 dígitos.");
    }
    // ANTT: free text capped at 20 chars (FR-002).
    expect(createVehicleSchema.safeParse({ ...base, anttNumber: "a".repeat(20) }).success).toBe(
      true,
    );
    expect(createVehicleSchema.safeParse({ ...base, anttNumber: "a".repeat(21) }).success).toBe(
      false,
    );
    // Chassi: wrong length and the excluded letters I/O/Q fail.
    expect(createVehicleSchema.safeParse({ ...base, chassis: "9BWZZZ377VT00425" }).success).toBe(
      false,
    );
    expect(
      createVehicleSchema.safeParse({ ...base, chassis: "IBWZZZ377VT004251" }).success,
    ).toBe(false);

    // Blank clears; absent stays omitted (the blankable update contract).
    const cleared = updateVehicleSchema.parse({ renavam: "", chassis: "", anttNumber: "" });
    expect(cleared.renavam).toBeNull();
    expect(cleared.chassis).toBeNull();
    expect(cleared.anttNumber).toBeNull();
    const absent = updateVehicleSchema.parse({ capacityKg: 1000 });
    expect("renavam" in absent).toBe(false);
  });

  it("vehicle: plate + vehicleType + ownershipType required; status enum enforced", () => {
    expect(
      createVehicleSchema.safeParse({
        plate: "ABC1D23",
        vehicleType: "truck",
        ownershipType: "owned",
      }).success,
    ).toBe(true);
    expect(
      createVehicleSchema.safeParse({
        plate: "ABC1D23",
        vehicleType: "truck",
        ownershipType: "owned",
        status: "broken",
      }).success,
    ).toBe(false);
  });

  it("trailer: trailerType required and validated", () => {
    expect(
      createTrailerSchema.safeParse({
        plate: "ABC1234",
        trailerType: "sider",
        ownershipType: "owned",
      }).success,
    ).toBe(true);
    expect(
      createTrailerSchema.safeParse({
        plate: "ABC1234",
        trailerType: "spaceship",
        ownershipType: "owned",
      }).success,
    ).toBe(false);
  });
});

describe("update schemas — clear vs absent (P2/P1 fixes)", () => {
  it("a blank optional field CLEARS (→ null); an absent field is omitted (unchanged)", () => {
    const cleared = updateCustomerSchema.parse({
      legalName: "",
      taxId: null,
      billingContact: { name: "", email: "", phone: "" },
    });
    expect(cleared.legalName).toBeNull();
    expect(cleared.taxId).toBeNull();
    expect(cleared.billingContact).toBeNull();

    const absent = updateCustomerSchema.parse({ name: "Novo Nome" });
    expect("legalName" in absent).toBe(false);
    expect("taxId" in absent).toBe(false);
  });

  it("switching a resource to owned with a blank carrier nulls the carrier (valid)", () => {
    const res = updateDriverSchema.safeParse({ ownershipType: "owned", carrierId: "" });
    expect(res.success).toBe(true);
    if (res.success) expect(res.data.carrierId).toBeNull();
  });
});

describe("carrier schema (US4)", () => {
  it("requires name; validates contract/documentation status sets", () => {
    expect(createCarrierSchema.safeParse({ name: "Transportes X" }).success).toBe(true);
    expect(
      createCarrierSchema.safeParse({ name: "X", contractStatus: "active" }).success,
    ).toBe(true);
    expect(
      createCarrierSchema.safeParse({ name: "X", contractStatus: "frozen" }).success,
    ).toBe(false);
    expect(
      createCarrierSchema.safeParse({ name: "X", documentationStatus: "complete" }).success,
    ).toBe(true);
  });
});
