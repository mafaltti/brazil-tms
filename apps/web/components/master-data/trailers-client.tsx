"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import type { CreateTrailerInput } from "@brazil-tms/shared";
import { Badge } from "@/components/ui/badge";
import { ExpiryCell } from "@/components/master-data/expiry-cell";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MasterDataTable } from "@/components/master-data/master-data-table";
import { TrailerForm } from "@/components/master-data/trailer-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  useEntityList,
} from "@/lib/master-data/client";
import type { TrailerDto } from "@/lib/master-data/trailers-service";

export function TrailersClient({ canArchive }: { canArchive: boolean }) {
  const t = useTranslations("Resources.trailers");
  const tResources = useTranslations("Resources");
  const tStatus = useTranslations("ResourceStatus");
  const tTypes = useTranslations("TrailerTypes");
  const tMaster = useTranslations("MasterData");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const query = useEntityList<TrailerDto>("trailers", { includeArchived });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "trailers"] });
  }

  function mapError(code: string | undefined): string {
    if (code === "DUPLICATE_PLATE") return tResources("duplicatePlate");
    if (code === "OWNERSHIP_CARRIER_MISMATCH") return tResources("ownershipCarrierMismatch");
    return tMaster("saveError");
  }

  const createMutation = useMutation({
    mutationFn: (input: CreateTrailerInput) => createEntity("trailers", input),
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
    mutationFn: (id: string) => archiveEntity("trailers", id),
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
    return rows.filter((tr) => tr.plate.toLowerCase().includes(term));
  }, [rows, search]);

  const columns: ColumnDef<TrailerDto>[] = [
    { accessorKey: "plate", header: () => t("plate") },
    {
      accessorKey: "trailerType",
      header: () => t("trailerType"),
      cell: ({ row }) => tTypes(row.original.trailerType),
    },
    {
      id: "_opStatus",
      header: () => tResources("status"),
      cell: ({ row }) => <Badge variant="secondary">{tStatus(row.original.status)}</Badge>,
    },
    {
      id: "_expiry",
      header: () => t("documentExpiry"),
      // 020 (issue #27) — the date itself + warning/expired states; null reads "Não informada".
      cell: ({ row }) => (
        <ExpiryCell date={row.original.documentExpiry} state={row.original.documentExpiryState} />
      ),
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
        detailHref={(row) => `/resources/trailers/${row.id}`}
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
          <TrailerForm
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
