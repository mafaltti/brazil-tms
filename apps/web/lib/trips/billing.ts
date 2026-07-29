import "server-only";

/**
 * Feature 008 — server-only re-export of the completion/Billing-Ready transitions + the billing view
 * (US2) and the billing-item mutations (US4, gated `edit_rates`).
 */
export {
  markCompleted,
  markBillingReady,
  loadBillingItemView,
  updateBillingItem,
  addBillingAdjustment,
  removeBillingAdjustment,
} from "@brazil-tms/db";
