import { describe, expect, it, vi } from "vitest";
import * as auditModule from "./write-audit";
import { writeAudit } from "./write-audit";

function makeFakeTx() {
  const values = vi.fn().mockResolvedValue(undefined);
  const insert = vi.fn(() => ({ values }));
  return {
    tx: { insert } as unknown as Parameters<typeof writeAudit>[0],
    insert,
    values,
  };
}

describe("writeAudit", () => {
  it("maps every field into a single audit_logs insert", async () => {
    const { tx, insert, values } = makeFakeTx();
    await writeAudit(tx, {
      entityType: "user",
      entityId: "u1",
      action: "user.role_change",
      previousValue: { role: "dispatcher" },
      newValue: { role: "finance" },
      actorUserId: "admin1",
      reason: "promoção",
    });
    expect(insert).toHaveBeenCalledOnce();
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({
        entityType: "user",
        entityId: "u1",
        action: "user.role_change",
        previousValue: { role: "dispatcher" },
        newValue: { role: "finance" },
        actorUserId: "admin1",
        reason: "promoção",
      }),
    );
  });

  it("defaults reason to null when omitted", async () => {
    const { tx, values } = makeFakeTx();
    await writeAudit(tx, {
      entityType: "user",
      entityId: "u2",
      action: "user.create",
      previousValue: null,
      newValue: { email: "x@y.com" },
      actorUserId: "admin1",
    });
    expect(values).toHaveBeenCalledWith(expect.objectContaining({ reason: null }));
  });

  it("is append-only: the module exports only writeAudit (no update/delete helper)", () => {
    expect(Object.keys(auditModule)).toEqual(["writeAudit"]);
  });
});
