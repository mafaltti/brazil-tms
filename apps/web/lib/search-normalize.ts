/**
 * Search-text normalization for the searchable resource pickers (018, issue #25; spec FR-002).
 * Pure and client-safe — used by `SearchableSelect` to compare user input against option labels.
 *
 * - `"text"` (names): strip diacritics (NFD), lowercase, trim, collapse internal whitespace — so a
 *   pasted "  JOÃO  da Silva " matches "João da Silva".
 * - `"plate"` (vehicle/trailer plates): the above PLUS strip hyphens/spaces entirely — so
 *   "abc-1234", "ABC 1234" and "abc1234" all normalize to "abc1234".
 */
export type SearchMode = "text" | "plate";

export function normalizeForSearch(text: string, mode: SearchMode = "text"): string {
  const base = text
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "") // combining diacritical marks
    .toLowerCase()
    .trim()
    .replace(/\s+/g, " ");
  return mode === "plate" ? base.replace(/[-\s]/g, "") : base;
}
