/**
 * Map a filename extension to the supported import file type, or null when unsupported.
 *
 * The ONE canonical "extension → file type" rule, shared by the BFF upload route
 * (`apps/web/app/api/imports/route.ts`, upload validation) and the parse worker
 * (`workers/jobs/parse/index.ts`, parser choice). Keeping a single rule prevents a file being
 * accepted at upload but parsed with the wrong reader (DRY-for-correctness; precedent: 009 `onTimeExpr`).
 */
export function inferFileType(fileName: string): "csv" | "xlsx" | null {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".csv")) return "csv";
  if (lower.endsWith(".xlsx")) return "xlsx";
  return null;
}
