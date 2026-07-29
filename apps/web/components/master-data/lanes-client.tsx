"use client";

import { useMemo, useState } from "react";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useTranslations } from "next-intl";
import type { ColumnDef } from "@tanstack/react-table";
import type { CreateLaneInput } from "@brazil-tms/shared";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { MasterDataTable } from "@/components/master-data/master-data-table";
import { LaneForm } from "@/components/master-data/lane-form";
import {
  archiveEntity,
  createEntity,
  MasterDataError,
  useEntityList,
} from "@/lib/master-data/client";
import type { LaneDto } from "@/lib/master-data/lanes-service";
import type { CustomerDto } from "@/lib/master-data/customers-service";
import type { LocationDto } from "@/lib/master-data/locations-service";

export function LanesClient({ canArchive }: { canArchive: boolean }) {
  const t = useTranslations("MasterData.lanes");
  const tMaster = useTranslations("MasterData");
  const queryClient = useQueryClient();

  const [search, setSearch] = useState("");
  const [includeArchived, setIncludeArchived] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createError, setCreateError] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [archivingId, setArchivingId] = useState<string | null>(null);

  const query = useEntityList<LaneDto>("lanes", { includeArchived });
  // Customer + location names for the table's reference columns.
  const customers = useEntityList<CustomerDto>("customers", {});
  const locations = useEntityList<LocationDto>("locations", { includeArchived: true });

  function invalidate() {
    void queryClient.invalidateQueries({ queryKey: ["master-data", "lanes"] });
  }

  function mapError(code: string | undefined): string {
    if (code === "INVALID_LANE_REFERENCE") return t("invalidReference");
    return tMaster("saveError");
  }

  const customerName = useMemo(() => {
    const byId = new Map((customers.data ?? []).map((c) => [c.id, c.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [customers.data]);

  const locationName = useMemo(() => {
    const byId = new Map((locations.data ?? []).map((l) => [l.id, l.name]));
    return (id: string) => byId.get(id) ?? "—";
  }, [locations.data]);

  const createMutation = useMutation({
    mutationFn: (input: CreateLaneInput) => createEntity("lanes", input),
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
    mutationFn: (id: string) => archiveEntity("lanes", id),
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
      (l) =>
        customerName(l.customerId).toLowerCase().includes(term) ||
        locationName(l.originLocationId).toLowerCase().includes(term) ||
        locationName(l.destinationLocationId).toLowerCase().includes(term),
    );
  }, [rows, search, customerName, locationName]);

  const columns: ColumnDef<LaneDto>[] = [
    {
      accessorKey: "customerId",
      header: () => t("customer"),
      cell: ({ row }) => customerName(row.original.customerId),
    },
    {
      accessorKey: "originLocationId",
      header: () => t("origin"),
      cell: ({ row }) => locationName(row.original.originLocationId),
    },
    {
      accessorKey: "destinationLocationId",
      header: () => t("destination"),
      cell: ({ row }) => locationName(row.original.destinationLocationId),
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
        detailHref={(row) => `/admin/lanes/${row.id}`}
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
          <LaneForm
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
