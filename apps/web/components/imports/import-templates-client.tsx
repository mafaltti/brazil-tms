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
  DialogFooter,
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

/** The form dialog creates a template, edits one in place, seeds "criar nova versão", or shows an
 *  archived template read-only ("view"). */
type FormMode = "create" | "edit" | "version" | "view";

/** A deactivate/archive that would leave the customer with zero active templates is confirmed first. */
type PendingConfirm = { tpl: ImportTemplateDto; kind: "deactivate" | "archive" };

/**
 * Import Templates administration (slice 012). Lists a selected customer's templates and creates /
 * edits / versions / activates / archives them via the EXISTING `/api/import-templates` endpoints.
 * Freshness is TanStack Query polling; NO Realtime. Authorization is enforced by the BFF + the
 * server-component guard (`import_trips`); this screen only composes UI.
 *
 * Two rules the frozen backend does NOT enforce are kept client-side: archived templates are read-only
 * (FR-010 — no edit/lifecycle actions, view-only) and a warn-and-allow confirmation guards an action
 * that would leave the customer with no active template (FR-017).
 */
export function ImportTemplatesClient() {
  const t = useTranslations("ImportTemplates");
  const tCommon = useTranslations("Common");
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState<string>("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [formMode, setFormMode] = useState<FormMode | null>(null);
  const [selected, setSelected] = useState<ImportTemplateDto | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [confirm, setConfirm] = useState<PendingConfirm | null>(null);

  // Customers — reuse the master-data query key/endpoint so the cache is shared with Trip Import.
  const customersQuery = useQuery({
    queryKey: ["master-data", "customers"],
    queryFn: () =>
      fetchJson<{ items: CustomerOption[] }>("/api/master-data/customers").then((b) => b.items),
    staleTime: 30_000,
  });

  // Always fetch the full set (incl. archived) so version suggestions and the last-active count see
  // archived rows too — the DB unique key (customer, name, version) spans archived rows, and a hidden
  // archived version would otherwise make a suggested version collide. The "Incluir arquivados" toggle
  // only controls what the list DISPLAYS.
  const templatesQuery = useImportTemplates(customerId, true);
  const allRows = templatesQuery.data ?? [];
  const rows = includeArchived ? allRows : allRows.filter((r) => !r.archived);

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

  // Lifecycle (activate/deactivate/archive) — distinct from the form's config edits.
  const statusMutation = useMutation({
    mutationFn: ({ id, input }: { id: string; input: UpdateTemplateInput; successKey: string }) =>
      updateTemplate(id, input),
    onSuccess: (_data, vars) => {
      setFeedback(t(vars.successKey));
      invalidate();
    },
    onError: () => setFeedback(t("actionError")),
    onSettled: () => setBusyId(null),
  });

  function openCreate() {
    setSelected(null);
    setFormError(null);
    setFeedback(null);
    setFormMode("create");
  }

  function openMode(mode: FormMode, tpl: ImportTemplateDto) {
    setSelected(tpl);
    setFormError(null);
    setFeedback(null);
    setFormMode(mode);
  }

  function closeForm() {
    setFormMode(null);
    setSelected(null);
    setFormError(null);
  }

  function formDefaults(): Partial<TemplateConfig> & { customerId: string } {
    if (selected && (formMode === "edit" || formMode === "version")) {
      return {
        customerId,
        name: selected.name,
        version: formMode === "version" ? nextVersion(allRows, selected.name) : selected.version,
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

  // FR-017: would this deactivate/archive remove the customer's last active (non-archived) template?
  const activeCount = allRows.filter((r) => r.active && !r.archived).length;
  function isLastActive(tpl: ImportTemplateDto): boolean {
    return tpl.active && !tpl.archived && activeCount === 1;
  }

  function runStatus(tpl: ImportTemplateDto, input: UpdateTemplateInput, successKey: string) {
    setFeedback(null);
    setBusyId(tpl.id);
    statusMutation.mutate({ id: tpl.id, input, successKey });
  }

  function requestDeactivate(tpl: ImportTemplateDto) {
    if (isLastActive(tpl)) setConfirm({ tpl, kind: "deactivate" });
    else runStatus(tpl, { active: false }, "deactivated");
  }

  function requestArchive(tpl: ImportTemplateDto) {
    if (isLastActive(tpl)) setConfirm({ tpl, kind: "archive" });
    else runStatus(tpl, { archive: true }, "archivedMsg");
  }

  function proceedConfirm() {
    if (!confirm) return;
    const { tpl, kind } = confirm;
    setConfirm(null);
    if (kind === "deactivate") runStatus(tpl, { active: false }, "deactivated");
    else runStatus(tpl, { archive: true }, "archivedMsg");
  }

  const dialogTitle =
    formMode === "edit"
      ? t("editTitle")
      : formMode === "version"
        ? t("newVersionTitle")
        : formMode === "view"
          ? t("viewTitle")
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
          busyId={busyId}
          onEdit={(tpl) => openMode("edit", tpl)}
          onVersion={(tpl) => openMode("version", tpl)}
          onView={(tpl) => openMode("view", tpl)}
          onActivate={(tpl) => runStatus(tpl, { active: true }, "activated")}
          onDeactivate={requestDeactivate}
          onArchive={requestArchive}
        />
      )}

      <Dialog open={formMode !== null} onOpenChange={(open) => (!open ? closeForm() : null)}>
        <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
          <DialogHeader>
            <DialogTitle>{dialogTitle}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>
          {formMode === "view" && selected ? (
            <ReadOnlyTemplate tpl={selected} onClose={closeForm} />
          ) : formMode !== null ? (
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

      {/* FR-017 — last-active warn-and-allow (reused for deactivate + archive). */}
      <Dialog open={confirm !== null} onOpenChange={(open) => (!open ? setConfirm(null) : null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>{t("confirmTitle")}</DialogTitle>
            <DialogDescription>{t("confirmations.lastActiveTemplate")}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button variant="outline" onClick={() => setConfirm(null)}>
              {tCommon("cancel")}
            </Button>
            <Button onClick={proceedConfirm}>{t("proceed")}</Button>
          </DialogFooter>
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
  busyId,
  onEdit,
  onVersion,
  onView,
  onActivate,
  onDeactivate,
  onArchive,
}: {
  query: ReturnType<typeof useImportTemplates>;
  rows: ImportTemplateDto[];
  busyId: string | null;
  onEdit: (tpl: ImportTemplateDto) => void;
  onVersion: (tpl: ImportTemplateDto) => void;
  onView: (tpl: ImportTemplateDto) => void;
  onActivate: (tpl: ImportTemplateDto) => void;
  onDeactivate: (tpl: ImportTemplateDto) => void;
  onArchive: (tpl: ImportTemplateDto) => void;
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
          <TableHead className="text-right">{t("columnActions")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((tpl) => {
          const badge = statusBadge(tpl, t);
          const busy = busyId === tpl.id;
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
                  {tpl.archived ? (
                    // Archived = read-only (FR-010): no edit/lifecycle action, view-only inspection.
                    <Button size="sm" variant="outline" onClick={() => onView(tpl)}>
                      {t("view")}
                    </Button>
                  ) : (
                    <>
                      <Button size="sm" variant="outline" onClick={() => onEdit(tpl)} disabled={busy}>
                        {t("edit")}
                      </Button>
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => onVersion(tpl)}
                        disabled={busy}
                      >
                        {t("newVersion")}
                      </Button>
                      {tpl.active ? (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onDeactivate(tpl)}
                          disabled={busy}
                        >
                          {t("deactivate")}
                        </Button>
                      ) : (
                        <Button
                          size="sm"
                          variant="outline"
                          onClick={() => onActivate(tpl)}
                          disabled={busy}
                        >
                          {t("activate")}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant="ghost"
                        onClick={() => onArchive(tpl)}
                        disabled={busy}
                      >
                        {t("archive")}
                      </Button>
                    </>
                  )}
                </div>
              </TableCell>
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}

/** Read-only inspection of an archived template (FR-010 — archived is not editable). */
function ReadOnlyTemplate({ tpl, onClose }: { tpl: ImportTemplateDto; onClose: () => void }) {
  const t = useTranslations("ImportTemplates");
  const tCommon = useTranslations("Common");
  return (
    <div className="space-y-4 text-sm">
      <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
        <div>
          <span className="text-muted-foreground">{t("formName")}</span>
          <p className="font-medium">{tpl.name}</p>
        </div>
        <div>
          <span className="text-muted-foreground">{t("formVersion")}</span>
          <p className="font-medium">v{tpl.version}</p>
        </div>
        <div>
          <span className="text-muted-foreground">{t("formFileType")}</span>
          <p className="font-medium">{tpl.fileType.toUpperCase()}</p>
        </div>
      </div>

      <div className="space-y-1 rounded-md border p-3">
        <span className="font-medium">{t("columnMappings")}</span>
        {tpl.columnMappings.length === 0 ? (
          <p className="text-muted-foreground">{t("noMappingsYet")}</p>
        ) : (
          <ul className="space-y-1">
            {tpl.columnMappings.map((m, i) => (
              <li key={i} className="text-muted-foreground">
                <span className="font-mono">{m.source}</span> → <span className="font-mono">{m.target}</span>
                {m.required ? ` (${t("requiredFlag")})` : ""}
              </li>
            ))}
          </ul>
        )}
      </div>

      <div className="rounded-md border p-3">
        <span className="font-medium">{t("parsingRules")}</span>
        <p className="text-muted-foreground">
          {t("dateFormats")}: {tpl.parsingRules.dateFormats.join(", ") || tCommon("none")} ·{" "}
          {t("timezone")}: {tpl.parsingRules.timezone}
        </p>
      </div>

      <DialogFooter>
        <Button variant="outline" onClick={onClose}>
          {tCommon("close")}
        </Button>
      </DialogFooter>
    </div>
  );
}
