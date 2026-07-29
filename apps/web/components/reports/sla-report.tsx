"use client";

import { useTranslations } from "next-intl";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import type { SlaReportRow } from "@brazil-tms/shared";
import { useSlaReport } from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ProvisionalBanner } from "@/components/reports/provisional-banner";

/**
 * Feature 009 — SLA performance report (US1, SLA-005/REP-002). Summary cards (overall on-time pickup/
 * arrival %, breached count) + a TanStack Table per customer/lane (total, on-time %s, the four stored
 * SLA-state counts) + the provisional banner when a customer runs on the default SLA policy. Tables +
 * cards only — no charting lib (R7). Read-only, polled via `useSlaReport`. pt-BR throughout.
 */

const pct = (v: number | null): string => (v == null ? "—" : `${v}%`);

export function SlaReport({ search }: { search: string }) {
  const t = useTranslations("Reports");
  const tSla = useTranslations("Reports.sla");
  const query = useSlaReport(search);
  const report = query.data;

  const columns: ColumnDef<SlaReportRow>[] = [
    { id: "group", header: () => tSla("group"), cell: ({ row }) => row.original.groupLabel || "—" },
    { id: "total", header: () => tSla("total"), cell: ({ row }) => row.original.total },
    {
      id: "pickup",
      header: () => tSla("onTimePickup"),
      cell: ({ row }) => pct(row.original.onTimePickupPct),
    },
    {
      id: "arrival",
      header: () => tSla("onTimeArrival"),
      cell: ({ row }) => pct(row.original.onTimeArrivalPct),
    },
    { id: "onTrack", header: () => tSla("onTrack"), cell: ({ row }) => row.original.onTrack },
    { id: "atRisk", header: () => tSla("atRisk"), cell: ({ row }) => row.original.atRisk },
    { id: "late", header: () => tSla("late"), cell: ({ row }) => row.original.late },
    {
      id: "breached",
      header: () => tSla("breachedCol"),
      cell: ({ row }) => row.original.breached,
    },
    { id: "settled", header: () => tSla("settled"), cell: ({ row }) => row.original.settled },
  ];

  const table = useReactTable({
    data: report?.groups ?? [],
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  if (query.isError) {
    return (
      <p role="alert" className="text-sm text-destructive">
        {t("loadError")}
      </p>
    );
  }

  if (query.isPending || !report) {
    return <Skeleton className="h-72 w-full" />;
  }

  return (
    <div className="space-y-4">
      {report.provisional ? <ProvisionalBanner reason={report.provisionalReason} /> : null}

      <p className="text-sm text-muted-foreground">
        {t("period")}: {report.period.label}
      </p>

      <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
        <SummaryCard label={tSla("onTimePickup")} value={pct(report.totals.onTimePickupPct)} />
        <SummaryCard label={tSla("onTimeArrival")} value={pct(report.totals.onTimeArrivalPct)} />
        <SummaryCard label={tSla("breached")} value={String(report.totals.breached)} />
      </div>

      <p className="text-xs text-muted-foreground">{tSla("statesNote")}</p>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              {table.getHeaderGroups().map((hg) => (
                <TableRow key={hg.id}>
                  {hg.headers.map((header) => (
                    <TableHead key={header.id} className="whitespace-nowrap">
                      {header.isPlaceholder
                        ? null
                        : flexRender(header.column.columnDef.header, header.getContext())}
                    </TableHead>
                  ))}
                </TableRow>
              ))}
            </TableHeader>
            <TableBody>
              {report.groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={columns.length} className="h-24 text-center text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                table.getRowModel().rows.map((row) => (
                  <TableRow key={row.id}>
                    {row.getVisibleCells().map((cell) => (
                      <TableCell key={cell.id} className="whitespace-nowrap">
                        {flexRender(cell.column.columnDef.cell, cell.getContext())}
                      </TableCell>
                    ))}
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}

function SummaryCard({ label, value }: { label: string; value: string }) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{label}</CardTitle>
      </CardHeader>
      <CardContent>
        <p className="text-2xl font-semibold">{value}</p>
      </CardContent>
    </Card>
  );
}
