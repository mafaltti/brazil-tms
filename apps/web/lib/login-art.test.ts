import { describe, expect, it } from "vitest";
import { DEFAULT_LOGIN_ART, loginArtFor } from "./login-art";

/** Pure unit tests for the TMS-115 seasonal login art. */
describe("loginArtFor", () => {
  it("uses the default truck photo outside campaign months", () => {
    expect(loginArtFor(new Date("2026-09-29T12:00:00Z"))).toBe(DEFAULT_LOGIN_ART);
    expect(loginArtFor(new Date("2026-11-15T12:00:00Z"))).toBe(DEFAULT_LOGIN_ART);
  });

  it("uses the Outubro Rosa art during October", () => {
    expect(loginArtFor(new Date("2026-10-01T12:00:00Z")).id).toBe("outubro-rosa");
    expect(loginArtFor(new Date("2026-10-31T12:00:00Z")).id).toBe("outubro-rosa");
  });

  it("switches at midnight in America/Sao_Paulo, not UTC", () => {
    // 01/10 03:30 UTC is 01/10 00:30 in São Paulo.
    expect(loginArtFor(new Date("2026-10-01T03:30:00Z")).id).toBe("outubro-rosa");
    // 01/10 01:00 UTC is still 30/09 22:00 in São Paulo.
    expect(loginArtFor(new Date("2026-10-01T01:00:00Z"))).toBe(DEFAULT_LOGIN_ART);
    // 01/11 01:00 UTC is still 31/10 22:00 in São Paulo.
    expect(loginArtFor(new Date("2026-11-01T01:00:00Z")).id).toBe("outubro-rosa");
    expect(loginArtFor(new Date("2026-11-01T03:30:00Z"))).toBe(DEFAULT_LOGIN_ART);
  });

  it("honors a known preview id and ignores unknown ones", () => {
    const september = new Date("2026-09-29T12:00:00Z");
    expect(loginArtFor(september, "outubro-rosa").id).toBe("outubro-rosa");
    expect(loginArtFor(new Date("2026-10-10T12:00:00Z"), "padrao")).toBe(DEFAULT_LOGIN_ART);
    expect(loginArtFor(september, "natal")).toBe(DEFAULT_LOGIN_ART);
  });
});
