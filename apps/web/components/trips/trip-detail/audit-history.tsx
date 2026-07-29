import { useTranslations } from "next-intl";
import { formatDateTime } from "@brazil-tms/shared";
import type { TripDetailView } from "@brazil-tms/db";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Read-only audit history (005 US2): immutable `trip.*` audit rows newest-first. Known actions map
 * via `Trips.auditActions`; unknown actions fall back to the raw action string (`t.has` guard).
 * Presentational (isomorphic `useTranslations`, no `"use client"`).
 */
export function AuditHistorySection({ audit }: { audit: TripDetailView["audit"] }) {
  const t = useTranslations("Trips.detail");
  const tActions = useTranslations("Trips.auditActions");

  const ordered = [...audit].sort((a, b) => b.createdAt.localeCompare(a.createdAt));

  // Known `trip.*` actions are translated; any other (later-slice) action falls back to the raw
  // string (`t.has` guard). The call arg is cast to the translator's key type — `has` accepts a plain
  // string, but the `t()` overload is typed to the known keys.
  const actionLabel = (action: string) =>
    tActions.has(action) ? tActions(action as Parameters<typeof tActions>[0]) : action;

  return (
    <Card>
      <CardHeader>
        <CardTitle>{t("sectionAudit")}</CardTitle>
      </CardHeader>
      <CardContent>
        {ordered.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t("auditEmpty")}</p>
        ) : (
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("auditAction")}</TableHead>
                <TableHead>{t("auditActor")}</TableHead>
                <TableHead>{t("auditWhen")}</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {ordered.map((entry) => (
                <TableRow key={entry.id}>
                  <TableCell>{actionLabel(entry.action)}</TableCell>
                  <TableCell className="text-muted-foreground">{entry.actorUserId}</TableCell>
                  <TableCell className="whitespace-nowrap">
                    {formatDateTime(entry.createdAt)}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>
    </Card>
  );
}
