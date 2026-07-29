"use client";

import { useMemo, useState } from "react";
import { useTranslations } from "next-intl";
import { ALL_AUDIT_ACTIONS, formatDateTime } from "@brazil-tms/shared";
import { useAuditLog } from "@/lib/trips/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

const COLUMN_COUNT = 7;
const PAGE = 50;
const ALL = "__all__";

/** §21.5 entity-type presets → the audit `entity_type` values the 001–008 services write. */
const PRESETS = [
  { key: "all", entityType: undefined },
  { key: "trip", entityType: "trip" },
  { key: "exception", entityType: "exception" },
  { key: "document", entityType: "document" },
  { key: "billing", entityType: "billing_item" },
  { key: "export", entityType: "export_batch" },
  { key: "user", entityType: "user" },
] as const;

interface AuditFilters {
  entityType?: string;
  entityId?: string;
  action?: string;
  actorUserId?: string;
  from?: string;
  to?: string;
}

function buildSearch(filters: AuditFilters, offset: number): string {
  const params = new URLSearchParams();
  if (filters.entityType) params.set("entityType", filters.entityType);
  if (filters.entityId) params.set("entityId", filters.entityId);
  if (filters.action) params.set("action", filters.action);
  if (filters.actorUserId) params.set("actorUserId", filters.actorUserId);
  if (filters.from) params.set("from", filters.from);
  if (filters.to) params.set("to", filters.to);
  params.set("limit", String(PAGE));
  params.set("offset", String(offset));
  return params.toString();
}

/** Compact a UUID to its first segment for at-a-glance scanning (full id stays in the title attr). */
function shortId(id: string): string {
  const [head] = id.split("-");
  return head ?? id;
}

/**
 * Audit read view (US4 — EXTENDED by 009). The Admin-only append-only audit trail with §21.5 forensic
 * filters: entity-type presets + specific entity id + action + actor + a São Paulo date range, with
 * offset pagination (TanStack Query polling, no Realtime). Renders when/action/entity/actor-name/
 * previous/new/reason. Read-only: no mutation UI (append-only, FR-019).
 */
export function AuditClient() {
  const t = useTranslations("Audit");
  const tView = useTranslations("AuditView");
  const tPreset = useTranslations("AuditView.presets");
  const tActions = useTranslations("AuditActions");
  const tCommon = useTranslations("Common");

  const [filters, setFilters] = useState<AuditFilters>({});
  const [offset, setOffset] = useState(0);
  const search = useMemo(() => buildSearch(filters, offset), [filters, offset]);

  const { data, isPending, isError } = useAuditLog(search);
  const items = data?.items ?? [];
  const total = data?.total ?? 0;

  // Any filter change resets to the first page.
  const setFilter = (key: keyof AuditFilters, value: string | undefined) => {
    setOffset(0);
    setFilters((prev) => ({ ...prev, [key]: value || undefined }));
  };
  const clearAll = () => {
    setOffset(0);
    setFilters({});
  };

  function snapshot(value: Record<string, unknown> | null): string {
    return value == null ? tCommon("none") : JSON.stringify(value);
  }

  const start = total === 0 ? 0 : offset + 1;
  const end = offset + items.length;
  const canPrev = offset > 0;
  const canNext = offset + items.length < total;

  // Action options: the canonical audit-action set with pt-BR labels (flat AuditActions lookup).
  const actionOptions = ALL_AUDIT_ACTIONS.map((a) => ({
    value: a,
    label: tActions(a.replaceAll(".", "_")),
  })).sort((x, y) => x.label.localeCompare(y.label, "pt-BR"));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("title")}</CardTitle>
        <p className="text-sm text-muted-foreground">{t("subtitle")}</p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Entity-type presets (§21.5 record types). */}
        <div className="flex flex-wrap gap-1">
          {PRESETS.map((p) => {
            const active = (filters.entityType ?? undefined) === p.entityType;
            return (
              <Button
                key={p.key}
                type="button"
                size="sm"
                variant={active ? "default" : "outline"}
                onClick={() => setFilter("entityType", p.entityType)}
                className={cn(!active && "text-muted-foreground")}
              >
                {tPreset(p.key)}
              </Button>
            );
          })}
        </div>

        {/* Action + entity-id + actor + date-range filters. */}
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6">
          <Field id="audit-f-action" label={tView("action")}>
            <Select
              value={filters.action ?? ALL}
              onValueChange={(v) => setFilter("action", v === ALL ? undefined : v)}
            >
              <SelectTrigger id="audit-f-action">
                <SelectValue placeholder={tView("actionAll")} />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value={ALL}>{tView("actionAll")}</SelectItem>
                {actionOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>
                    {o.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </Field>
          <Field id="audit-f-entity" label={tView("entityId")}>
            <Input
              id="audit-f-entity"
              value={filters.entityId ?? ""}
              placeholder={tView("entityIdPlaceholder")}
              onChange={(e) => setFilter("entityId", e.target.value)}
            />
          </Field>
          <Field id="audit-f-actor" label={tView("actor")}>
            <Input
              id="audit-f-actor"
              value={filters.actorUserId ?? ""}
              placeholder={tView("actorPlaceholder")}
              onChange={(e) => setFilter("actorUserId", e.target.value)}
            />
          </Field>
          <Field id="audit-f-from" label={tView("from")}>
            <Input
              id="audit-f-from"
              type="date"
              value={filters.from ?? ""}
              onChange={(e) => setFilter("from", e.target.value)}
            />
          </Field>
          <Field id="audit-f-to" label={tView("to")}>
            <Input
              id="audit-f-to"
              type="date"
              value={filters.to ?? ""}
              onChange={(e) => setFilter("to", e.target.value)}
            />
          </Field>
          <div className="flex items-end">
            <Button variant="ghost" size="sm" onClick={clearAll}>
              {tView("clear")}
            </Button>
          </div>
        </div>

        {isError ? (
          <p className="text-sm text-destructive">{t("loadError")}</p>
        ) : (
          <>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>{t("when")}</TableHead>
                  <TableHead>{t("action")}</TableHead>
                  <TableHead>{t("entity")}</TableHead>
                  <TableHead>{t("actor")}</TableHead>
                  <TableHead>{t("previous")}</TableHead>
                  <TableHead>{t("new")}</TableHead>
                  <TableHead>{t("reason")}</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {isPending ? (
                  Array.from({ length: 5 }).map((_, i) => (
                    <TableRow key={i}>
                      {Array.from({ length: COLUMN_COUNT }).map((__, j) => (
                        <TableCell key={j}>
                          <Skeleton className="h-4 w-full" />
                        </TableCell>
                      ))}
                    </TableRow>
                  ))
                ) : items.length === 0 ? (
                  <TableRow>
                    <TableCell
                      colSpan={COLUMN_COUNT}
                      className="py-8 text-center text-muted-foreground"
                    >
                      {t("empty")}
                    </TableCell>
                  </TableRow>
                ) : (
                  items.map((entry) => (
                    <TableRow key={entry.id}>
                      <TableCell className="whitespace-nowrap">
                        {formatDateTime(entry.createdAt)}
                      </TableCell>
                      <TableCell>
                        <Badge variant="secondary">
                          {tActions(entry.action.replaceAll(".", "_"))}
                        </Badge>
                      </TableCell>
                      <TableCell className="whitespace-nowrap">
                        <span>{entry.entityType}</span>{" "}
                        <span
                          className="font-mono text-xs text-muted-foreground"
                          title={entry.entityId}
                        >
                          {shortId(entry.entityId)}
                        </span>
                      </TableCell>
                      <TableCell className="whitespace-nowrap" title={entry.actorUserId}>
                        {entry.actorName ?? shortId(entry.actorUserId)}
                      </TableCell>
                      <TableCell className="max-w-xs truncate font-mono text-xs">
                        {snapshot(entry.previousValue)}
                      </TableCell>
                      <TableCell className="max-w-xs truncate font-mono text-xs">
                        {snapshot(entry.newValue)}
                      </TableCell>
                      <TableCell>{entry.reason ?? tCommon("none")}</TableCell>
                    </TableRow>
                  ))
                )}
              </TableBody>
            </Table>

            {!isPending && total > 0 ? (
              <div className="flex items-center justify-between text-sm text-muted-foreground">
                <span>{tView("showingRange", { start, end, total })}</span>
                <div className="flex gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canPrev}
                    onClick={() => setOffset((n) => Math.max(0, n - PAGE))}
                  >
                    {tView("previous")}
                  </Button>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!canNext}
                    onClick={() => setOffset((n) => n + PAGE)}
                  >
                    {tView("next")}
                  </Button>
                </div>
              </div>
            ) : null}
          </>
        )}
      </CardContent>
    </Card>
  );
}

function Field({ id, label, children }: { id: string; label: string; children: React.ReactNode }) {
  return (
    <div className="space-y-1.5">
      <label className="text-sm font-medium" htmlFor={id}>
        {label}
      </label>
      {children}
    </div>
  );
}
