"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { useExceptions, useFilterOptions } from "@/lib/trips/client";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ExceptionFilters, type ExceptionFiltersValue } from "@/components/exceptions/exception-filters";

/**
 * Exception Management queue (007, US2). Filterable list of exceptions across all trips
 * (severity/status/customer/lane/reason/owner/age) backed by `useExceptions`, polled on the
 * control-tower cadence. Each row links to its trip. pt-BR throughout.
 */

const SEVERITY_CLASS: Record<string, string> = {
  low: "bg-muted text-muted-foreground",
  medium: "bg-amber-100 text-amber-900",
  high: "bg-destructive/15 text-destructive",
};
const STATUS_CLASS: Record<string, string> = {
  open: "bg-amber-100 text-amber-900",
  monitoring: "bg-blue-100 text-blue-900",
  resolved: "bg-emerald-100 text-emerald-900",
  cancelled: "bg-muted text-muted-foreground",
};

function Pill({ text, cls }: { text: string; cls: string }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${cls}`}>
      {text}
    </span>
  );
}

function toSearch(value: ExceptionFiltersValue): string {
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(value)) {
    if (v != null && v !== "") params.set(k, v);
  }
  return params.toString();
}

export function ExceptionTable({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Exceptions");
  const [filters, setFilters] = useState<ExceptionFiltersValue>({});
  const search = useMemo(() => toSearch(filters), [filters]);
  const query = useExceptions(search);

  const items = query.data?.items ?? [];

  return (
    <div className="space-y-4">
      <ExceptionFilters value={filters} onChange={setFilters} options={options} />

      {query.isLoading ? (
        <Skeleton className="h-96 w-full" />
      ) : query.isError ? (
        <p role="alert" className="text-sm text-destructive">
          {t("loadError")}
        </p>
      ) : (
        <Card>
          <CardContent className="p-0">
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("trip")}</TableHead>
                  <TableHead>{t("filters.customer")}</TableHead>
                  <TableHead>{t("reasonCode")}</TableHead>
                  <TableHead>{t("category")}</TableHead>
                  <TableHead>{t("severity")}</TableHead>
                  <TableHead>{t("status")}</TableHead>
                  <TableHead>{t("responsibleParty")}</TableHead>
                  <TableHead>{t("owner")}</TableHead>
                  <TableHead>{t("openedAt")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {items.length === 0 ? (
                  <TableRow>
                    <TableCell colSpan={9} className="h-24 text-center text-muted-foreground">
                      {t("empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((exc) => (
                    <TableRow key={exc.id}>
                      <TableCell>
                        <Link href={`/trips/${exc.tripId}`} className="font-medium text-primary hover:underline">
                          {exc.externalTripId ?? exc.tripId.slice(0, 8)}
                        </Link>
                      </TableCell>
                      <TableCell>{exc.customerName ?? "—"}</TableCell>
                      <TableCell>{exc.reasonLabelPt}</TableCell>
                      <TableCell className="text-muted-foreground">
                        {t(`categoryValue.${exc.category}` as Parameters<typeof t>[0])}
                      </TableCell>
                      <TableCell>
                        <Pill text={t(`severityValue.${exc.severity}` as Parameters<typeof t>[0])} cls={SEVERITY_CLASS[exc.severity] ?? ""} />
                      </TableCell>
                      <TableCell>
                        <Pill text={t(`statusValue.${exc.status}` as Parameters<typeof t>[0])} cls={STATUS_CLASS[exc.status] ?? ""} />
                      </TableCell>
                      <TableCell className="text-muted-foreground">
                        {t(`responsiblePartyValue.${exc.responsibleParty}` as Parameters<typeof t>[0])}
                      </TableCell>
                      <TableCell>{exc.ownerName ?? "—"}</TableCell>
                      <TableCell className="whitespace-nowrap">{formatDateTime(exc.openedAt)}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
