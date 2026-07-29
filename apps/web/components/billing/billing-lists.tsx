"use client";

import Link from "next/link";
import { useState } from "react";
import { useTranslations } from "next-intl";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import { useBillingList, useFilterOptions } from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
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
import type { BillingListRow } from "@brazil-tms/db";

function brl(cents: number | null): string {
  if (cents == null) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

function ListTable({
  rows,
  t,
}: {
  rows: BillingListRow[];
  t: ReturnType<typeof useTranslations>;
}) {
  if (rows.length === 0) return <p className="text-sm text-muted-foreground">{t("empty")}</p>;
  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("customer")}</TableHead>
          <TableHead>{t("period")}</TableHead>
          <TableHead>{t("value")}</TableHead>
          <TableHead>{t("missingProof")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.tripId}>
            <TableCell>
              <Link href={`/trips/${r.tripId}`} className="font-medium underline">
                {r.externalTripId ?? r.tripId.slice(0, 8)}
              </Link>
              <div className="text-xs text-muted-foreground">{r.customerName}</div>
            </TableCell>
            <TableCell>{r.billingPeriod ?? "—"}</TableCell>
            <TableCell className="tabular-nums">{brl(r.finalBillableCents)}</TableCell>
            <TableCell>
              {r.hasMissingProof ? (
                <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs text-amber-900">
                  {t("missingProof")}
                </span>
              ) : (
                "—"
              )}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}

/** The billing pending + ready lists (008, US5). Filter customer + period. 30s polling. */
export function BillingLists({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Billing.lists");
  const [customerId, setCustomerId] = useState("");
  const [period, setPeriod] = useState("");

  const filters = { customerId: customerId || undefined, period: period || undefined };
  const pending = useBillingList("pending", filters);
  const ready = useBillingList("ready", filters);

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("pending")} / {t("ready")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 sm:max-w-lg">
          <div className="space-y-1.5">
            <Label htmlFor="bl-customer">{t("customer")}</Label>
            <Select value={customerId || undefined} onValueChange={setCustomerId}>
              <SelectTrigger id="bl-customer">
                <SelectValue placeholder="—" />
              </SelectTrigger>
              <SelectContent>
                {options.customers.map((c) => (
                  <SelectItem key={c.id} value={c.id}>
                    {c.name}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="bl-period">{t("period")}</Label>
            <Input
              id="bl-period"
              placeholder={t("periodPlaceholder")}
              value={period}
              onChange={(e) => setPeriod(e.target.value)}
            />
          </div>
        </div>

        <div>
          <h3 className="mb-2 text-sm font-medium">{t("pending")}</h3>
          <ListTable rows={pending.data?.items ?? []} t={t} />
        </div>
        <div>
          <h3 className="mb-2 text-sm font-medium">{t("ready")}</h3>
          <ListTable rows={ready.data?.items ?? []} t={t} />
        </div>
      </CardContent>
    </Card>
  );
}
