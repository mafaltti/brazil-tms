import "server-only";
import { and, desc, eq, isNull } from "drizzle-orm";
import { db, importTemplates } from "@brazil-tms/db";
import { templateConfigSchema, type TemplateConfig } from "@brazil-tms/shared";
import type { ColumnMapping, ParsingRules } from "@brazil-tms/shared";
import { writeAudit } from "@/lib/audit/write-audit";
import { Conflict } from "@/lib/api/respond";

/** API response shape for an import template (contract: bff-endpoints.md §import-templates; timestamps ISO). */
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

interface ImportTemplateRow {
  id: string;
  customerId: string;
  name: string;
  version: number;
  fileType: string;
  columnMappings: unknown;
  parsingRules: unknown;
  requiredOverrides: unknown;
  active: boolean;
  archivedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function toDto(row: ImportTemplateRow): ImportTemplateDto {
  return {
    id: row.id,
    customerId: row.customerId,
    name: row.name,
    version: row.version,
    fileType: row.fileType as "csv" | "xlsx",
    columnMappings: (row.columnMappings as ColumnMapping[] | null) ?? [],
    parsingRules: (row.parsingRules as ParsingRules | null) ?? ({} as ParsingRules),
    requiredOverrides: (row.requiredOverrides as string[] | null) ?? [],
    active: row.active,
    archived: row.archivedAt !== null,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Postgres unique-violation SQLSTATE (duplicate natural key → 409). */
const PG_UNIQUE_VIOLATION = "23505";
/**
 * Detect a Postgres unique-violation. Drizzle wraps the driver error in a `DrizzleQueryError`
 * and carries the original `pg` error (with `code: '23505'`) on `.cause`, so we walk the cause
 * chain rather than only inspecting the top-level error.
 */
function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current; depth++) {
    if (
      typeof current === "object" &&
      current !== null &&
      "code" in current &&
      (current as { code?: unknown }).code === PG_UNIQUE_VIOLATION
    ) {
      return true;
    }
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { cause?: unknown }).cause
        : undefined;
  }
  return false;
}

const DUPLICATE = new Conflict(
  "DUPLICATE_TEMPLATE",
  "Já existe um modelo com esse nome e versão.",
);

export interface ListTemplatesOptions {
  customerId?: string;
  includeArchived?: boolean;
}

export async function listTemplates(
  opts: ListTemplatesOptions = {},
): Promise<ImportTemplateDto[]> {
  const filters = [];
  if (opts.customerId) filters.push(eq(importTemplates.customerId, opts.customerId));
  if (!opts.includeArchived) filters.push(isNull(importTemplates.archivedAt));
  const rows = await db
    .select()
    .from(importTemplates)
    .where(filters.length > 0 ? and(...filters) : undefined)
    .orderBy(desc(importTemplates.createdAt));
  return rows.map(toDto);
}

export async function getTemplate(id: string): Promise<ImportTemplateDto> {
  const rows = await db
    .select()
    .from(importTemplates)
    .where(eq(importTemplates.id, id))
    .limit(1);
  const row = rows[0];
  if (!row) throw new Conflict("NOT_FOUND", "Modelo de importação não encontrado.");
  return toDto(row);
}

export async function createTemplate(
  input: TemplateConfig,
  actorUserId: string,
): Promise<ImportTemplateDto> {
  // Re-validate defensively even though the route already parsed it (single validation boundary).
  const parsed = templateConfigSchema.parse(input);
  try {
    return await db.transaction(async (tx) => {
      const inserted = await tx
        .insert(importTemplates)
        .values({
          customerId: parsed.customerId,
          name: parsed.name,
          version: parsed.version,
          fileType: parsed.fileType,
          columnMappings: parsed.columnMappings,
          parsingRules: parsed.parsingRules,
          requiredOverrides: parsed.requiredOverrides,
        })
        .returning();
      const row = inserted[0];
      if (!row) throw new Error("Inserção de modelo de importação não retornou linha.");
      await writeAudit(tx, {
        entityType: "import_template",
        entityId: row.id,
        action: "import_template.create",
        previousValue: null,
        newValue: { customerId: parsed.customerId, name: parsed.name, version: parsed.version },
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}

export type UpdateTemplateInput = Partial<TemplateConfig> & {
  active?: boolean;
  archive?: boolean;
};

export async function updateTemplate(
  id: string,
  input: UpdateTemplateInput,
  actorUserId: string,
): Promise<ImportTemplateDto> {
  const currentRows = await db
    .select()
    .from(importTemplates)
    .where(eq(importTemplates.id, id))
    .limit(1);
  const current = currentRows[0];
  if (!current) throw new Conflict("NOT_FOUND", "Modelo de importação não encontrado.");

  // Build the partial update + before/after snapshots from only the provided config fields.
  const set: Record<string, unknown> = { updatedAt: new Date() };
  const previousValue: Record<string, unknown> = {};
  const newValue: Record<string, unknown> = {};
  const fields: (keyof TemplateConfig)[] = [
    "customerId",
    "name",
    "version",
    "fileType",
    "columnMappings",
    "parsingRules",
    "requiredOverrides",
  ];
  for (const field of fields) {
    if (input[field] === undefined) continue;
    set[field] = input[field];
    previousValue[field] = (current as Record<string, unknown>)[field] ?? null;
    newValue[field] = input[field];
  }
  if (input.active !== undefined) {
    set.active = input.active;
    previousValue.active = current.active;
    newValue.active = input.active;
  }
  if (input.archive === true) {
    const now = new Date();
    set.archivedAt = now;
    previousValue.archivedAt = current.archivedAt ? current.archivedAt.toISOString() : null;
    newValue.archivedAt = now.toISOString();
  }

  try {
    return await db.transaction(async (tx) => {
      const updated = await tx
        .update(importTemplates)
        .set(set)
        .where(eq(importTemplates.id, id))
        .returning();
      const row = updated[0];
      if (!row) throw new Conflict("NOT_FOUND", "Modelo de importação não encontrado.");
      await writeAudit(tx, {
        entityType: "import_template",
        entityId: id,
        action: "import_template.update",
        previousValue,
        newValue,
        actorUserId,
      });
      return toDto(row);
    });
  } catch (error) {
    if (isUniqueViolation(error)) throw DUPLICATE;
    throw error;
  }
}
