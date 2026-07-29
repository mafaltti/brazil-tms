import "server-only";

/**
 * Feature 008 — server-only re-export of the rate services (US4). Writes gated `edit_rates`; reads
 * (`listRates`) on `view_all_trips`.
 */
export { createRate, updateRate, listRates } from "@brazil-tms/db";
