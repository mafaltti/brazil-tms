"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import type { CreateCarrierInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MasterDataTable } from "@/components/master-data/master-data-table";
import { CarrierForm } from "@/components/master-data/carrier-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  useEntityList,
} from "@/lib/master-data/client";
import type { CarrierDto } from "@/lib/master-data/carriers-service";

export function CarriersClient({ canArchive }: { canArchive: boolean }) {
  const t = useTranslations("Resources.carriers");
  const tResources = useTranslations("Resources");
  const tMaster = useTranslations("MasterData");
  const tContract = useTranslations("CarrierContractStatus");
  const tDoc = useTranslations("CarrierDocStatus");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const query = useEntityList<CarrierDto>("carriers", { includeArchived });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "carriers"] });
  }

  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_TAX_ID") return tResources("duplicateTaxId");
    return tMaster("saveError");
  }

  const createMutation = useMutation({
    mutationFn: (input: CreateCarrierInput) => createEntity("carriers", input),
    onSuccess: () => {
      setCreateOpen(false);
      setCreateError(null);
      setFeedback(t("created"));
      invalidate();
    },
    onError: (e: Error) => {
      setCreateError(mapError(e instanceof MasterDataError ? e.code : undefined));
    },
  });

  const archiveMutation = useMutation({
    mutationFn: (id: string) => archiveEntity("carriers", id),
    onSuccess: () => {
      setFeedback(t("archivedMsg"));
      invalidate();
    },
    onSettled: () => setArchivingId(null),
  });

  const rows = query.data ?? [];
  const filtered = useMemo(() => {
    const term = search.trim().toLowerCase();
    if (!term) return rows;
    return rows.filter(
      (c) =>
        c.name.toLowerCase().includes(term) || (c.taxId ?? "").toLowerCase().includes(term),
    );
  }, [rows, search]);

  const columns: ColumnDef<CarrierDto>[] = [
    { accessorKey: "name", header: () => t("name") },
    {
      accessorKey: "taxId",
      header: () => t("taxId"),
      cell: ({ row }) => row.original.taxId ?? "—",
    },
    {
      accessorKey: "contractStatus",
      header: () => t("contractStatus"),
      cell: ({ row }) => tContract(row.original.contractStatus),
    },
    {
      accessorKey: "documentationStatus",
      header: () => t("documentationStatus"),
      cell: ({ row }) => tDoc(row.original.documentationStatus),
    },
  ];

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold">{t("title")}</h1>
          <p className="text-muted-foreground">{t("subtitle")}</p>
        </div>
        <Button
          onClick={() => {
            setCreateError(null);
            setCreateOpen(true);
          }}
        >
          {t("new")}
        </Button>
      </div>

      {feedback ? (
        <p role="status" className="text-sm text-muted-foreground">
          {feedback}
        </p>
      ) : null}

      <MasterDataTable
        rows={filtered}
        columns={columns}
        isLoading={query.isLoading}
        isError={query.isError}
        search={search}
        onSearchChange={setSearch}
        searchPlaceholder={t("searchPlaceholder")}
        includeArchived={includeArchived}
        onIncludeArchivedChange={setIncludeArchived}
        detailHref={(row) => `/resources/carriers/${row.id}`}
        canArchive={canArchive}
        archivingId={archivingId}
        onArchive={(row) => {
          setArchivingId(row.id);
          archiveMutation.mutate(row.id);
        }}
      />

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-h-[85vh] overflow-y-auto">
          <DialogHeader>
            <DialogTitle>{t("create")}</DialogTitle>
            <DialogDescription>{t("subtitle")}</DialogDescription>
          </DialogHeader>
          <CarrierForm
            submitting={createMutation.isPending}
            errorMessage={createError}
            submitLabel={t("create")}
            onCancel={() => setCreateOpen(false)}
            onSubmit={(values) => createMutation.mutate(values)}
          />
        </DialogContent>
      </Dialog>
    </div>
  );
}
