import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Service-role Supabase client for seed scripts that need GoTrue admin APIs (`auth.admin.*`).
 *
 * Built via supabase-js (Storage's standalone `StorageClient` has no auth surface), but with Realtime
 * disabled. Two reasons:
 *   1. The constitution forbids Supabase Realtime (freshness is polling, never Realtime).
 *   2. Concretely, supabase-js's `RealtimeClient` constructor eagerly probes for a global `WebSocket`
 *      and THROWS on plain Node < 22 ("Node.js 20 detected without native WebSocket support…"). These
 *      seeds run under `tsx`/plain Node, so without this they crash before doing any work.
 *
 * Passing a stub `transport` short-circuits that probe (`options.transport ?? getWebSocketConstructor()`
 * in realtime-js). The stub is never instantiated because the seeds never open a Realtime connection.
 */
export function createSeedAdminClient(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, {
    auth: { autoRefreshToken: false, persistSession: false },
    realtime: { transport: class {} as never },
  });
}
