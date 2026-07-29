import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Supabase Storage helper (feature 004, research R12). Server/worker-only — uses the service-role key
 * and is consumed by BOTH the BFF (`apps/web` re-exports this via `lib/supabase/storage.ts`) and the
 * import worker (parse downloads the original; generate-error-report uploads the report). The private
 * `imports` bucket holds the original upload + the generated error report; only their keys/metadata
 * live in Postgres. Downloads are server-mediated short-lived signed URLs — never public object URLs
 * (Constitution IV; the Supabase gateway exposes Storage but objects stay private).
 *
 * It deliberately does NOT `import "server-only"`: `@brazil-tms/db` is loaded by the plain-Node worker
 * too. The web side re-applies the server-only guard at its re-export boundary.
 */

let cachedClient: SupabaseClient | undefined;

function getClient(): SupabaseClient {
  if (cachedClient) return cachedClient;
  const url = process.env.SUPABASE_URL ?? process.env.NEXT_PUBLIC_SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) {
    throw new Error(
      "Supabase Storage requires SUPABASE_URL (or NEXT_PUBLIC_SUPABASE_URL) and SUPABASE_SERVICE_ROLE_KEY (server/worker-only).",
    );
  }
  cachedClient = createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
  });
  return cachedClient;
}

/** The private bucket name (default `imports`; overridable via IMPORT_BUCKET). */
export function importBucket(): string {
  return process.env.IMPORT_BUCKET ?? "imports";
}

/** Feature 008 — the private documents bucket (default `documents`; overridable via DOCUMENTS_BUCKET). */
export function documentsBucket(): string {
  return process.env.DOCUMENTS_BUCKET ?? "documents";
}

/** Feature 008 — the private billing-exports bucket (default `billing-exports`; via EXPORTS_BUCKET). */
export function exportsBucket(): string {
  return process.env.EXPORTS_BUCKET ?? "billing-exports";
}

/** Feature 008 — storage key of a trip's proof-document binary (`trips/<tripId>/<documentId>.<ext>`). */
export function documentStorageKey(tripId: string, documentId: string, ext: string): string {
  return `trips/${tripId}/${documentId}.${ext}`;
}

/**
 * Slice 025 — storage key of a driver/vehicle registry attachment
 * (`resources/<entityType>/<entityId>/<documentId>.<ext>`; same private documents bucket as 008).
 */
export function resourceDocumentStorageKey(
  entityType: "driver" | "vehicle",
  entityId: string,
  documentId: string,
  ext: string,
): string {
  return `resources/${entityType}/${entityId}/${documentId}.${ext}`;
}

/** Feature 008 — storage key of a generated billing-export file (`exports/<exportBatchId>.<ext>`). */
export function exportStorageKey(exportBatchId: string, ext: string): string {
  return `exports/${exportBatchId}.${ext}`;
}

/** Storage key of the original uploaded file for a batch (one per batch). */
export function originalStorageKey(batchId: string): string {
  return `originals/${batchId}`;
}

/** Storage key of the generated error report for a batch. */
export function errorReportStorageKey(batchId: string): string {
  return `error-reports/${batchId}.xlsx`;
}

async function putObject(
  key: string,
  bytes: Buffer | Uint8Array,
  contentType: string,
  bucket: string = importBucket(),
): Promise<string> {
  const { error } = await getClient()
    .storage.from(bucket)
    .upload(key, bytes, { contentType, upsert: true });
  if (error) throw new Error(`Storage upload failed for ${key}: ${error.message}`);
  return key;
}

/**
 * Feature 008 — idempotently ensure a private Storage bucket exists (provisioning step). Mirrors how
 * the `imports` bucket is set up; safe to re-run (a "already exists" error is swallowed).
 */
export async function ensureBucket(name: string): Promise<void> {
  const { data } = await getClient().storage.getBucket(name);
  if (data) return;
  const { error } = await getClient().storage.createBucket(name, { public: false });
  // Treat an "already exists" race as success.
  if (error && !/exist/i.test(error.message)) {
    throw new Error(`Storage bucket create failed for ${name}: ${error.message}`);
  }
}

/** Feature 008 — upload a proof-document binary to the documents bucket; returns its key. */
export async function putDocument(
  key: string,
  bytes: Buffer | Uint8Array,
  contentType = "application/octet-stream",
): Promise<string> {
  return putObject(key, bytes, contentType, documentsBucket());
}

/** Feature 008 — upload a generated billing-export file to the billing-exports bucket; returns its key. */
export async function putExport(
  key: string,
  bytes: Buffer | Uint8Array,
  contentType = "application/octet-stream",
): Promise<string> {
  return putObject(key, bytes, contentType, exportsBucket());
}

/** Feature 008 — best-effort delete of an object (e.g. roll back a stored binary when the metadata
 * insert fails). Swallows errors so cleanup never masks the original failure. */
export async function removeObject(key: string, bucket: string): Promise<void> {
  try {
    await getClient().storage.from(bucket).remove([key]);
  } catch {
    // best-effort: leave the orphan rather than throw over the real error.
  }
}

/** Upload the original import file; returns its storage key (recorded on `import_batches`). */
export async function putOriginal(
  batchId: string,
  bytes: Buffer | Uint8Array,
  contentType = "application/octet-stream",
): Promise<string> {
  return putObject(originalStorageKey(batchId), bytes, contentType);
}

/** Upload the generated error report (CSV/XLSX); returns its storage key. */
export async function putErrorReport(
  batchId: string,
  bytes: Buffer | Uint8Array,
  contentType = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
): Promise<string> {
  return putObject(errorReportStorageKey(batchId), bytes, contentType);
}

/** Download an object by key (the worker parse job reads the original). Bucket defaults to `imports`. */
export async function downloadObject(key: string, bucket: string = importBucket()): Promise<Buffer> {
  const { data, error } = await getClient().storage.from(bucket).download(key);
  if (error || !data) throw new Error(`Storage download failed for ${key}: ${error?.message ?? "no data"}`);
  return Buffer.from(await data.arrayBuffer());
}

/** Issue a short-lived signed download URL (server-mediated; no public object URL). Bucket defaults to `imports`. */
export async function signedUrl(
  key: string,
  expiresInSeconds: number,
  bucket: string = importBucket(),
): Promise<string> {
  const { data, error } = await getClient()
    .storage.from(bucket)
    .createSignedUrl(key, expiresInSeconds);
  if (error || !data) throw new Error(`Storage signed URL failed for ${key}: ${error?.message ?? "no data"}`);
  return data.signedUrl;
}
