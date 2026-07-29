import { describe, expect, it } from "vitest";
import { normalizeForSearch } from "./search-normalize";

/** Pure unit tests for the 018 picker-search normalization (spec FR-002). */
describe("normalizeForSearch — text mode (names)", () => {
  it("strips diacritics and lowercases", () => {
    expect(normalizeForSearch("JOÃO da Silva Ções")).toBe("joao da silva coes");
  });

  it("trims and collapses internal whitespace (paste decoration)", () => {
    expect(normalizeForSearch("  João   da\tSilva  ")).toBe("joao da silva");
  });

  it("keeps hyphens in text mode (names may contain them)", () => {
    expect(normalizeForSearch("Maria Sousa-Leão")).toBe("maria sousa-leao");
  });

  it("normalized paste equals normalized label (US1 exact-match premise)", () => {
    expect(normalizeForSearch("joao da silva souza")).toBe(
      normalizeForSearch("João da Silva Souza"),
    );
  });
});

describe("normalizeForSearch — plate mode", () => {
  it("ignores case, hyphens, and spaces", () => {
    for (const raw of ["ABC-1234", "abc 1234", "abc1234", " AbC-12 34 "]) {
      expect(normalizeForSearch(raw, "plate")).toBe("abc1234");
    }
  });

  it("distinguishes plates that differ by one character (SC-002)", () => {
    expect(normalizeForSearch("RTA1B23", "plate")).not.toBe(
      normalizeForSearch("RTA1B24", "plate"),
    );
  });
});
