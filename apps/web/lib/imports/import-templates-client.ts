"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import {
  MAPPED_DATE_FIELDS,
  type ColumnMapping,
  type ParsingRules,
  type TemplateConfig,
} from "@brazil-tms/shared";

/**
 * Data-access + pure helpers for the Import Templates admin screen (slice 012). This screen consumes
 * the EXISTING, frozen import-template endpoints (`/api/import-templates(/:id)`, gated by `import_trips`)
 * shipped in feature 004 — there is no new backend. We do NOT reuse `lib/master-data/client.ts` because
 * it hardcodes `/api/master-data/${entity}` and cannot address `/api/import-templates`.
 *
 * Freshness is TanStack Query polling with the ~30s staleTime convention; mutations invalidate the
 * `['import-templates', ...]` keys (the Trip Import selector shares that prefix). NO Realtime
 * (Constitution). The browser never talks to Postgres; everything goes through the BFF.
 */

/** ~30s — interactive admin CRUD; per-customer template counts are small (plan: Performance Goals). */
export const IMPORT_TEMPLATES_STALE_TIME = 30_000;

const BASE_PATH = "/api/import-templates";

/** API response shape (matches `ImportTemplateDto` from the frozen service; timestamps are ISO). */
export interface ImportTemplateDto {
  id: string;
  customerId: string;
  name: string;
  version: number;
  fileType: "csv" | "xlsx";
  columnMappings: ColumnMapping[];
  parsingRules: ParsingRules;
  requiredOverrides: string[];
  active: boolean;
  archived: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
}

/** A thrown error carrying the API error code (read from `body.error.code`) so mutation onError can
 *  map it to a pt-BR message (e.g. `DUPLICATE_TEMPLATE`). */
export class ImportTemplateError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "ImportTemplateError";
  }
}

/** Read a `{ error: { code, message, issues? } }` body; null if absent/unparseable. */
async function readApiError(res: Response): Promise<ApiErrorBody | null> {
  try {
    const body = (await res.json()) as { error?: ApiErrorBody };
    return body.error ?? null;
  } catch {
    return null;
  }
}

async function asItem(res: Response): Promise<ImportTemplateDto> {
  if (!res.ok) {
    const err = await readApiError(res);
    throw new ImportTemplateError(err?.code ?? "REQUEST_FAILED");
  }
  const body = (await res.json()) as { item: ImportTemplateDto };
  return body.item;
}

// --- Fetchers (usable from hooks or mutations) --------------------------------------------------

export interface ListTemplatesParams {
  customerId: string;
  includeArchived?: boolean;
}

export async function fetchTemplates(params: ListTemplatesParams): Promise<ImportTemplateDto[]> {
  const search = new URLSearchParams({ customerId: params.customerId });
  if (params.includeArchived) search.set("includeArchived", "true");
  const res = await fetch(`${BASE_PATH}?${search.toString()}`);
  if (!res.ok) {
    const err = await readApiError(res);
    throw new ImportTemplateError(err?.code ?? "REQUEST_FAILED");
  }
  const body = (await res.json()) as { items: ImportTemplateDto[] };
  return body.items;
}

export async function createTemplate(input: TemplateConfig): Promise<ImportTemplateDto> {
  return asItem(
    await fetch(BASE_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

export type UpdateTemplateInput = Partial<TemplateConfig> & {
  active?: boolean;
  archive?: boolean;
};

export async function updateTemplate(
  id: string,
  input: UpdateTemplateInput,
): Promise<ImportTemplateDto> {
  return asItem(
    await fetch(`${BASE_PATH}/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(input),
    }),
  );
}

// --- Query key + hook ---------------------------------------------------------------------------

/** Key shares the `['import-templates', ...]` prefix with the Trip Import selector, so a prefix
 *  invalidation (`['import-templates']`) refreshes both this list and the selector. */
export function templatesKey(customerId: string, includeArchived: boolean): unknown[] {
  return ["import-templates", customerId, { includeArchived }];
}

export function useImportTemplates(
  customerId: string,
  includeArchived: boolean,
): UseQueryResult<ImportTemplateDto[]> {
  return useQuery({
    queryKey: templatesKey(customerId, includeArchived),
    queryFn: () => fetchTemplates({ customerId, includeArchived }),
    enabled: Boolean(customerId),
    staleTime: IMPORT_TEMPLATES_STALE_TIME,
  });
}

// --- Pure helpers (UI-only validation rules; unit-tested under lib/**) ---------------------------

/**
 * UI-only blocking rule (FR-002): the set of `target` values mapped by more than one row. The form
 * flags every row whose target is in this set (so the N>2 case — ≥3 rows sharing a target — flags all
 * of them). Empty targets are ignored here; an empty `source`/`target` is the SEPARATE base-schema
 * "incomplete mapping" error.
 */
export function findDuplicateTargets(mappings: { target?: string }[]): Set<string> {
  const counts = new Map<string, number>();
  for (const mapping of mappings) {
    const target = mapping.target?.trim();
    if (!target) continue;
    counts.set(target, (counts.get(target) ?? 0) + 1);
  }
  const duplicates = new Set<string>();
  for (const [target, count] of counts) {
    if (count > 1) duplicates.add(target);
  }
  return duplicates;
}

/** Suggested next version for a template name within the (already customer-scoped) list: the highest
 *  existing version for that name + 1, or 1 if the name is new (FR-007). */
export function nextVersion(list: { name: string; version: number }[], name: string): number {
  const versions = list.filter((tpl) => tpl.name === name).map((tpl) => tpl.version);
  return versions.length === 0 ? 1 : Math.max(...versions) + 1;
}

/**
 * Derive the engine-enforced `requiredOverrides` (target field names) from the per-row "Obrigatório"
 * flags. The import worker enforces required-ness ONLY via `requiredOverrides` (it does not read
 * `columnMappings[].required`), so the UI checkbox must be projected into this set on save or it has
 * no effect at import time. Deduplicated; empty/blank targets are skipped.
 */
export function deriveRequiredOverrides(
  mappings: { target?: string; required?: boolean }[],
): string[] {
  const set = new Set<string>();
  for (const mapping of mappings) {
    const target = mapping.target?.trim();
    if (mapping.required && target) set.add(target);
  }
  return [...set];
}

/** Non-blocking warning condition (FR-015): a date-kind target is mapped but no date format is set. */
export function hasDateTargetWithoutFormat(config: {
  columnMappings: { target?: string }[];
  parsingRules?: { dateFormats?: string[] };
}): boolean {
  const dateTargets = new Set<string>(MAPPED_DATE_FIELDS);
  const mapsDateField = config.columnMappings.some(
    (mapping) => mapping.target != null && dateTargets.has(mapping.target),
  );
  const hasFormat = (config.parsingRules?.dateFormats ?? []).some((f) => f.trim().length > 0);
  return mapsDateField && !hasFormat;
}
