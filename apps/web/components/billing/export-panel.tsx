"use client";

import { useState } from "react";
import { useTranslations } from "next-intl";
import { EXPORT_FORMATS, formatDateTime } from "@brazil-tms/shared";
import type { TripFilterOptions } from "@/lib/trips/trips-read";
import {
  TripsError,
  fetchExportDownloadUrl,
  useCreateExport,
  useExportBatches,
  useFilterOptions,
} from "@/lib/trips/client";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

function brl(cents: number): string {
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(cents / 100);
}

/**
 * Billing export action + export-batch history (008, US5). Trigger an export (customer + period +
 * format) — the worker generates the file off the request path — and download prior batches. Notes the
 * labeled default column set + export sign-off blocked (§29 Input #4). Export writes gated `export_billing`.
 */
export function ExportPanel({ options: initialOptions }: { options: TripFilterOptions }) {
  // 019 — keep the lists fresh on an open tab (60s poll + focus refetch); server data seeds it.
  const options = useFilterOptions(initialOptions);
  const t = useTranslations("Billing.export");
  const create = useCreateExport();
  const history = useExportBatches();

  const [customerId, setCustomerId] = useState("");
  const [period, setPeriod] = useState("");
  const [format, setFormat] = useState<(typeof EXPORT_FORMATS)[number]>("xlsx");
  const [error, setError] = useState<string | null>(null);

  const batches = history.data?.items ?? [];

  const mapError = (e: unknown): string => {
    const code = e instanceof TripsError ? e.code : "REQUEST_FAILED";
    try {
      return t(`errors.${code}` as Parameters<typeof t>[0]);
    } catch {
      return code;
    }
  };

  const onGenerate = () => {
    setError(null);
    if (!customerId || !/^\d{4}-\d{2}$/.test(period)) return;
    create.mutate({ customerId, billingPeriod: period, format }, { onError: (e) => setError(mapError(e)) });
  };

  const onDownload = async (id: string) => {
    try {
      const url = await fetchExportDownloadUrl(id);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      setError(mapError(e));
    }
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-5">
        <p className="text-xs text-amber-700">{t("signOffBlocked")}</p>

        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3 sm:max-w-2xl">
          <div className="space-y-1.5">
            <Label htmlFor="ex-customer">{t("customer")}</Label>
            <Select value={customerId || undefined} onValueChange={setCustomerId}>
              <SelectTrigger id="ex-customer">
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
            <Label htmlFor="ex-period">{t("period")}</Label>
            <Input id="ex-period" placeholder={t("periodPlaceholder")} value={period} onChange={(e) => setPeriod(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="ex-format">{t("format")}</Label>
            <Select value={format} onValueChange={(v) => setFormat(v as (typeof EXPORT_FORMATS)[number])}>
              <SelectTrigger id="ex-format">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {EXPORT_FORMATS.map((f) => (
                  <SelectItem key={f} value={f}>
                    {f.toUpperCase()}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
        <Button
          size="sm"
          onClick={onGenerate}
          disabled={create.isPending || !customerId || !/^\d{4}-\d{2}$/.test(period)}
        >
          {create.isPending ? t("generating") : t("generate")}
        </Button>

        <div>
          <h3 className="mb-2 text-sm font-medium">{t("history")}</h3>
          {batches.length === 0 ? (
            <p className="text-sm text-muted-foreground">—</p>
          ) : (
            <ul className="space-y-2">
              {batches.map((b) => (
                <li key={b.id} className="flex flex-wrap items-center gap-3 rounded-md border p-2 text-sm">
                  <span className="font-medium">{b.customerName}</span>
                  <span className="text-muted-foreground">{b.billingPeriod}</span>
                  <span className="uppercase text-muted-foreground">{b.format}</span>
                  <span>
                    {(() => {
                      try {
                        return t(`statuses.${b.status}` as Parameters<typeof t>[0]);
                      } catch {
                        return b.status;
                      }
                    })()}
                  </span>
                  <span className="text-muted-foreground">
                    {b.tripCount} · {brl(b.totalAmountCents)}
                  </span>
                  <span className="text-xs text-muted-foreground">{formatDateTime(b.createdAt)}</span>
                  {b.status === "completed" ? (
                    <Button size="sm" variant="outline" className="ml-auto" onClick={() => onDownload(b.id)}>
                      {t("download")}
                    </Button>
                  ) : null}
                </li>
              ))}
            </ul>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
