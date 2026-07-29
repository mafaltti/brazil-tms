"use client";

import { useTranslations } from "next-intl";
import { useExceptionReport } from "@/lib/trips/client";
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

/**
 * Feature 009 — exception analytics report (US2, REP-003). Summary cards (total / open / resolved /
 * avg resolution) + breakdown tables by reason-code category, by severity, and by customer/lane.
 * Tables + cards only (R7). Read-only, polled via `useExceptionReport`. pt-BR throughout.
 */

function formatMinutes(m: number | null): string {
  if (m == null) return "—";
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  const min = m % 60;
  return min === 0 ? `${h} h` : `${h} h ${min} min`;
}

export function ExceptionReport({ search }: { search: string }) {
  const t = useTranslations("Reports");
  const tExc = useTranslations("Reports.exceptions");
  const tCat = useTranslations("Reports.categoryValue");
  const tSev = useTranslations("Reports.severityValue");
  const query = useExceptionReport(search);
  const report = query.data;

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
      <p className="text-sm text-muted-foreground">
        {t("period")}: {report.period.label}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label={tExc("total")} value={String(report.totals.total)} />
        <SummaryCard label={tExc("open")} value={String(report.totals.open)} />
        <SummaryCard label={tExc("resolved")} value={String(report.totals.resolved)} />
        <SummaryCard
          label={tExc("avgResolution")}
          value={formatMinutes(report.totals.avgResolutionMinutes)}
        />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <BreakdownCard title={tExc("byCategory")} keyLabel={tExc("category")} countLabel={tExc("count")}>
          {report.byCategory.length === 0 ? (
            <EmptyRow label={t("empty")} />
          ) : (
            report.byCategory.map((r) => (
              <TableRow key={r.category}>
                <TableCell>{tCat(r.category)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.count}</TableCell>
              </TableRow>
            ))
          )}
        </BreakdownCard>

        <BreakdownCard title={tExc("bySeverity")} keyLabel={tExc("severity")} countLabel={tExc("count")}>
          {report.bySeverity.length === 0 ? (
            <EmptyRow label={t("empty")} />
          ) : (
            report.bySeverity.map((r) => (
              <TableRow key={r.severity}>
                <TableCell>{tSev(r.severity)}</TableCell>
                <TableCell className="text-right tabular-nums">{r.count}</TableCell>
              </TableRow>
            ))
          )}
        </BreakdownCard>
      </div>

      <Card>
        <CardHeader className="pb-2">
          <CardTitle className="text-sm font-medium text-muted-foreground">{tExc("group")}</CardTitle>
        </CardHeader>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tExc("group")}</TableHead>
                <TableHead className="text-right">{tExc("total")}</TableHead>
                <TableHead className="text-right">{tExc("open")}</TableHead>
                <TableHead className="text-right">{tExc("resolved")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={4} className="h-24 text-center text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                report.groups.map((g) => (
                  <TableRow key={g.groupKey || g.groupLabel}>
                    <TableCell>{g.groupLabel || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.total}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.open}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.resolved}</TableCell>
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

function BreakdownCard({
  title,
  keyLabel,
  countLabel,
  children,
}: {
  title: string;
  keyLabel: string;
  countLabel: string;
  children: React.ReactNode;
}) {
  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm font-medium text-muted-foreground">{title}</CardTitle>
      </CardHeader>
      <CardContent className="p-0">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>{keyLabel}</TableHead>
              <TableHead className="text-right">{countLabel}</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>{children}</TableBody>
        </Table>
      </CardContent>
    </Card>
  );
}

function EmptyRow({ label }: { label: string }) {
  return (
    <TableRow>
      <TableCell colSpan={2} className="h-16 text-center text-muted-foreground">
        {label}
      </TableCell>
    </TableRow>
  );
}
