import { useTranslations } from "next-intl";
import type { TripStatus } from "@brazil-tms/shared";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

/**
 * pt-BR trip-status badge (005 R14, §16). Maps each `trip_status` to an accessible (WCAG-AA) colour by
 * lifecycle phase: intake = slate, planning = indigo, execution = blue, done = green, billing = amber,
 * terminal = red/gray. Follows the master-data status-badge pattern (Badge + i18n label) but with a
 * per-status colour so operators can scan the dense board. Renders in server or client components
 * (next-intl `useTranslations` is isomorphic). Slice 015 dropped the `validation_error`/`validated`
 * keys (the `Record<TripStatus>` is now the 16-value machine).
 */
const STATUS_CLASS: Record<TripStatus, string> = {
  received: "bg-slate-100 text-slate-700 border-slate-200",
  assigned: "bg-indigo-100 text-indigo-800 border-indigo-200",
  confirmed: "bg-indigo-100 text-indigo-800 border-indigo-200",
  at_origin: "bg-blue-100 text-blue-800 border-blue-200",
  loading: "bg-blue-100 text-blue-800 border-blue-200",
  loaded: "bg-blue-100 text-blue-800 border-blue-200",
  in_transit: "bg-blue-100 text-blue-800 border-blue-200",
  at_destination: "bg-blue-100 text-blue-800 border-blue-200",
  unloading: "bg-blue-100 text-blue-800 border-blue-200",
  unloaded: "bg-blue-100 text-blue-800 border-blue-200",
  completed: "bg-green-100 text-green-800 border-green-200",
  billing_pending: "bg-amber-100 text-amber-800 border-amber-200",
  billing_ready: "bg-amber-100 text-amber-800 border-amber-200",
  billed: "bg-green-100 text-green-800 border-green-200",
  cancelled: "bg-gray-200 text-gray-700 border-gray-300",
  disputed: "bg-red-100 text-red-800 border-red-200",
};

export function TripStatusBadge({ status }: { status: TripStatus }) {
  const t = useTranslations("Trips.status");
  return (
    <Badge variant="outline" className={cn("font-medium", STATUS_CLASS[status])}>
      {t(status)}
    </Badge>
  );
}
