"use client";

import { useState } from "react";
import Link from "next/link";
import { ArrowDown, ArrowUp, ArrowUpDown, Check, X } from "lucide-react";
import {
  flexRender,
  getCoreRowModel,
  useReactTable,
  type ColumnDef,
} from "@tanstack/react-table";
import { useTranslations } from "next-intl";
import {
  formatDateTime,
  VEHICLE_TYPE_VALUES,
  type TripBoardQuery,
  type VehicleType,
} from "@brazil-tms/shared";
import type { TripBoardRow, TripFilterOptions } from "@brazil-tms/db";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { TripStatusBadge } from "@/components/trips/trip-status-badge";
import { TripFilters } from "@/components/trips/trip-filters";
import { AssignmentForm } from "@/components/trips/dispatch/assignment-form";
import { CancelTripDialog } from "@/components/trips/cancel-trip-dialog";
import { canCancelTrip, type CancelScope } from "@/lib/trips/cancel-scope";
import { useFilterOptions, useTripBoard, useTripBoardFilters } from "@/lib/trips/client";

/** Board `sort` values that map to a column header (R2 whitelist). */
type SortKey = TripBoardQuery["sort"];

/**
 * The Control Tower board (feature 005, US1): filters + a dense server-side
 * filtered/sorted/paginated TanStack Table + a pagination footer. URL is the source of truth
 * (`useTripBoardFilters`); data freshness is TanStack Query polling (`useTripBoard`), never
 * Realtime. Each row links to the Trip Detail page. Only the five whitelisted columns are sortable;
 * later-slice dimensions (assignment → 006, SLA risk → 007, documents/billing detail → 008) are not
 * rendered as filterable/sortable columns here.
 */
export function ControlTowerTable({
  filterOptions: initialFilterOptions,
  canAssign = false,
  cancelScope = "none",
}: {
  filterOptions: TripFilterOptions;
  /** 006 — additively reveal the per-row quick-assign action for `assign_resources` holders. */
  canAssign?: boolean;
  /** 017 — how far this user's cancel permission reaches (§18); computed server-side. */
  cancelScope?: CancelScope;
}) {
  // 019 — keep filters + quick-assign pickers fresh on an open tab; server data seeds it.
  const filterOptions = useFilterOptions(initialFilterOptions);
  const t = useTranslations("Trips");
  const tCommon = useTranslations("Common");
  const tVehicle = useTranslations("VehicleTypes");
  const tDispatch = useTranslations("Dispatch");
  const tCancel = useTranslations("Trips.cancel");
  const { query, search, setFilters, reset } = useTripBoardFilters();

  // The row whose quick-assign dialog is open (006, T063). One dialog instance, fed the row in scope.
  const [assignRow, setAssignRow] = useState<TripBoardRow | null>(null);
  // The row whose cancel dialog is open (017). Same one-instance pattern.
  const [cancelRow, setCancelRow] = useState<TripBoardRow | null>(null);

  /** Label a (possibly unknown) vehicle-type string via the `VehicleTypes` namespace; "—" if absent. */
  function vehicleLabel(vt: string | null): string {
    if (vt && (VEHICLE_TYPE_VALUES as readonly string[]).includes(vt)) {
      return tVehicle(vt as VehicleType);
    }
    return "—";
  }
  const board = useTripBoard(search);

  const items = board.data?.items ?? [];
  const total = board.data?.total ?? 0;
  const limit = query.limit;
  const offset = query.offset;

  function toggleSort(key: SortKey) {
    if (query.sort === key) {
      setFilters({ sort: key, dir: query.dir === "asc" ? "desc" : "asc" });
    } else {
      setFilters({ sort: key, dir: "asc" });
    }
  }

  /** A clickable, sortable column header with an asc/desc/neutral indicator. */
  function SortableHeader({ label, sortKey }: { label: string; sortKey: SortKey }) {
    const active = query.sort === sortKey;
    const Icon = !active ? ArrowUpDown : query.dir === "asc" ? ArrowUp : ArrowDown;
    return (
      <button
        type="button"
        className="-ml-1 inline-flex items-center gap-1 rounded px-1 py-0.5 hover:bg-muted"
        onClick={() => toggleSort(sortKey)}
        aria-label={label}
      >
        {label}
        <Icon className={active ? "h-3.5 w-3.5" : "h-3.5 w-3.5 opacity-40"} aria-hidden />
      </button>
    );
  }

  const columns: ColumnDef<TripBoardRow>[] = [
    {
      id: "externalTripId",
      header: () => t("board.colExternalId"),
      cell: ({ row }) => (
        <Link href={`/trips/${row.original.id}`} className="font-medium text-primary hover:underline">
          {row.original.externalTripId ?? "—"}
        </Link>
      ),
    },
    {
      id: "customerName",
      header: () => <SortableHeader label={t("board.colCustomer")} sortKey="customer" />,
      cell: ({ row }) => row.original.customerName || "—",
    },
    {
      id: "origin",
      header: () => t("board.colOrigin"),
      cell: ({ row }) => (
        <span title={row.original.originName}>{row.original.originCode || "—"}</span>
      ),
    },
    {
      id: "destination",
      header: () => t("board.colDestination"),
      cell: ({ row }) => (
        <span title={row.original.destinationName}>{row.original.destinationCode || "—"}</span>
      ),
    },
    {
      id: "laneLabel",
      header: () => t("board.colLane"),
      cell: ({ row }) => row.original.laneLabel ?? "—",
    },
    {
      id: "status",
      header: () => <SortableHeader label={t("board.colStatus")} sortKey="status" />,
      cell: ({ row }) => <TripStatusBadge status={row.original.currentStatus} />,
    },
    {
      // 007 — server-computed SLA-risk indicator (the UI never computes it).
      id: "sla",
      header: () => t("board.colSla"),
      cell: ({ row }) => <SlaCell row={row.original} />,
    },
    {
      // 006 — assignment row indicator + assigned resources (fills 005 FR-007).
      id: "assignment",
      header: () => t("board.colAssignment"),
      cell: ({ row }) => <AssignmentCell row={row.original} />,
    },
    {
      id: "billing",
      header: () => t("board.colBilling"),
      cell: ({ row }) => t(`billingStatus.${row.original.billingStatus ?? "none"}`),
    },
    {
      id: "plannedPickup",
      header: () => <SortableHeader label={t("board.colPickup")} sortKey="pickupStart" />,
      cell: ({ row }) => formatDateTime(row.original.plannedPickupWindowStart),
    },
    {
      id: "plannedDelivery",
      header: () => t("board.colDelivery"),
      cell: ({ row }) => formatDateTime(row.original.plannedDeliveryWindowStart),
    },
    {
      id: "plannedVehicleType",
      header: () => t("board.colVehicleType"),
      cell: ({ row }) => vehicleLabel(row.original.plannedVehicleType),
    },
    {
      id: "updatedAt",
      header: () => <SortableHeader label={t("board.colUpdatedAt")} sortKey="updatedAt" />,
      cell: ({ row }) => formatDateTime(row.original.updatedAt),
    },
    // 006 — per-row quick-assign action (FR-022 third entry point) for `assign_resources` holders;
    // 017 — per-row cancel action for `cancelScope` holders. One actions column serving both.
    ...(canAssign || cancelScope !== "none"
      ? [
          {
            id: "actions",
            header: () => tCommon("actions"),
            cell: ({ row }: { row: { original: TripBoardRow } }) => (
              <div className="flex gap-2">
                {/* Quick-assign is ASSIGN-only: shown for an UNASSIGNED `received` trip (slice 015;
                    was `validated`). Reassigning an already-assigned trip needs the full
                    current-assignment context (resources pre-filled), which only the Trip-Detail
                    panel has — the board row carries just display names — so an assigned row is
                    reached via its detail link, not a blank reassign form here. */}
                {canAssign &&
                !row.original.isAssigned &&
                row.original.currentStatus === "received" ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => setAssignRow(row.original)}
                  >
                    {tDispatch("assignAction")}
                  </Button>
                ) : null}
                {/* 017 — cancel (issue #24): scope ∩ machine legality, per row status. */}
                {canCancelTrip(cancelScope, row.original.currentStatus) ? (
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="text-destructive"
                    onClick={() => setCancelRow(row.original)}
                  >
                    {tCancel("action")}
                  </Button>
                ) : null}
              </div>
            ),
          } as ColumnDef<TripBoardRow>,
        ]
      : []),
  ];

  const table = useReactTable({
    data: items,
    columns,
    getCoreRowModel: getCoreRowModel(),
  });

  const columnCount = columns.length;
  const from = total === 0 ? 0 : offset + 1;
  const to = Math.min(offset + limit, total);
  const canPrev = offset > 0;
  const canNext = offset + limit < total;

  return (
    <div className="space-y-4">
      <TripFilters
        query={query}
        setFilters={setFilters}
        reset={reset}
        search={search}
        options={filterOptions}
      />

      <div className="rounded-md border">
        <Table>
          <TableHeader>
            {table.getHeaderGroups().map((headerGroup) => (
              <TableRow key={headerGroup.id}>
                {headerGroup.headers.map((header) => (
                  <TableHead key={header.id} className="whitespace-nowrap">
                    {header.isPlaceholder
                      ? null
                      : flexRender(header.column.columnDef.header, header.getContext())}
                  </TableHead>
                ))}
              </TableRow>
            ))}
          </TableHeader>
          <TableBody>
            {board.isLoading ? (
              <TableRow>
                <TableCell colSpan={columnCount}>{tCommon("loading")}</TableCell>
              </TableRow>
            ) : board.isError ? (
              <TableRow>
                <TableCell colSpan={columnCount} role="alert" className="text-destructive">
                  {t("board.loadError")}
                </TableCell>
              </TableRow>
            ) : items.length === 0 ? (
              <TableRow>
                <TableCell colSpan={columnCount} className="text-muted-foreground">
                  {t("board.empty")}
                </TableCell>
              </TableRow>
            ) : (
              table.getRowModel().rows.map((row) => (
                <TableRow key={row.id} className="whitespace-nowrap">
                  {row.getVisibleCells().map((cell) => (
                    <TableCell key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </TableCell>
                  ))}
                </TableRow>
              ))
            )}
          </TableBody>
        </Table>
      </div>

      {/* Pagination footer ---------------------------------------------------------------- */}
      <div className="flex flex-wrap items-center justify-between gap-2 text-sm text-muted-foreground">
        <span>{t("board.paginationSummary", { from, to, total })}</span>
        <div className="flex gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canPrev}
            onClick={() => setFilters({ offset: String(Math.max(0, offset - limit)) })}
          >
            {t("board.previous")}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={!canNext}
            onClick={() => setFilters({ offset: String(offset + limit) })}
          >
            {t("board.next")}
          </Button>
        </div>
      </div>

      {/* Quick-assign dialog (006, T063) — the shared AssignmentForm for an UNASSIGNED `received` row
          (slice 015; ASSIGN-only; reassignment/edit lives in the Trip-Detail panel, which has the full
          current assignment for pre-filled pickers). currentAssignment is therefore always null here. */}
      <Dialog open={assignRow != null} onOpenChange={(open) => !open && setAssignRow(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {tDispatch("openAssign")}
              {assignRow?.externalTripId ? ` — ${assignRow.externalTripId}` : ""}
            </DialogTitle>
          </DialogHeader>
          {assignRow ? (
            <AssignmentForm
              tripId={assignRow.id}
              currentStatus={assignRow.currentStatus}
              currentAssignment={null}
              resourceOptions={filterOptions}
              onDone={() => setAssignRow(null)}
            />
          ) : null}
        </DialogContent>
      </Dialog>

      {/* Cancel dialog (017) — the shared justified flow; one instance fed the row in scope. */}
      {cancelRow ? (
        <CancelTripDialog
          tripId={cancelRow.id}
          tripLabel={cancelRow.externalTripId}
          open
          onOpenChange={(open) => !open && setCancelRow(null)}
        />
      ) : null}
    </div>
  );
}

const SLA_STATUS_CLASS: Record<string, string> = {
  on_track: "bg-emerald-100 text-emerald-900",
  at_risk: "bg-amber-100 text-amber-900",
  late: "bg-orange-100 text-orange-900",
  breached: "bg-destructive/15 text-destructive",
};

/** The server-computed SLA-risk cell (007): a coloured status pill; contributing reasons on hover. */
function SlaCell({ row }: { row: TripBoardRow }) {
  const t = useTranslations("Sla");
  const status = row.slaStatus;
  if (!status) return <span className="text-muted-foreground">—</span>;
  const reasons = (row.slaReasons ?? [])
    .map((r) => {
      try {
        return t(`reason.${r}` as Parameters<typeof t>[0]);
      } catch {
        return r;
      }
    })
    .join(", ");
  return (
    <span
      title={reasons || undefined}
      className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${
        SLA_STATUS_CLASS[status] ?? "bg-muted text-muted-foreground"
      }`}
    >
      {t(`status.${status}` as Parameters<typeof t>[0])}
    </span>
  );
}

/** The assignment row indicator: an assigned/unassigned icon + the assigned resource names (006). */
function AssignmentCell({ row }: { row: TripBoardRow }) {
  const t = useTranslations("Trips");
  if (!row.isAssigned) {
    return (
      <span className="inline-flex items-center gap-1 text-muted-foreground">
        <X className="h-3.5 w-3.5" aria-hidden />
        {t("board.assignedNo")}
      </span>
    );
  }
  const parts = [row.assignedDriverName, row.assignedVehiclePlate, row.assignedCarrierName].filter(
    (p): p is string => Boolean(p),
  );
  return (
    <span className="inline-flex items-center gap-1" title={parts.join(" · ")}>
      <Check className="h-3.5 w-3.5 text-green-600" aria-hidden />
      <span className="text-sm">{parts.length > 0 ? parts.join(" · ") : t("board.assignedYes")}</span>
    </span>
  );
}
