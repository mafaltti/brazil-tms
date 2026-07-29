"use client";

import { useMutation, useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import type {
  FreightRateImportSummary,
  FreightRateItem,
  FreightSheetIssue,
} from "@brazil-tms/shared";

/**
 * Feature 016 — client data layer. Freshness is polling (30 s, board convention): an import done
 * by a colleague shows up on an open tab within the FR-008 60 s budget — NO Realtime
 * (Constitution). City filtering happens client-side (accent-insensitive, research R5); the
 * server handles UF, price range and sort.
 */

export const FREIGHT_RATES_POLL_MS = 30_000;

export interface FreightRateServerFilters {
  originUf?: string;
  destinationUf?: string;
  priceMinCents?: number;
  priceMaxCents?: number;
  sort?: "valorIda" | "km";
}

function buildQueryString(filters: FreightRateServerFilters): string {
  const params = new URLSearchParams();
  if (filters.originUf) params.set("originUf", filters.originUf);
  if (filters.destinationUf) params.set("destinationUf", filters.destinationUf);
  if (filters.priceMinCents !== undefined) params.set("priceMinCents", String(filters.priceMinCents));
  if (filters.priceMaxCents !== undefined) params.set("priceMaxCents", String(filters.priceMaxCents));
  if (filters.sort) params.set("sort", filters.sort);
  const qs = params.toString();
  return qs === "" ? "" : `?${qs}`;
}

export class FreightRateError extends Error {
  constructor(
    public readonly code: string,
    message: string,
    public readonly findings?: FreightSheetIssue[],
  ) {
    super(message);
    this.name = "FreightRateError";
  }
}

async function throwFromResponse(res: Response): Promise<never> {
  let code = "INTERNAL";
  let message = "Erro inesperado. Tente novamente.";
  let findings: FreightSheetIssue[] | undefined;
  try {
    const body = (await res.json()) as {
      error?: { code?: string; message?: string };
      findings?: FreightSheetIssue[];
    };
    code = body.error?.code ?? code;
    message = body.error?.message ?? message;
    findings = body.findings;
  } catch {
    // non-JSON body — keep defaults
  }
  throw new FreightRateError(code, message, findings);
}

export function useFreightRates(
  filters: FreightRateServerFilters,
): UseQueryResult<FreightRateItem[]> {
  return useQuery({
    queryKey: ["freight-rates", filters],
    queryFn: async () => {
      const res = await fetch(`/api/freight-rates${buildQueryString(filters)}`);
      if (!res.ok) await throwFromResponse(res);
      const body = (await res.json()) as { items: FreightRateItem[] };
      return body.items;
    },
    refetchInterval: FREIGHT_RATES_POLL_MS,
    staleTime: FREIGHT_RATES_POLL_MS,
  });
}

export function useImportFreightRates() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (file: File): Promise<FreightRateImportSummary> => {
      const form = new FormData();
      form.append("file", file);
      const res = await fetch("/api/freight-rates/import", { method: "POST", body: form });
      if (!res.ok) await throwFromResponse(res);
      const body = (await res.json()) as { item: FreightRateImportSummary };
      return body.item;
    },
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["freight-rates"] });
    },
  });
}
