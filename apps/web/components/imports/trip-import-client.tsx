"use client";

import { useState, type FormEvent } from "react";
import Link from "next/link";
import { TriangleAlert } from "lucide-react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { STANDARD_IMPORT_TEMPLATE, VEHICLE_TYPE_VALUES } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// --- Shapes (mirror contracts/bff-endpoints.md "Shared returned shapes") -------------------------

type ImportBatchStatus =
  | "received"
  | "parsing"
  | "validating"
  | "validated"
  | "confirming"
  | "completed"
  | "failed";

type RowOutcome = "valid" | "warning" | "error" | null;

type MatchDecision =
  | "new"
  | "update"
  | "no_op"
  | "potential_duplicate"
  | "unresolved"
  | null;

interface CustomerOption {
  id: string;
  name: string;
  customerCode: string;
}

interface ImportBatchDetail {
  id: string;
  customerId: string;
  fileName: string;
  status: ImportBatchStatus;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  duplicateCount: number;
  errorCount: number;
  templateId: string | null;
  hasErrorReport: boolean;
  errorMessage: string | null;
}

interface ImportRow {
  rowNumber: number;
  outcome: RowOutcome;
  matchDecision: MatchDecision;
  reasons: { code: string; field?: string; message: string }[];
  mapped: Record<string, unknown> | null;
  targetTripId: string | null;
}

/** Subset of the master-data LocationDto we need for the unknown-location picker (T050). */
interface LocationOption {
  id: string;
  code: string;
  name: string;
}

// --- Fetch helpers ------------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`REQUEST_FAILED:${res.status}`);
  return (await res.json()) as T;
}

const TERMINAL_STATUSES: ReadonlySet<ImportBatchStatus> = new Set([
  "validated",
  "completed",
  "failed",
]);

function statusBadgeVariant(
  status: ImportBatchStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "validated") return "secondary";
  return "outline";
}

function outcomeBadgeClass(outcome: RowOutcome): string {
  if (outcome === "valid") return "border-transparent bg-green-600 text-white";
  if (outcome === "warning") return "border-transparent bg-amber-500 text-white";
  if (outcome === "error") return "border-transparent bg-red-600 text-white";
  return "";
}

const UNKNOWN_LOCATION_CODE = "UNKNOWN_LOCATION";

/** The reason that flags an unresolved location on a row, if any (T050). */
function unknownLocationReason(
  row: ImportRow,
): { code: string; field?: string; message: string } | undefined {
  return row.reasons.find((r) => r.code === UNKNOWN_LOCATION_CODE);
}

/**
 * The unresolved file value to map for an UNKNOWN_LOCATION row (T050). Prefer the mapped code that the
 * reason's `field` points at (originCode/destinationCode); fall back to originCode, then "".
 */
function unknownLocationFileValue(
  row: ImportRow,
  reason: { field?: string } | undefined,
): string {
  const mapped = row.mapped ?? {};
  const fromField =
    reason?.field && typeof mapped[reason.field] === "string"
      ? (mapped[reason.field] as string)
      : undefined;
  if (fromField) return fromField;
  const origin = mapped.originCode;
  if (typeof origin === "string" && origin.length > 0) return origin;
  const destination = mapped.destinationCode;
  if (typeof destination === "string" && destination.length > 0) return destination;
  return "";
}

export function TripImportClient() {
  const t = useTranslations("Imports");
  const tVehicle = useTranslations("VehicleTypes");
  const queryClient = useQueryClient();

  const [customerId, setCustomerId] = useState<string>("");
  const [file, setFile] = useState<File | null>(null);
  const [batchId, setBatchId] = useState<string | null>(null);
  const [uploadError, setUploadError] = useState<string | null>(null);
  const [formatOpen, setFormatOpen] = useState(false);

  // 1. Customers (reuse the master-data query key, same endpoint).
  const customersQuery = useQuery({
    queryKey: ["master-data", "customers"],
    queryFn: () =>
      fetchJson<{ items: CustomerOption[] }>("/api/master-data/customers").then(
        (b) => b.items,
      ),
    staleTime: 30_000,
  });

  // 4. Batch progress — polled until a terminal status (NO Realtime).
  const batchQuery = useQuery({
    queryKey: ["import-batch", batchId],
    queryFn: () =>
      fetchJson<{ item: ImportBatchDetail }>(
        `/api/imports/${batchId}`,
      ).then((b) => b.item),
    enabled: Boolean(batchId),
    refetchInterval: (query) => {
      const data = query.state.data;
      const status = data?.status;
      if (!status) return 2500;
      // Keep polling while the error report is still being generated (errors exist but no report yet),
      // so the "Exportar erros" link appears without a manual refresh. generate-error-report runs right
      // after detect-duplicates on the same worker, so this resolves within ~1s.
      if (status === "validated" && data.errorCount > 0 && !data.hasErrorReport) return 2500;
      // Stop polling once the batch reaches a terminal/awaiting-user state (validated → preview is
      // ready; completed/failed → done). Confirm resumes polling via query invalidation.
      if (TERMINAL_STATUSES.has(status)) return false;
      return 2500;
    },
  });

  const batch = batchQuery.data;
  const status = batch?.status;
  const isValidatedOrLater =
    status === "validated" || status === "confirming" || status === "completed";

  // 5. Preview rows — once validation has produced outcomes.
  const rowsQuery = useQuery({
    queryKey: ["import-rows", batchId],
    queryFn: () =>
      fetchJson<{ items: ImportRow[]; total: number }>(
        `/api/imports/${batchId}/rows?limit=200`,
      ),
    enabled: Boolean(batchId) && isValidatedOrLater,
    staleTime: 5_000,
  });

  // 3. Upload mutation → 202 { id }.
  const uploadMutation = useMutation({
    mutationFn: async () => {
      if (!file) throw new Error("NO_FILE");
      const form = new FormData();
      form.append("file", file);
      form.append("customerId", customerId);
      const res = await fetch("/api/imports", { method: "POST", body: form });
      if (!res.ok) throw new Error(`UPLOAD_FAILED:${res.status}`);
      return (await res.json()) as { id: string };
    },
    onSuccess: ({ id }) => {
      setUploadError(null);
      setBatchId(id);
    },
    onError: () => setUploadError(t("uploadError")),
  });

  // 6. Confirm mutation → 202; resume polling until completed.
  const confirmMutation = useMutation({
    mutationFn: async () => {
      const res = await fetch(`/api/imports/${batchId}/confirm`, {
        method: "POST",
      });
      if (!res.ok) throw new Error(`CONFIRM_FAILED:${res.status}`);
      return (await res.json()) as { id: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["import-batch", batchId] });
    },
  });

  // 7. Locations of the selected customer — shared by the unknown-location mapper (T050) and the
  // manual-create form (T055). Same query key/endpoint as master-data so the cache is reused.
  const locationsQuery = useQuery({
    queryKey: ["master-data", "locations", customerId],
    queryFn: () =>
      fetchJson<{ items: LocationOption[] }>(
        `/api/master-data/locations?customerId=${encodeURIComponent(customerId)}`,
      ).then((b) => b.items),
    enabled: Boolean(customerId),
    staleTime: 30_000,
  });

  // 8. Map an unknown file value → an existing customer location (US4, T050). On success the BFF
  // enqueues a re-validate, so we invalidate the batch + rows and resume polling.
  const mapLocationMutation = useMutation({
    mutationFn: async (input: { fileValue: string; locationId: string }) => {
      const res = await fetch(`/api/imports/${batchId}/locations`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(input),
      });
      if (!res.ok) throw new Error(`MAP_LOCATION_FAILED:${res.status}`);
      return (await res.json()) as { id: string };
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["import-batch", batchId] });
      void queryClient.invalidateQueries({ queryKey: ["import-rows", batchId] });
    },
  });

  // --- Manual create (T055) — minimal secondary path to create a single trip without a file. -------
  const [manualOpen, setManualOpen] = useState(false);
  const [manualCustomerId, setManualCustomerId] = useState<string>("");
  const [manualOriginId, setManualOriginId] = useState<string>("");
  const [manualDestinationId, setManualDestinationId] = useState<string>("");
  const [manualExternalId, setManualExternalId] = useState<string>("");
  const [manualVehicleType, setManualVehicleType] = useState<string>("");

  const manualLocationsQuery = useQuery({
    queryKey: ["master-data", "locations", manualCustomerId],
    queryFn: () =>
      fetchJson<{ items: LocationOption[] }>(
        `/api/master-data/locations?customerId=${encodeURIComponent(manualCustomerId)}`,
      ).then((b) => b.items),
    enabled: Boolean(manualCustomerId),
    staleTime: 30_000,
  });

  const manualCreateMutation = useMutation({
    mutationFn: async () => {
      const body: Record<string, unknown> = {
        customerId: manualCustomerId,
        originLocationId: manualOriginId,
        destinationLocationId: manualDestinationId,
      };
      if (manualExternalId.trim()) body.externalTripId = manualExternalId.trim();
      if (manualVehicleType) body.plannedVehicleType = manualVehicleType;
      const res = await fetch("/api/trips", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) throw new Error(`CREATE_TRIP_FAILED:${res.status}`);
      return (await res.json()) as { item: { id: string } };
    },
    onSuccess: () => {
      setManualOriginId("");
      setManualDestinationId("");
      setManualExternalId("");
      setManualVehicleType("");
    },
  });

  function handleManualSubmit(e: FormEvent) {
    e.preventDefault();
    if (!manualCustomerId || !manualOriginId || !manualDestinationId) return;
    if (manualOriginId === manualDestinationId) return;
    manualCreateMutation.mutate();
  }

  function handleSubmit(e: FormEvent) {
    e.preventDefault();
    if (!customerId || !file) return;
    uploadMutation.mutate();
  }

  function resetForNewImport() {
    setBatchId(null);
    setFile(null);
    setUploadError(null);
    confirmMutation.reset();
  }

  // Build + download a ready-to-fill sample CSV from the SAME source of truth the worker maps against
  // (STANDARD_IMPORT_TEMPLATE), so the headers can never drift from the real format. Header row + one
  // example row; BOM so Excel (pt-BR) opens the accents correctly.
  function downloadSampleCsv() {
    const cols = STANDARD_IMPORT_TEMPLATE.columnMappings;
    // RFC 4180: quote any field containing a comma, quote, or newline (today's values are safe, but a
    // future label/example edit must not silently corrupt the file).
    const escape = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
    const header = cols.map((c) => escape(c.source)).join(",");
    const example = cols.map((c) => escape(t(`expectedColumns.${c.source}.example`))).join(",");
    const blob = new Blob([`\uFEFF${header}\n${example}\n`], { type: "text/csv;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = t("sampleFileName");
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }

  const counts = batch
    ? {
        created: batch.createdCount,
        updated: batch.updatedCount,
        duplicate: batch.duplicateCount,
        error: batch.errorCount,
      }
    : null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/imports/history">{t("historyLink")}</Link>
        </Button>
      </div>

      {/* Provisional standard-format notice (US2, FR-007) — always visible; the standard import format is
          a §29-blocked documented default pending customer sign-off. Mirrors the 009 provisional banner. */}
      <div
        role="status"
        className="flex items-start gap-2 rounded-md border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900"
      >
        <TriangleAlert className="mt-0.5 h-4 w-4 shrink-0" aria-hidden />
        <span>{t("provisionalNotice")}</span>
      </div>

      {/* Upload form */}
      <Card>
        <CardHeader>
          <CardTitle>{t("uploadTitle")}</CardTitle>
          <CardDescription>{t("uploadSubtitle")}</CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Customer */}
            <div className="space-y-2">
              <Label htmlFor="import-customer">{t("customer")}</Label>
              <Select
                value={customerId}
                onValueChange={setCustomerId}
                disabled={customersQuery.isLoading || Boolean(batchId)}
              >
                <SelectTrigger id="import-customer">
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
            </div>

            {/* File */}
            <div className="space-y-2">
              <Label htmlFor="import-file">{t("file")}</Label>
              <input
                id="import-file"
                type="file"
                accept=".csv,.xlsx"
                disabled={Boolean(batchId)}
                onChange={(e) => setFile(e.target.files?.[0] ?? null)}
                className="flex h-9 w-full rounded-md border border-input bg-transparent px-3 py-1 text-sm shadow-sm transition-colors file:mr-3 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
              />
              <p className="text-xs text-muted-foreground">{t("fileHint")}</p>

              {/* Expected-format helper (US: "how do I know the columns?"): a sample-CSV download + an
                  inline column list. Both derive from STANDARD_IMPORT_TEMPLATE so they stay in lockstep
                  with the mapping the worker applies. Guidance only — no validation change. */}
              <div className="flex flex-wrap items-center gap-2 pt-1">
                <Button type="button" variant="outline" size="sm" onClick={downloadSampleCsv}>
                  {t("downloadSample")}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-expanded={formatOpen}
                  aria-controls="import-expected-format"
                  onClick={() => setFormatOpen((open) => !open)}
                >
                  {formatOpen ? t("expectedFormatHide") : t("expectedFormatShow")}
                </Button>
              </div>

              {formatOpen ? (
                <div id="import-expected-format" className="rounded-md border bg-muted/30 p-3 text-sm">
                  <p className="font-medium">{t("expectedFormatTitle")}</p>
                  <p className="mt-1 text-muted-foreground">{t("expectedFormatSubtitle")}</p>
                  <ul className="mt-3 space-y-1">
                    {STANDARD_IMPORT_TEMPLATE.columnMappings.map((c) => (
                      <li key={c.source} className="flex flex-wrap items-baseline gap-x-2">
                        <code className="rounded bg-muted px-1 py-0.5 text-xs">{c.source}</code>
                        {c.required ? (
                          <Badge variant="secondary" className="text-[10px]">
                            {t("expectedFormatRequired")}
                          </Badge>
                        ) : null}
                        <span className="text-muted-foreground">
                          — {t(`expectedColumns.${c.source}.label`)}
                        </span>
                        <span className="text-xs text-muted-foreground">
                          ({t("expectedFormatExample")} {t(`expectedColumns.${c.source}.example`)})
                        </span>
                      </li>
                    ))}
                  </ul>
                  <p className="mt-3 text-xs text-muted-foreground">{t("expectedFormatNote")}</p>
                </div>
              ) : null}
            </div>

            {uploadError ? (
              <p className="text-sm text-destructive" role="alert">
                {uploadError}
              </p>
            ) : null}

            <div className="flex items-center gap-3">
              <Button
                type="submit"
                disabled={
                  !customerId ||
                  !file ||
                  uploadMutation.isPending ||
                  Boolean(batchId)
                }
              >
                {uploadMutation.isPending ? t("uploading") : t("import")}
              </Button>
              {batchId ? (
                <Button type="button" variant="outline" onClick={resetForNewImport}>
                  {t("newImport")}
                </Button>
              ) : null}
            </div>
          </form>
        </CardContent>
      </Card>

      {/* Progress + counts (polled) */}
      {batchId ? (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-3">
              {t("progressTitle")}
              {status ? (
                <Badge variant={statusBadgeVariant(status)}>
                  {t(`status.${status}`)}
                </Badge>
              ) : null}
            </CardTitle>
            {batch ? (
              <CardDescription>{batch.fileName}</CardDescription>
            ) : null}
          </CardHeader>
          <CardContent className="space-y-4">
            {batchQuery.isLoading && !batch ? (
              <p className="text-sm text-muted-foreground">{t("loadingProgress")}</p>
            ) : null}

            {batch?.errorMessage ? (
              <p className="text-sm text-destructive" role="alert">
                {batch.errorMessage}
              </p>
            ) : null}

            {counts ? (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
                <CountTile label={t("countNew")} value={counts.created} />
                <CountTile label={t("countUpdated")} value={counts.updated} />
                <CountTile label={t("countDuplicate")} value={counts.duplicate} />
                <CountTile label={t("countError")} value={counts.error} />
              </div>
            ) : null}

            {/* Error report + reimport hint (US2, T043). The box shows whenever there are errors; the
                download link appears only once the report exists in Storage (hasErrorReport) and is a
                plain navigation to the endpoint (302 → fresh signed URL), so it's popup-block safe. */}
            {batch && batch.errorCount > 0 ? (
              <div className="space-y-2 rounded-lg border border-amber-300 bg-amber-50 p-3">
                <div className="flex flex-wrap items-center gap-3">
                  {batch.hasErrorReport ? (
                    <Button asChild variant="outline">
                      <a
                        href={`/api/imports/${batch.id}/error-report`}
                        target="_blank"
                        rel="noopener noreferrer"
                      >
                        {t("exportErrors")}
                      </a>
                    </Button>
                  ) : null}
                  <span className="text-sm text-amber-800">{t("reimportHint")}</span>
                </div>
              </div>
            ) : null}

            {status === "completed" ? (
              <p className="text-sm font-medium text-green-600" role="status">
                {t("completedMsg")}
              </p>
            ) : null}

            {/* Confirm */}
            {batch ? (
              <div className="flex items-center gap-3">
                <Button
                  type="button"
                  onClick={() => confirmMutation.mutate()}
                  disabled={status !== "validated" || confirmMutation.isPending}
                >
                  {confirmMutation.isPending ? t("confirming") : t("confirm")}
                </Button>
                {status === "validated" ? (
                  <span className="text-sm text-muted-foreground">
                    {t("confirmHint")}
                  </span>
                ) : null}
              </div>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Preview / validation table */}
      {batchId && isValidatedOrLater ? (
        <Card>
          <CardHeader>
            <CardTitle>{t("previewTitle")}</CardTitle>
            {batch ? (
              <CardDescription>
                {t("summary", {
                  created: batch.createdCount,
                  updated: batch.updatedCount,
                  duplicate: batch.duplicateCount,
                  error: batch.errorCount,
                })}
              </CardDescription>
            ) : null}
          </CardHeader>
          <CardContent>
            {rowsQuery.isLoading ? (
              <p className="text-sm text-muted-foreground">{t("loadingRows")}</p>
            ) : rowsQuery.isError ? (
              <p className="text-sm text-destructive">{t("rowsLoadError")}</p>
            ) : (rowsQuery.data?.items.length ?? 0) === 0 ? (
              <p className="text-sm text-muted-foreground">{t("noRows")}</p>
            ) : (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-16">{t("rowNumber")}</TableHead>
                    <TableHead className="w-28">{t("outcome")}</TableHead>
                    <TableHead className="w-44">{t("matchDecision")}</TableHead>
                    <TableHead>{t("reasons")}</TableHead>
                    <TableHead className="w-72">{t("rowActions")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {(rowsQuery.data?.items ?? []).map((row) => (
                    <PreviewRow
                      key={row.rowNumber}
                      row={row}
                      locations={locationsQuery.data ?? []}
                      onMap={(input) => mapLocationMutation.mutate(input)}
                      mapping={mapLocationMutation.isPending}
                    />
                  ))}
                </TableBody>
              </Table>
            )}
          </CardContent>
        </Card>
      ) : null}

      {/* Manual entry (T055) — secondary, collapsible single-trip create. */}
      <Card>
        <CardHeader>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <CardTitle className="text-base">{t("manualTitle")}</CardTitle>
              <CardDescription>{t("manualSubtitle")}</CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setManualOpen((open) => !open)}
            >
              {manualOpen ? t("manualHide") : t("manualShow")}
            </Button>
          </div>
        </CardHeader>
        {manualOpen ? (
          <CardContent>
            <form onSubmit={handleManualSubmit} className="space-y-4">
              <div className="grid gap-4 sm:grid-cols-2">
                {/* Customer */}
                <div className="space-y-2">
                  <Label htmlFor="manual-customer">{t("customer")}</Label>
                  <Select
                    value={manualCustomerId}
                    onValueChange={(value) => {
                      setManualCustomerId(value);
                      setManualOriginId("");
                      setManualDestinationId("");
                    }}
                    disabled={customersQuery.isLoading}
                  >
                    <SelectTrigger id="manual-customer">
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
                </div>

                {/* External trip id (optional) */}
                <div className="space-y-2">
                  <Label htmlFor="manual-external-id">{t("manualExternalId")}</Label>
                  <Input
                    id="manual-external-id"
                    value={manualExternalId}
                    onChange={(e) => setManualExternalId(e.target.value)}
                    placeholder={t("manualExternalIdPlaceholder")}
                  />
                </div>

                {/* Origin */}
                <div className="space-y-2">
                  <Label htmlFor="manual-origin">{t("manualOrigin")}</Label>
                  <Select
                    value={manualOriginId}
                    onValueChange={setManualOriginId}
                    disabled={!manualCustomerId || manualLocationsQuery.isLoading}
                  >
                    <SelectTrigger id="manual-origin">
                      <SelectValue placeholder={t("manualSelectLocation")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(manualLocationsQuery.data ?? []).map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name} ({loc.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Destination */}
                <div className="space-y-2">
                  <Label htmlFor="manual-destination">{t("manualDestination")}</Label>
                  <Select
                    value={manualDestinationId}
                    onValueChange={setManualDestinationId}
                    disabled={!manualCustomerId || manualLocationsQuery.isLoading}
                  >
                    <SelectTrigger id="manual-destination">
                      <SelectValue placeholder={t("manualSelectLocation")} />
                    </SelectTrigger>
                    <SelectContent>
                      {(manualLocationsQuery.data ?? []).map((loc) => (
                        <SelectItem key={loc.id} value={loc.id}>
                          {loc.name} ({loc.code})
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>

                {/* Vehicle type (optional) */}
                <div className="space-y-2">
                  <Label htmlFor="manual-vehicle-type">{t("manualVehicleType")}</Label>
                  <Select
                    value={manualVehicleType}
                    onValueChange={setManualVehicleType}
                  >
                    <SelectTrigger id="manual-vehicle-type">
                      <SelectValue placeholder={t("manualSelectVehicleType")} />
                    </SelectTrigger>
                    <SelectContent>
                      {VEHICLE_TYPE_VALUES.map((vt) => (
                        <SelectItem key={vt} value={vt}>
                          {tVehicle(vt)}
                        </SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>

              {manualOriginId &&
              manualDestinationId &&
              manualOriginId === manualDestinationId ? (
                <p className="text-sm text-destructive" role="alert">
                  {t("manualSameLocation")}
                </p>
              ) : null}

              {manualCreateMutation.isError ? (
                <p className="text-sm text-destructive" role="alert">
                  {t("manualError")}
                </p>
              ) : null}

              {manualCreateMutation.isSuccess ? (
                <p className="text-sm font-medium text-green-600" role="status">
                  {t("manualSuccess")}
                </p>
              ) : null}

              <Button
                type="submit"
                disabled={
                  !manualCustomerId ||
                  !manualOriginId ||
                  !manualDestinationId ||
                  manualOriginId === manualDestinationId ||
                  manualCreateMutation.isPending
                }
              >
                {manualCreateMutation.isPending
                  ? t("manualCreating")
                  : t("manualCreate")}
              </Button>
            </form>
          </CardContent>
        ) : null}
      </Card>
    </div>
  );
}

/**
 * One preview row (US2/US4). Shows the outcome + match decision (with an amber "potencial duplicata"
 * tag, T043) + reasons, and — for UNKNOWN_LOCATION rows — an inline location mapper (T050): a Select of
 * the customer's existing locations + a "Mapear" button POSTing to `/api/imports/{id}/locations`.
 */
function PreviewRow({
  row,
  locations,
  onMap,
  mapping,
}: {
  row: ImportRow;
  locations: LocationOption[];
  onMap: (input: { fileValue: string; locationId: string }) => void;
  mapping: boolean;
}) {
  const t = useTranslations("Imports");
  const [locationId, setLocationId] = useState<string>("");

  const reason = unknownLocationReason(row);
  const isPotentialDuplicate = row.matchDecision === "potential_duplicate";
  const fileValue = reason ? unknownLocationFileValue(row, reason) : "";

  return (
    <TableRow data-row={row.rowNumber}>
      <TableCell className="font-medium">{row.rowNumber}</TableCell>
      <TableCell>
        {row.outcome ? (
          <Badge className={outcomeBadgeClass(row.outcome)}>
            {t(`outcomes.${row.outcome}`)}
          </Badge>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
      <TableCell>
        {isPotentialDuplicate ? (
          <Badge className="border-transparent bg-amber-500 text-white">
            {t("potentialDuplicateTag")}
          </Badge>
        ) : row.matchDecision ? (
          t(`match.${row.matchDecision}`)
        ) : (
          "—"
        )}
      </TableCell>
      <TableCell className="text-muted-foreground">
        {row.reasons.length > 0
          ? row.reasons.map((r) => r.message).join(" · ")
          : "—"}
      </TableCell>
      <TableCell>
        {reason ? (
          <div className="flex flex-wrap items-center gap-2">
            <Select value={locationId} onValueChange={setLocationId}>
              <SelectTrigger className="h-8 w-44">
                <SelectValue placeholder={t("mapSelectLocation")} />
              </SelectTrigger>
              <SelectContent>
                {locations.map((loc) => (
                  <SelectItem key={loc.id} value={loc.id}>
                    {loc.name} ({loc.code})
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={!locationId || !fileValue || mapping}
              onClick={() => onMap({ fileValue, locationId })}
            >
              {t("mapAction")}
            </Button>
          </div>
        ) : (
          <span className="text-muted-foreground">—</span>
        )}
      </TableCell>
    </TableRow>
  );
}

function CountTile({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded-lg border p-3">
      <div className="text-2xl font-semibold">{value}</div>
      <div className="text-xs text-muted-foreground">{label}</div>
    </div>
  );
}
