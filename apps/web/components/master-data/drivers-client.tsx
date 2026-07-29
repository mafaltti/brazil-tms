"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import type { CreateDriverInput } from "@brazil-tms/shared";
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
import { DriverForm } from "@/components/master-data/driver-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  useEntityList,
} from "@/lib/master-data/client";
import type { DriverDto } from "@/lib/master-data/drivers-service";

export function DriversClient({ canArchive }: { canArchive: boolean }) {
  const t = useTranslations("Resources.drivers");
  const tResources = useTranslations("Resources");
  const tStatus = useTranslations("ResourceStatus");
  const tMaster = useTranslations("MasterData");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const query = useEntityList<DriverDto>("drivers", { includeArchived });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "drivers"] });
  }

  function mapError(code: string | undefined): string {
    if (code === "OWNERSHIP_CARRIER_MISMATCH") return tResources("ownershipCarrierMismatch");
    return tMaster("saveError");
  }

  const createMutation = useMutation({
    mutationFn: (input: CreateDriverInput) => createEntity("drivers", input),
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
    mutationFn: (id: string) => archiveEntity("drivers", id),
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
      (d) =>
        d.name.toLowerCase().includes(term) || (d.phone ?? "").toLowerCase().includes(term),
    );
  }, [rows, search]);

  const columns: ColumnDef<DriverDto>[] = [
    { accessorKey: "name", header: () => t("name") },
    {
      accessorKey: "phone",
      header: () => t("phone"),
      cell: ({ row }) => row.original.phone ?? "—",
    },
    {
      id: "_opStatus",
      header: () => tResources("status"),
      cell: ({ row }) => <Badge variant="secondary">{tStatus(row.original.status)}</Badge>,
    },
    {
      id: "_expiry",
      header: () => t("licenseExpiry"),
      // 020 (issue #27) — the date itself + warning/expired states; null reads "Não informada".
      cell: ({ row }) => (
        <ExpiryCell date={row.original.licenseExpiry} state={row.original.documentExpiryState} />
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
        detailHref={(row) => `/resources/drivers/${row.id}`}
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
          <DriverForm
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
