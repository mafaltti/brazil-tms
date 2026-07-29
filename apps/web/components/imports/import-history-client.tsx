"use client";

import Link from "next/link";
import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

// --- Shapes (mirror contracts/bff-endpoints.md `ImportBatchSummary`) ----------------------------

type ImportBatchStatus =
  | "received"
  | "parsing"
  | "validating"
  | "validated"
  | "confirming"
  | "completed"
  | "failed";

interface ImportBatchSummary {
  id: string;
  customerId: string;
  fileName: string;
  status: ImportBatchStatus;
  totalRows: number;
  createdCount: number;
  updatedCount: number;
  duplicateCount: number;
  errorCount: number;
  uploadedBy: string;
  createdAt: string; // ISO UTC
  hasErrorReport: boolean;
}

interface CustomerOption {
  id: string;
  name: string;
  customerCode: string;
}

// --- Fetch helpers ------------------------------------------------------------------------------

async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`REQUEST_FAILED:${res.status}`);
  return (await res.json()) as T;
}

function statusBadgeVariant(
  status: ImportBatchStatus,
): "default" | "secondary" | "destructive" | "outline" {
  if (status === "completed") return "default";
  if (status === "failed") return "destructive";
  if (status === "validated") return "secondary";
  return "outline";
}

// `pt-BR`/`America/Sao_Paulo` display of a UTC ISO timestamp (stored UTC, shown local — CLAUDE.md).
const DATE_FORMATTER = new Intl.DateTimeFormat("pt-BR", {
  dateStyle: "short",
  timeStyle: "short",
  timeZone: "America/Sao_Paulo",
});

function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? iso : DATE_FORMATTER.format(date);
}

export function ImportHistoryClient() {
  const t = useTranslations("Imports");

  const historyQuery = useQuery({
    queryKey: ["import-history"],
    queryFn: () =>
      fetchJson<{ items: ImportBatchSummary[] }>("/api/imports?limit=50").then(
        (b) => b.items,
      ),
    staleTime: 10_000,
  });

  // Resolve customerId → name (reuse the shared master-data query key/cache).
  const customersQuery = useQuery({
    queryKey: ["master-data", "customers"],
    queryFn: () =>
      fetchJson<{ items: CustomerOption[] }>("/api/master-data/customers").then(
        (b) => b.items,
      ),
    staleTime: 30_000,
  });

  const customerName = useMemo(() => {
    const map = new Map<string, string>();
    for (const c of customersQuery.data ?? []) map.set(c.id, c.name);
    return (id: string) => map.get(id) ?? id;
  }, [customersQuery.data]);

  const rows = historyQuery.data ?? [];

  const columns: ColumnDef<ImportBatchSummary>[] = [
    {
      accessorKey: "fileName",
      header: () => t("historyFileName"),
      cell: ({ row }) => (
        <span className="font-medium">{row.original.fileName}</span>
      ),
    },
    {
      accessorKey: "customerId",
      header: () => t("customer"),
      cell: ({ row }) => customerName(row.original.customerId),
    },
    {
      accessorKey: "createdAt",
      header: () => t("historyTime"),
      cell: ({ row }) => formatDate(row.original.createdAt),
    },
    {
      id: "_counts",
      header: () => t("historyCounts"),
      cell: ({ row }) => (
        <span className="text-sm text-muted-foreground">
          {t("summary", {
            created: row.original.createdCount,
            updated: row.original.updatedCount,
            duplicate: row.original.duplicateCount,
            error: row.original.errorCount,
          })}
        </span>
      ),
    },
    {
      accessorKey: "status",
      header: () => t("historyStatus"),
      cell: ({ row }) => (
        <Badge variant={statusBadgeVariant(row.original.status)}>
          {t(`status.${row.original.status}`)}
        </Badge>
      ),
    },
    {
      id: "_actions",
      header: () => t("historyErrors"),
      // Show the download only when a report actually exists in Storage (hasErrorReport), not merely
      // when errorCount > 0 — otherwise the link would 404. It is a plain navigation to the endpoint
      // (which 302-redirects to a fresh signed URL), so no fetch + window.open (popup-block safe).
      cell: ({ row }) =>
        row.original.hasErrorReport ? (
          <Button asChild size="sm" variant="outline">
            <a
              href={`/api/imports/${row.original.id}/error-report`}
              target="_blank"
              rel="noopener noreferrer"
            >
              {t("historyDownloadErrors")}
            </a>
          </Button>
        ) : (
          <span className="text-muted-foreground">—</span>
        ),
    },
  ];

  const table = useReactTable({
    data: rows,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const columnCount = columns.length;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("historyTitle")}</h1>
          <p className="text-muted-foreground">{t("historySubtitle")}</p>
        </div>
        <Button asChild variant="outline">
          <Link href="/imports">{t("backToImport")}</Link>
        </Button>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">{t("historyTitle")}</CardTitle>
        </CardHeader>
        <CardContent>
          {historyQuery.isError ? (
            <p role="alert" className="text-sm text-destructive">
              {t("historyLoadError")}
            </p>
          ) : null}
          <div className="rounded-md border">
            <Table>
              <TableHeader>
                {table.getHeaderGroups().map((headerGroup) => (
                  <TableRow key={headerGroup.id}>
                    {headerGroup.headers.map((header) => (
                      <TableHead key={header.id}>
                        {header.isPlaceholder
                          ? null
                          : flexRender(
                              header.column.columnDef.header,
                              header.getContext(),
                            )}
                      </TableHead>
                    ))}
                  </TableRow>
                ))}
              </TableHeader>
              <TableBody>
                {historyQuery.isLoading ? (
                  <TableRow>
                    <TableCell colSpan={columnCount}>{t("historyLoading")}</TableCell>
                  </TableRow>
                ) : rows.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={columnCount}
                      className="text-muted-foreground"
                    >
                      {t("historyEmpty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  table.getRowModel().rows.map((row) => (
                    <TableRow key={row.id}>
                      {row.getVisibleCells().map((cell) => (
                        <TableCell key={cell.id}>
                          {flexRender(
                            cell.column.columnDef.cell,
                            cell.getContext(),
                          )}
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
