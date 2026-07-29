"use client";
import { createBrowserClient } from "@supabase/ssr";

/**
 * Browser Supabase client — AUTH ONLY (sign-in/out, password flows). It uses the publishable key
 * and cannot reach Postgres (PostgREST is not exposed and RLS is deferred — FR-023).
 */
export function createSupabaseBrowserClient() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY;
  if (!url || !key) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL / NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.");
  }
  return createBrowserClient(url, key);
}
