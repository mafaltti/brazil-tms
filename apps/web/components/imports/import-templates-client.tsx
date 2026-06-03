"use client";

import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { TemplateConfig } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ImportTemplateForm } from "@/components/imports/import-template-form";
import {
  ImportTemplateError,
  createTemplate,
  nextVersion,
  updateTemplate,
  useImportTemplates,
  type ImportTemplateDto,
  type UpdateTemplateInput,
} from "@/lib/imports/import-templates-client";

interface CustomerOption {
  id: string;
  name: string;
  customerCode: string;
}

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`REQUEST_FAILED:${res.status}`);
  return (await res.json()) as T;
}

/** The form dialog creates a template, edits one in place, or seeds "criar nova versão". */
type FormMode = "create" | "edit" | "version";

/**
 * Import Templates administration (slice 012). Lists a selected customer's templates and creates /
 * edits / versions / activates / archives them via the EXISTING `/api/import-templates` endpoints.
 * Freshness is TanStack Query polling; NO Realtime. Authorization is enforced by the BFF + the
 * server-component guard (`import_trips`); this screen only composes UI.
 */
export function ImportTemplatesClient() {
  const t = useTranslations("ImportTemplates");
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState<string>("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [selected, setSelected] = useState<ImportTemplateDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);

  // Customers — reuse the master-data query key/endpoint so the cache is shared with Trip Import.
  const customersQuery = useQuery({
    queryKey: ["master-data", "customers"],
    queryFn: () =>
      fetchJson<{ items: CustomerOption[] }>("/api/master-data/customers").then((b) => b.items),
    staleTime: 30_000,
  });

  const templatesQuery = useImportTemplates(customerId, includeArchived);
  const rows = templatesQuery.data ?? [];

  // Prefix invalidation refreshes both this list and the Trip Import selector (shared key prefix).
  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["import-templates"] });
  }

  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_TEMPLATE") return t("validation.duplicateKey");
    return t("saveError");
  }

  const createMutation = useMutation({
    mutationFn: (input: TemplateConfig) => createTemplate(input),
    onSuccess: () => {
      closeForm();
      setFeedback(t("created"));
      invalidate();
    },
    onError: (e: Error) =>
      setFormError(mapError(e instanceof ImportTemplateError ? e.code : undefined)),
  });

  const updateMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput }) =>
      updateTemplate(id, input),
    onSuccess: () => {
      closeForm();
      setFeedback(t("updated"));
      invalidate();
    },
    onError: (e: Error) =>
      setFormError(mapError(e instanceof ImportTemplateError ? e.code : undefined)),
  });

  function openCreate() {
    setSelected(null);
    setFormError(null);
    setFeedback(null);
    setFormMode("create");
  }

  function openEdit(tpl: ImportTemplateDto) {
    setSelected(tpl);
    setFormError(null);
    setFeedback(null);
    setFormMode("edit");
  }

  function openVersion(tpl: ImportTemplateDto) {
    setSelected(tpl);
    setFormError(null);
    setFeedback(null);
    setFormMode("version");
  }

  function closeForm() {
    setFormMode(null);
    setSelected(null);
    setFormError(null);
  }

  function formDefaults(): Partial<TemplateConfig> & { customerId: string } {
    if (formMode === "edit" && selected) {
      return {
        customerId,
        name: selected.name,
        version: selected.version,
        fileType: selected.fileType,
        columnMappings: selected.columnMappings,
        parsingRules: selected.parsingRules,
        requiredOverrides: selected.requiredOverrides,
      };
    }
    if (formMode === "version" && selected) {
      return {
        customerId,
        name: selected.name,
        version: nextVersion(rows, selected.name),
        fileType: selected.fileType,
        columnMappings: selected.columnMappings,
        parsingRules: selected.parsingRules,
        requiredOverrides: selected.requiredOverrides,
      };
    }
    return { customerId };
  }

  function handleFormSubmit(values: TemplateConfig) {
    if (formMode === "edit" && selected) {
      updateMutation.mutate({ id: selected.id, input: values });
    } else {
      createMutation.mutate(values); // create or "nova versão"
    }
  }

  const dialogTitle =
    formMode === "edit"
      ? t("editTitle")
      : formMode === "version"
        ? t("newVersionTitle")
        : t("createTitle");
  const submitLabel = formMode === "edit" ? undefined : t("create");
  const submitting = createMutation.isPending || updateMutation.isPending;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button disabled={!customerId} onClick={openCreate}>
          {t("new")}
        </Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="template-customer">{t("customer")}</Label>
          <Select
            value={customerId}
            onValueChange={(value) => {
              setCustomerId(value);
              setFeedback(null);
            }}
            disabled={customersQuery.isLoading}
          >
            <SelectTrigger id="template-customer" className="w-72">
              <SelectValue placeholder={t("selectCustomer")} />
            </SelectTrigger>
            <SelectContent>
              {(customersQuery.data ?? []).map((c) => (
                <SelectItem key={c.id} value={c.id}>
                  {c.name} ({c.customerCode})
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {customersQuery.isError ? (
            <p className="text-sm text-destructive">{t("customersLoadError")}</p>
          ) : null}
          {!customersQuery.isLoading && (customersQuery.data ?? []).length === 0 ? (
            <p className="text-sm text-muted-foreground">{t("noCustomers")}</p>
          ) : null}
        </div>

        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={includeArchived}
            onChange={(e) => setIncludeArchived(e.target.checked)}
            className="h-4 w-4"
          />
          {t("includeArchived")}
        </label>
      </div>

      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}

      {!customerId ? (
        <p className="text-sm text-muted-foreground">{t("selectCustomerPrompt")}</p>
      ) : (
        <TemplateList
          query={templatesQuery}
          rows={rows}
          onEdit={openEdit}
          onVersion={openVersion}
        />
      )}

      <Dialog open={formMode !== null} onOpenChange={(open) => (!open ? closeForm() : null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>
          {formMode !== null ? (
            <ImportTemplateForm
              key={`${formMode}:${selected?.id ?? "new"}`}
              defaultValues={formDefaults()}
              submitting={submitting}
              errorMessage={formError}
              submitLabel={submitLabel}
              onCancel={closeForm}
              onSubmit={handleFormSubmit}
            />
          ) : null}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function statusBadge(
  tpl: ImportTemplateDto,
  t: ReturnType<typeof useTranslations>,
): { label: string; variant: "default" | "secondary" | "outline" } {
  if (tpl.archived) return { label: t("statusArchived"), variant: "outline" };
  if (tpl.active) return { label: t("statusActive"), variant: "default" };
  return { label: t("statusInactive"), variant: "secondary" };
}

function TemplateList({
  query,
  rows,
  onEdit,
  onVersion,
}: {
  query: ReturnType<typeof useImportTemplates>;
  rows: ImportTemplateDto[];
  onEdit: (tpl: ImportTemplateDto) => void;
  onVersion: (tpl: ImportTemplateDto) => void;
}) {
  const t = useTranslations("ImportTemplates");

  if (query.isLoading) return <p className="text-sm text-muted-foreground">{t("loading")}</p>;
  if (query.isError) return <p className="text-sm text-destructive">{t("loadError")}</p>;
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("columnName")}</TableHead>
          <TableHead className="w-24">{t("columnVersion")}</TableHead>
          <TableHead className="w-32">{t("columnFileType")}</TableHead>
          <TableHead className="w-32">{t("columnStatus")}</TableHead>
          <TableHead className="w-72 text-right">{t("columnActions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((tpl) => {
          const badge = statusBadge(tpl, t);
          return (
            <TableRow key={tpl.id} data-template={tpl.name}>
              <TableCell className="font-medium">{tpl.name}</TableCell>
              <TableCell>v{tpl.version}</TableCell>
              <TableCell>{tpl.fileType.toUpperCase()}</TableCell>
              <TableCell>
                <Badge variant={badge.variant}>{badge.label}</Badge>
              </TableCell>
              <TableCell>
                <div className="flex flex-wrap justify-end gap-2">
                  {/* Archived templates are read-only (FR-010, enforced in US3). */}
                  {!tpl.archived ? (
                    <>
                      <Button size="sm" variant="outline" onClick={() => onEdit(tpl)}>
                        {t("edit")}
                      </Button>
                      <Button size="sm" variant="outline" onClick={() => onVersion(tpl)}>
                        {t("newVersion")}
                      </Button>
                    </>
                  ) : null}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
