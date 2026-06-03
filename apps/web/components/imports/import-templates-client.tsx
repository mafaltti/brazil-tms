"use client";

import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
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
import {
  useImportTemplates,
  type ImportTemplateDto,
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

/**
 * Import Templates administration (slice 012). Lists a selected customer's templates and (per story)
 * creates / edits / versions / activates / archives them via the EXISTING `/api/import-templates`
 * endpoints. Freshness is TanStack Query polling; NO Realtime. Authorization is enforced by the BFF +
 * the server-component guard (`import_trips`); this screen only composes UI.
 */
export function ImportTemplatesClient() {
  const t = useTranslations("ImportTemplates");

  const [customerId, setCustomerId] = useState<string>("");
  const [includeArchived, setIncludeArchived] = useState(false);

  // Customers — reuse the master-data query key/endpoint so the cache is shared with Trip Import.
  const customersQuery = useQuery({
    queryKey: ["master-data", "customers"],
    queryFn: () =>
      fetchJson<{ items: CustomerOption[] }>("/api/master-data/customers").then((b) => b.items),
    staleTime: 30_000,
  });

  const templatesQuery = useImportTemplates(customerId, includeArchived);
  const rows = templatesQuery.data ?? [];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button disabled={!customerId}>{t("new")}</Button>
      </div>

      <div className="flex flex-wrap items-end gap-4">
        <div className="space-y-2">
          <Label htmlFor="template-customer">{t("customer")}</Label>
          <Select
            value={customerId}
            onValueChange={setCustomerId}
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

      {!customerId ? (
        <p className="text-sm text-muted-foreground">{t("selectCustomerPrompt")}</p>
      ) : (
        <TemplateList query={templatesQuery} rows={rows} />
      )}
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
}: {
  query: ReturnType<typeof useImportTemplates>;
  rows: ImportTemplateDto[];
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
            </TableRow>
          );
        })}
      </TableBody>
    </Table>
  );
}
