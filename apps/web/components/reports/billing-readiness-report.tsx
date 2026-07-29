"use client";

import { useTranslations } from "next-intl";
import { useBillingReadinessReport } from "@/lib/trips/client";
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
 * Feature 009 — billing-readiness report (US3, REP-004). Summary cards (phase counts, completed-missing-
 * documents, % ready within 24h) + a per-customer table + the provisional banner when a customer runs
 * on default document/billing rules. Tables + cards only (R7). Read-only, polled. pt-BR throughout.
 */

export function BillingReadinessReport({ search }: { search: string }) {
  const t = useTranslations("Reports");
  const tBill = useTranslations("Reports.billing");
  const query = useBillingReadinessReport(search);
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

  const pct = report.pctReadyWithin24h == null ? "—" : `${report.pctReadyWithin24h}%`;

  return (
    <div className="space-y-4">
      {report.provisional ? <ProvisionalBanner reason={report.provisionalReason} /> : null}

      <p className="text-sm text-muted-foreground">
        {t("period")}: {report.period.label}
      </p>

      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
        <SummaryCard label={tBill("billing_pending")} value={String(report.phaseCounts.billing_pending)} />
        <SummaryCard label={tBill("billing_ready")} value={String(report.phaseCounts.billing_ready)} />
        <SummaryCard label={tBill("billed")} value={String(report.phaseCounts.billed)} />
        <SummaryCard label={tBill("disputed")} value={String(report.phaseCounts.disputed)} />
        <SummaryCard
          label={tBill("completedMissingDocuments")}
          value={String(report.completedMissingDocuments)}
        />
        <SummaryCard label={tBill("pctReadyWithin24h")} value={pct} />
      </div>

      <Card>
        <CardContent className="p-0">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{tBill("customer")}</TableHead>
                <TableHead className="text-right">{tBill("billing_pending")}</TableHead>
                <TableHead className="text-right">{tBill("billing_ready")}</TableHead>
                <TableHead className="text-right">{tBill("billed")}</TableHead>
                <TableHead className="text-right">{tBill("disputed")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {report.groups.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="h-24 text-center text-muted-foreground">
                    {t("empty")}
                  </TableCell>
                </TableRow>
              ) : (
                report.groups.map((g) => (
                  <TableRow key={g.groupKey || g.groupLabel}>
                    <TableCell>{g.groupLabel || "—"}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.billing_pending}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.billing_ready}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.billed}</TableCell>
                    <TableCell className="text-right tabular-nums">{g.disputed}</TableCell>
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
