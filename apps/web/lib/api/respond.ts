import { NextResponse } from "next/server";
import { ZodError } from "zod";
import { Conflict, NotFound } from "@brazil-tms/db";
import { Forbidden, OnboardingRequired, Unauthorized } from "../auth/require-auth";

export { Conflict, NotFound };

export function apiError(status: number, code: string, message: string): NextResponse {
  return NextResponse.json({ error: { code, message } }, { status });
}

/**
 * Maps known BFF errors to HTTP responses (401/403/409/400) with a generic 500 fallback.
 * A denied/failed request causes no state change (SC-003).
 */
export function handleRouteError(error: unknown): NextResponse {
  if (error instanceof Unauthorized) return apiError(401, "UNAUTHORIZED", error.message);
  if (error instanceof OnboardingRequired) return apiError(403, error.code, error.message);
  if (error instanceof Forbidden) return apiError(403, "FORBIDDEN", error.message);
  if (error instanceof NotFound) return apiError(404, error.code, error.message);
  if (error instanceof Conflict) {
    // A blocked/override-required assignment carries the offending `Finding[]` in `details`; surface
    // it as a TOP-LEVEL `findings` field so the dispatch UI can show which checks fired (006).
    return NextResponse.json(
      {
        error: { code: error.code, message: error.message },
        ...(error.details !== undefined ? { findings: error.details } : {}),
      },
      { status: 409 },
    );
  }
  if (error instanceof ZodError) {
    return NextResponse.json(
      { error: { code: "VALIDATION", message: "Dados inválidos.", issues: error.flatten() } },
      { status: 400 },
    );
  }
  console.error("Unhandled route error:", error);
  return apiError(500, "INTERNAL", "Erro interno.");
}
