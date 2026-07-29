import { describe, expect, it } from "vitest";
import {
  createUserSchema,
  updateUserRoleSchema,
  updateUserStatusSchema,
} from "./admin-user";

describe("createUserSchema", () => {
  it("accepts a valid invite-path user", () => {
    const result = createUserSchema.safeParse({
      name: "Maria Silva",
      email: "maria@example.com",
      role: "dispatcher",
      onboarding: { method: "invite" },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid temp-password user", () => {
    const result = createUserSchema.safeParse({
      name: "João Souza",
      email: "joao@example.com",
      role: "finance",
      onboarding: { method: "temp_password", tempPassword: "tempPass123" },
    });
    expect(result.success).toBe(true);
  });

  it("rejects the reserved customer_viewer role (FR-007)", () => {
    const result = createUserSchema.safeParse({
      name: "Cliente Teste",
      email: "cliente@example.com",
      role: "customer_viewer",
      onboarding: { method: "invite" },
    });
    expect(result.success).toBe(false);
  });

  it("requires tempPassword (>=8) on the temp-password path", () => {
    const short = createUserSchema.safeParse({
      name: "Curto Pwd",
      email: "curto@example.com",
      role: "dispatcher",
      onboarding: { method: "temp_password", tempPassword: "123" },
    });
    expect(short.success).toBe(false);

    const missing = createUserSchema.safeParse({
      name: "Sem Pwd",
      email: "sempwd@example.com",
      role: "dispatcher",
      onboarding: { method: "temp_password" },
    });
    expect(missing.success).toBe(false);
  });

  it("rejects missing required fields", () => {
    expect(createUserSchema.safeParse({}).success).toBe(false);
    expect(
      createUserSchema.safeParse({
        name: "A", // too short
        email: "not-an-email",
        role: "dispatcher",
        onboarding: { method: "invite" },
      }).success,
    ).toBe(false);
  });
});

describe("updateUserRoleSchema", () => {
  it("accepts an assignable role", () => {
    expect(updateUserRoleSchema.safeParse({ role: "operations_manager" }).success).toBe(true);
  });
  it("rejects customer_viewer", () => {
    expect(updateUserRoleSchema.safeParse({ role: "customer_viewer" }).success).toBe(false);
  });
});

describe("updateUserStatusSchema", () => {
  it("accepts active/disabled with optional reason", () => {
    expect(updateUserStatusSchema.safeParse({ status: "disabled", reason: "saiu" }).success).toBe(
      true,
    );
    expect(updateUserStatusSchema.safeParse({ status: "active" }).success).toBe(true);
  });
  it("rejects setting pending directly", () => {
    expect(updateUserStatusSchema.safeParse({ status: "pending" }).success).toBe(false);
  });
});
