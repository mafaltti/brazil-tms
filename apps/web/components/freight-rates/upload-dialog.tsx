"use client";

import { useRef, useState } from "react";
import { useTranslations } from "next-intl";
import { Upload } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { FreightRateError, useImportFreightRates } from "@/lib/freight-rates/client";

/**
 * 016 US2 — replace-all upload of the standard sheet. Rendered only for holders of
 * `import_freight_rates` (page passes `canImport`); the BFF stays authoritative. A rejected file
 * changes nothing: the row/column issues from the 409 are listed for correction in the sheet.
 */
export function FreightRatesUploadDialog() {
  const t = useTranslations("FreightRates.upload");
  const [open, setOpen] = useState(false);
  const fileRef = useRef<HTMLInputElement>(null);
  const importMutation = useImportFreightRates();

  const error =
    importMutation.error instanceof FreightRateError ? importMutation.error : null;

  function handleOpenChange(next: boolean) {
    setOpen(next);
    if (!next) importMutation.reset();
  }

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const file = fileRef.current?.files?.[0];
    if (file) importMutation.mutate(file);
  }

  return (
    <Dialog open={open} onOpenChange={handleOpenChange}>
      <DialogTrigger asChild>
        <Button>
          <Upload className="mr-2 h-4 w-4" />
          {t("trigger")}
        </Button>
      </DialogTrigger>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{t("title")}</DialogTitle>
          <DialogDescription>{t("description")}</DialogDescription>
        </DialogHeader>
        <form onSubmit={handleSubmit} className="space-y-4">
          <Input ref={fileRef} type="file" accept=".xlsx" required disabled={importMutation.isPending} />
          {importMutation.isSuccess ? (
            <p className="text-sm text-emerald-600" role="status">
              {t("success", {
                routes: importMutation.data.routeCount,
                rates: importMutation.data.rateCount,
              })}
            </p>
          ) : null}
          {error ? (
            <div className="space-y-2" role="alert">
              <p className="text-sm text-destructive">{error.message}</p>
              {error.findings && error.findings.length > 0 ? (
                <div className="max-h-56 overflow-y-auto rounded-md border">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>{t("issueRow")}</TableHead>
                        <TableHead>{t("issueColumn")}</TableHead>
                        <TableHead>{t("issueMessage")}</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {error.findings.map((issue, i) => (
                        <TableRow key={`${issue.row}-${issue.column}-${i}`}>
                          <TableCell>{issue.row}</TableCell>
                          <TableCell>{issue.column}</TableCell>
                          <TableCell>{issue.message}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              ) : null}
            </div>
          ) : null}
          <DialogFooter>
            <Button type="submit" disabled={importMutation.isPending}>
              {importMutation.isPending ? t("submitting") : t("submit")}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
