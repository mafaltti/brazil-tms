"use client";

import { useState } from "react";
import { Controller, useFieldArray, useForm, type Resolver } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import { useTranslations } from "next-intl";
import { z } from "zod";
import {
  MAPPED_DATE_FIELDS,
  MAPPED_JSON_FIELDS,
  MAPPED_NUMBER_FIELDS,
  MAPPED_STRING_FIELDS,
  templateConfigSchema,
  type TemplateConfig,
} from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { EntityFormShell, Field } from "@/components/master-data/entity-form";
import {
  deriveRequiredOverrides,
  findDuplicateTargets,
  hasDateTargetWithoutFormat,
} from "@/lib/imports/import-templates-client";

/** Marker message tokens emitted by `.superRefine` so the renderer maps them to pt-BR (the base zod
 *  min(1) messages are English; we re-label them). */
const CONFLICT_TOKEN = "conflictingMapping";

/**
 * The form schema is the SHARED `templateConfigSchema` (one validation boundary — the route re-validates
 * the same shape) extended with the UI-only BLOCKING rule the backend does not enforce: no `target` may
 * be mapped by more than one row. The non-blocking date-format warning (FR-015) is NOT here — it must
 * allow save — and is handled in the submit handler instead.
 */
const formSchema = templateConfigSchema.superRefine((value, ctx) => {
  const duplicates = findDuplicateTargets(value.columnMappings);
  if (duplicates.size === 0) return;
  value.columnMappings.forEach((mapping, index) => {
    if (mapping.target && duplicates.has(mapping.target)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["columnMappings", index, "target"],
        message: CONFLICT_TOKEN,
      });
    }
  });
});

const TARGET_GROUPS = [
  { key: "text", fields: MAPPED_STRING_FIELDS },
  { key: "dateTime", fields: MAPPED_DATE_FIELDS },
  { key: "number", fields: MAPPED_NUMBER_FIELDS },
  { key: "structured", fields: MAPPED_JSON_FIELDS },
] as const;

export interface ImportTemplateFormProps {
  /** Seeds create (customerId only), edit (full config), or "criar nova versão" (full config, bumped
   *  version). `customerId` MUST be present. */
  defaultValues: Partial<TemplateConfig> & { customerId: string };
  submitting: boolean;
  /** Already-localized top-level error (e.g. the DUPLICATE_TEMPLATE → pt-BR message). */
  errorMessage?: string | null;
  submitLabel?: string;
  onSubmit: (values: TemplateConfig) => void;
  onCancel: () => void;
}

/**
 * Create / edit / new-version form for an import template (slice 012, US1/US2). Reuses
 * `EntityFormShell`/`Field` and the shared schema; the target picker is a grouped single-select derived
 * from the shared `MAPPED_*_FIELDS` (single source of truth — a future field appears with no UI change).
 */
export function ImportTemplateForm({
  defaultValues,
  submitting,
  errorMessage,
  submitLabel,
  onSubmit,
  onCancel,
}: ImportTemplateFormProps) {
  const t = useTranslations("ImportTemplates");
  // Once the date-format warning has been surfaced on submit, a second Salvar proceeds (warn-and-allow).
  const [dateWarningAck, setDateWarningAck] = useState(false);

  // The "Obrigatório" checkbox reflects the engine-enforced `requiredOverrides` set (the worker reads
  // only that, not `columnMappings[].required`). On load, a row is checked if it was flagged required
  // OR its target is in requiredOverrides; on submit we project the checks back into requiredOverrides.
  const requiredSet = new Set(defaultValues.requiredOverrides ?? []);
  const initialMappings =
    defaultValues.columnMappings && defaultValues.columnMappings.length > 0
      ? defaultValues.columnMappings.map((m) => ({
          ...m,
          required: Boolean(m.required) || (m.target ? requiredSet.has(m.target) : false),
        }))
      : [{ source: "", target: "", required: false }];

  const {
    register,
    control,
    handleSubmit,
    watch,
    formState: { errors },
  } = useForm<TemplateConfig>({
    resolver: zodResolver(formSchema) as Resolver<TemplateConfig>,
    defaultValues: {
      customerId: defaultValues.customerId,
      name: defaultValues.name ?? "",
      version: defaultValues.version ?? 1,
      fileType: defaultValues.fileType ?? "csv",
      columnMappings: initialMappings,
      parsingRules: defaultValues.parsingRules ?? {
        dateFormats: [],
        timezone: "America/Sao_Paulo",
        decimalSeparator: ",",
        thousandSeparator: ".",
      },
      requiredOverrides: defaultValues.requiredOverrides ?? [],
    },
  });

  const mappings = useFieldArray({ control, name: "columnMappings" });

  const watched = watch();
  const showDateWarning = dateWarningAck && hasDateTargetWithoutFormat(watched);

  function mappingError(index: number): string | undefined {
    const rowErrors = errors.columnMappings?.[index];
    if (rowErrors?.target?.message === CONFLICT_TOKEN) return t("validation.conflictingMapping");
    if (rowErrors?.source || rowErrors?.target) return t("validation.incompleteMapping");
    return undefined;
  }

  function onValid(values: TemplateConfig) {
    // Project the per-row "Obrigatório" checks into requiredOverrides — the only required-field set the
    // import worker enforces (it ignores columnMappings[].required). Without this the checkbox is inert.
    const merged: TemplateConfig = {
      ...values,
      requiredOverrides: deriveRequiredOverrides(values.columnMappings),
    };
    // FR-015: non-blocking date-format warning — surface once on submit, then allow proceeding.
    if (hasDateTargetWithoutFormat(merged) && !dateWarningAck) {
      setDateWarningAck(true);
      return;
    }
    onSubmit(merged);
  }

  return (
    <EntityFormShell
      submitting={submitting}
      errorMessage={errorMessage}
      submitLabel={submitLabel}
      onCancel={onCancel}
      onSubmit={handleSubmit(onValid)}
    >
      <input type="hidden" {...register("customerId")} />

      <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
        <Field label={t("formName")} htmlFor="tpl-name" required error={errors.name?.message}>
          <Input id="tpl-name" {...register("name")} />
        </Field>
        <Field label={t("formVersion")} htmlFor="tpl-version" required error={errors.version?.message}>
          <Input id="tpl-version" type="number" min={1} {...register("version", { valueAsNumber: true })} />
        </Field>
        <Field label={t("formFileType")} htmlFor="tpl-file-type" required error={errors.fileType?.message}>
          <Controller
            control={control}
            name="fileType"
            render={({ field }) => (
              <Select value={field.value} onValueChange={field.onChange}>
                <SelectTrigger id="tpl-file-type">
                  <SelectValue placeholder={t("selectFileType")} />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="csv">{t("fileTypeCsv")}</SelectItem>
                  <SelectItem value="xlsx">{t("fileTypeXlsx")}</SelectItem>
                </SelectContent>
              </Select>
            )}
          />
        </Field>
      </div>

      {/* Column mappings */}
      <div className="space-y-3 rounded-md border p-3">
        <div className="flex items-center justify-between">
          <span className="text-sm font-medium">{t("columnMappings")}</span>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => mappings.append({ source: "", target: "", required: false })}
          >
            {t("addMapping")}
          </Button>
        </div>

        {mappings.fields.length === 0 ? (
          <p className="text-sm text-destructive">{t("validation.atLeastOneMapping")}</p>
        ) : null}

        {mappings.fields.map((field, index) => {
          const rowError = mappingError(index);
          return (
            <div key={field.id} className="space-y-2 rounded-md border bg-muted/30 p-2">
              <div className="grid grid-cols-1 gap-2 sm:grid-cols-[1fr_1fr_auto_auto] sm:items-center">
                <Input
                  placeholder={t("sourceColumnPlaceholder")}
                  aria-label={`${t("sourceColumn")} ${index + 1}`}
                  {...register(`columnMappings.${index}.source` as const)}
                />
                <Controller
                  control={control}
                  name={`columnMappings.${index}.target` as const}
                  render={({ field: targetField }) => (
                    <Select value={targetField.value ?? ""} onValueChange={targetField.onChange}>
                      <SelectTrigger aria-label={`${t("targetField")} ${index + 1}`}>
                        <SelectValue placeholder={t("selectTarget")} />
                      </SelectTrigger>
                      <SelectContent>
                        {TARGET_GROUPS.map((group) => (
                          <SelectGroup key={group.key}>
                            <SelectLabel>{t(`fieldGroups.${group.key}`)}</SelectLabel>
                            {group.fields.map((name) => (
                              <SelectItem key={name} value={name}>
                                {name}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        ))}
                      </SelectContent>
                    </Select>
                  )}
                />
                <label className="flex items-center gap-2 text-sm">
                  <input
                    type="checkbox"
                    className="h-4 w-4"
                    {...register(`columnMappings.${index}.required` as const)}
                  />
                  {t("requiredFlag")}
                </label>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => mappings.remove(index)}
                >
                  {t("removeMapping")}
                </Button>
              </div>
              {rowError ? <p className="text-sm text-destructive">{rowError}</p> : null}
            </div>
          );
        })}
      </div>

      {/* Parsing rules */}
      <div className="space-y-3 rounded-md border p-3">
        <span className="text-sm font-medium">{t("parsingRules")}</span>

        <Controller
          control={control}
          name="parsingRules.dateFormats"
          render={({ field }) => (
            <DateFormatsField
              value={field.value ?? []}
              onChange={field.onChange}
              labels={{
                title: t("dateFormats"),
                add: t("addDateFormat"),
                remove: t("removeDateFormat"),
                placeholder: t("dateFormatPlaceholder"),
              }}
            />
          )}
        />

        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <Field label={t("timezone")} htmlFor="tpl-tz">
            <Input id="tpl-tz" {...register("parsingRules.timezone")} />
          </Field>
          <Field label={t("decimalSeparator")} htmlFor="tpl-dec">
            <Input id="tpl-dec" {...register("parsingRules.decimalSeparator")} />
          </Field>
          <Field label={t("thousandSeparator")} htmlFor="tpl-thou">
            <Input id="tpl-thou" {...register("parsingRules.thousandSeparator")} />
          </Field>
        </div>
      </div>

      {showDateWarning ? (
        <p role="alert" className="rounded-md border border-amber-300 bg-amber-50 p-2 text-sm text-amber-800">
          {t("validation.missingDateFormat")}
        </p>
      ) : null}
    </EntityFormShell>
  );
}

/** Dynamic ordered list of date-format strings (string[], so no useFieldArray) — FR-004. */
function DateFormatsField({
  value,
  onChange,
  labels,
}: {
  value: string[];
  onChange: (next: string[]) => void;
  labels: { title: string; add: string; remove: string; placeholder: string };
}) {
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm">{labels.title}</span>
        <Button type="button" size="sm" variant="outline" onClick={() => onChange([...value, ""])}>
          {labels.add}
        </Button>
      </div>
      {value.map((format, index) => (
        <div key={index} className="flex items-center gap-2">
          <Input
            value={format}
            placeholder={labels.placeholder}
            aria-label={`${labels.title} ${index + 1}`}
            onChange={(e) => {
              const next = [...value];
              next[index] = e.target.value;
              onChange(next);
            }}
          />
          <Button
            type="button"
            size="sm"
            variant="ghost"
            onClick={() => onChange(value.filter((_, i) => i !== index))}
          >
            {labels.remove}
          </Button>
        </div>
      ))}
    </div>
  );
}
