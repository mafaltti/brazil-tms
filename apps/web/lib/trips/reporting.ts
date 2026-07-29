import "server-only";

/**
 * Feature 009 — server-only re-export of the three report read models (data-model §2–4). The BFF
 * `/api/reports/*` route handlers import the projections from here, mirroring `lib/trips/trips-read.ts`.
 * Each user story appends its own `queryXReport` re-export below (kept beside the others so the barrel
 * stays the single server entry point for reporting). Read-only — no mutation, no audit write.
 */
export {
  querySlaReport, // US1 (T019)
  queryExceptionReport, // US2 (T026)
  queryBillingReadinessReport, // US3 (T033)
} from "@brazil-tms/db";
