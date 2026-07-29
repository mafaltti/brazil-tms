"use client";

import Link from "next/link";
import { useTranslations } from "next-intl";
import { useTripBoard } from "@/lib/trips/client";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

/**
 * Documents screen list (008, US1). The billing-phase trips still missing a required-for-billing
 * document (reusing the board `missingDocuments` read), deep-linking to each trip detail where the
 * proof is attached/verified. 30s polling via `useTripBoard`.
 */
export function DocumentList() {
  const t = useTranslations("Documents");
  const tStatus = useTranslations("Status");
  const { data, isLoading } = useTripBoard("missingDocuments=true&limit=200");
  const rows = data?.items ?? [];

  if (isLoading) {
    return <p className="text-sm text-muted-foreground">…</p>;
  }
  if (rows.length === 0) {
    return <p className="text-sm text-muted-foreground">{t("missingNone")}</p>;
  }

  return (
    <Table>
      <TableHeader>
        <TableRow>
          <TableHead>{t("colTrip")}</TableHead>
          <TableHead>{t("colCustomer")}</TableHead>
          <TableHead>{t("colLane")}</TableHead>
          <TableHead>{t("colStatus")}</TableHead>
        </TableRow>
      </TableHeader>
      <TableBody>
        {rows.map((r) => (
          <TableRow key={r.id}>
            <TableCell>
              <Link href={`/trips/${r.id}`} className="font-medium underline">
                {r.externalTripId ?? r.id.slice(0, 8)}
              </Link>
            </TableCell>
            <TableCell>{r.customerName}</TableCell>
            <TableCell>{r.laneLabel ?? "—"}</TableCell>
            <TableCell>
              {(() => {
                try {
                  return tStatus(r.currentStatus as Parameters<typeof tStatus>[0]);
                } catch {
                  return r.currentStatus;
                }
              })()}
            </TableCell>
          </TableRow>
        ))}
      </TableBody>
    </Table>
  );
}
