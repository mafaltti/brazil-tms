"use client";

import { useQuery, type UseQueryResult } from "@tanstack/react-query";

/**
 * Shared client helpers for every master-data screen (feature 002). One generic list shape
 * (`{ items: T[] }`, contract R11) and one fetch/error convention reused across the seven entities,
 * so each screen only declares its columns/fields. Freshness is TanStack Query polling with a ~30s
 * staleTime — NO Realtime (Constitution). The browser never talks to Postgres; everything goes
 * through the BFF under `/api/master-data/*`.
 */

/** ~30s — interactive admin CRUD; master-data volumes are modest (plan: Performance Goals). */
export const MASTER_DATA_STALE_TIME = 30_000;

export interface ListResponse<T> {
  items: T[];
}

export interface ApiErrorBody {
  code: string;
  message: string;
  issues?: { formErrors?: string[]; fieldErrors?: Record<string, string[]> };
}

/** Read a `{ error: { code, message, issues? } }` body; null if absent/unparseable. */
export async function readApiError(res: Response): Promise<ApiErrorBody | null> {
  try {
    const body = (await res.json()) as { error?: ApiErrorBody };
    return body.error ?? null;
  } catch {
    return null;
  }
}

/** A thrown error carrying the API error code, so mutation onError can map it to a pt-BR message. */
export class MasterDataError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = "MasterDataError";
  }
}

export type QueryParams = Record<string, string | number | boolean | null | undefined>;

function basePath(entity: string): string {
  return `/api/master-data/${entity}`;
}

function withParams(entity: string, params?: QueryParams): string {
  const url = basePath(entity);
  if (!params) return url;
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === null || value === "" || value === false) continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return qs ? `${url}?${qs}` : url;
}

async function asJson<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const err = await readApiError(res);
    throw new MasterDataError(err?.code ?? "REQUEST_FAILED");
  }
  return (await res.json()) as T;
}

// --- Fetchers (usable from hooks or mutations) ---------------------------------------------------

export async function fetchList<T>(entity: string, params?: QueryParams): Promise<T[]> {
  const body = await asJson<ListResponse<T>>(await fetch(withParams(entity, params)));
  return body.items;
}

export async function fetchDetail<T>(entity: string, id: string): Promise<T> {
  const body = await asJson<{ item: T }>(await fetch(`${basePath(entity)}/${id}`));
  return body.item;
}

export async function createEntity<T>(entity: string, input: unknown): Promise<T> {
  const res = await fetch(basePath(entity), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await asJson<{ item: T }>(res);
  return body.item;
}

export async function updateEntity<T>(entity: string, id: string, input: unknown): Promise<T> {
  const res = await fetch(`${basePath(entity)}/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
  });
  const body = await asJson<{ item: T }>(res);
  return body.item;
}

export async function archiveEntity(entity: string, id: string): Promise<void> {
  const res = await fetch(`${basePath(entity)}/${id}`, { method: "DELETE" });
  await asJson<unknown>(res);
}

// --- Query keys + hooks --------------------------------------------------------------------------

export function listKey(entity: string, params?: QueryParams): unknown[] {
  return ["master-data", entity, "list", params ?? {}];
}

export function detailKey(entity: string, id: string): unknown[] {
  return ["master-data", entity, "detail", id];
}

/** List query with the shared 30s staleTime; pass entity-specific filter params. */
export function useEntityList<T>(entity: string, params?: QueryParams): UseQueryResult<T[]> {
  return useQuery({
    queryKey: listKey(entity, params),
    queryFn: () => fetchList<T>(entity, params),
    staleTime: MASTER_DATA_STALE_TIME,
  });
}

/** Detail query for a single record. */
export function useEntityDetail<T>(entity: string, id: string): UseQueryResult<T> {
  return useQuery({
    queryKey: detailKey(entity, id),
    queryFn: () => fetchDetail<T>(entity, id),
    staleTime: MASTER_DATA_STALE_TIME,
    enabled: Boolean(id),
  });
}
