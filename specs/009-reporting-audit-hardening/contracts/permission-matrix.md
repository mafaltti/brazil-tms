# Permission Matrix — 009 Reporting, Audit Views, Hardening

**No new permission key is added.** 009 reuses pre-declared keys, mirroring the established pattern (004/`import_trips`, 005/`view_all_trips`, 006/`assign_resources`, 007/exception keys, 008's six first-enforced keys). Authorization is enforced **only in the BFF** via `requirePermission(ctx, key)` (Constitution IV); the nav/UI hides items with `can(role, permission)` but the BFF stays authoritative.

## Keys used by this slice

| Surface | Key | Roles holding it (PRD §18) | New? |
|---|---|---|---|
| Reports screen + the three report reads (`/api/reports/*`) | `view_all_trips` | Admin, Ops Manager, Dispatcher, Control Tower, Fleet Coord., Finance, Executive | reused (mirrors the 005 dashboard) |
| Dedicated audit-history view (`/api/admin/audit-logs`) | `view_audit_log` | **Admin only** | reused (slice 001, first-enforced there) |
| Embedded per-trip audit timeline (Trip Detail) | `view_all_trips` | all seven internal roles | reused (005) |
| SLA-rule / document-requirement administration (unchanged here) | `manage_commercial_data` | Admin, Ops Manager | reused (002) |

- **No `view_reports` / `view_audit` / `manage_reports` key** exists or is added (clarify Q1/Q2; spec FR-001/FR-013).
- Broadening `view_audit_log` membership (e.g., to Finance for billing-change forensics) is a **role-grant decision, deferred** — not done in this slice (clarify session).
- Reports and the audit view are **reads** → **not audited** (the audit model records mutations only). Viewing a report writes nothing.

## Authorization invariants (verified by `e2e/reports.spec.ts` + `e2e/audit.spec.ts`)

1. A holder of `view_all_trips` gets `200` from each `/api/reports/*`; a hypothetical non-holder gets `403`. (All seven internal roles hold it, so the negative case is exercised with a token stripped of the key / a future restricted role.)
2. A non-Admin (lacking `view_audit_log`) gets `403` from `/api/admin/audit-logs`; Admin gets `200`. The embedded Trip-Detail timeline remains visible to any `view_all_trips` holder.
3. No report or audit read mutates state or writes an `audit_logs` row.

---

## Permission-coverage hardening matrix (FR-016 — the §23/§18 proof)

`e2e/permission-coverage.spec.ts` asserts, for **every operational and billing mutation endpoint across slices 001–008**, that a **holder gets `2xx`** and a **non-holder gets `403` with no state change**. This is the slice's contribution to §23 ("Permission rules prevent unauthorized operational and billing changes"). The full endpoint↔key list lives in [acceptance-and-hardening.md](./acceptance-and-hardening.md); summary by key:

| Key | Representative guarded mutations (owner slice) |
|---|---|
| `import_trips` | import preview/confirm (004) |
| `manage_trips` / `edit_trip_plan` | trip plan edits (003/005) |
| `assign_resources` | assign / reassign / unassign (006) |
| `update_trip_status` | status transitions (003/007) |
| `cancel_trip` | cancel trip (003) |
| `create_exceptions` / `resolve_exceptions` | exception create / resolve (007) |
| `upload_documents` / `verify_documents` | document upload / verify / archive (008) |
| `mark_completed` / `mark_billing_ready` | completion / billing-ready transitions (008) |
| `edit_rates` | rate + billing-item/adjustment edits (008) |
| `export_billing` | export create / download (008) |
| `manage_commercial_data` | document requirements/types, SLA rules (002/007/008) |
| `manage_users` | user/role management (001) |
| `view_audit_log` | audit-log read (001/009) |

**Result of this slice's authz work**: 0 new keys; reports and audit reads gated by reused keys; the coverage suite proves the whole 001–008 mutation surface enforces its key.
