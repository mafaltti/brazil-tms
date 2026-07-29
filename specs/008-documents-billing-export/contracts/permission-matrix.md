# Permission Matrix — Documents, Completion, Billing Readiness, Rates & Export (008)

## No new permission key — first enforcement of six pre-declared 001 keys

008 adds **no** permission key. `upload_documents`, `verify_documents`, `mark_completed`, `mark_billing_ready`, `edit_rates`, and `export_billing` **already exist** in the 001 code-defined catalog (`packages/shared/src/auth/permissions.ts`), declared and granted but **never enforced**. Slice 008 is the **first slice to enforce** all six — the pattern 004 used for `import_trips`, 005 for `view_all_trips`, 006 for `assign_resources`, 007 for `update_trip_status`/`create_exceptions`/`resolve_exceptions`. Per-customer **document-requirement checklists and the document-type master** **reuse `manage_commercial_data`** (added **and already enforced** by 002, since they are per-customer/commercial config — mirroring 007's reuse for SLA rules); **no `manage_documents` / `configure_billing` key exists or is added** (Constitution V; R0/R12). All **reads** stay on `view_all_trips` (005).

All 008 writes are gated in the BFF via `requirePermission(ctx, <key>)` (`apps/web/lib/auth/require-auth.ts`):

- **upload a proof document** → `upload_documents`
- **verify a document** (accept / reject / pending) → `verify_documents`
- **archive a document** → `upload_documents`
- **mark Completed** (+ completion waivers) → `mark_completed`
- **mark Billing Ready** (+ billing waivers) → `mark_billing_ready`
- **rates + billing values / adjustments** → `edit_rates`
- **generate / download a billing export** → `export_billing`
- **document requirements + document-type master** → `manage_commercial_data` (reused, already enforced by 002)

No DB permissions table; RLS deferred (Constitution IV). The service-role key stays server-only (app **and** worker, incl. Supabase Storage). The Supabase gateway / PostgREST is never exposed; document/export binaries are served only as short-lived signed URLs through the BFF.

## Catalog grant (verbatim from 001 `ROLE_PERMISSIONS`, unchanged)

| Permission key | Admin | Ops Mgr | Dispatcher | Control Tower | Fleet Coord | Finance | Exec Viewer |
|---|:--:|:--:|:--:|:--:|:--:|:--:|:--:|
| `upload_documents` | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | — |
| `verify_documents` | ✓ | ✓ | — | — | — | ✓ | — |
| `mark_completed` | ✓ | ✓ | — | ✓ | — | — | — |
| `mark_billing_ready` | ✓ | — | — | — | — | ✓ | — |
| `edit_rates` | ✓ | — | — | — | — | ✓ | — |
| `export_billing` | ✓ | — | — | — | — | ✓ | — |
| `manage_commercial_data` (doc requirements / types) | ✓ | ✓ | — | — | — | — | — |
| `view_all_trips` (reads) | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ | ✓ |

Source: `ROLE_PERMISSIONS` in `packages/shared/src/auth/permissions.ts` (RECON-verified).

- **Document upload** (`upload_documents`) = everyone except Executive Viewer — operations, dispatch, control tower, fleet, and finance all attach proof.
- **Document verification** (`verify_documents`) = Admin, Operations Manager, Finance — the review authority that accepts/rejects proof.
- **Completion** (`mark_completed`) = Admin, Operations Manager, Control Tower (per PRD §18 "Mark trip Completed").
- **Billing Ready** (`mark_billing_ready`) = Admin, Finance only (per PRD §18 "Mark Billing Ready" — Finance owns the billing gate; Ops Manager does **not** hold it).
- **Rates / billing values** (`edit_rates`) and **export** (`export_billing`) = Admin, Finance only (per PRD §18).
- **Document requirements / types** (`manage_commercial_data`) = Admin, Operations Manager — same grant 002 enforces for commercial master data.
- Everyone with `view_all_trips` can **read** documents, billing values, and export history; only the keys above can write.

> **Waivers ride the gated transition** (R3): a missing required document is waived by passing `waivedRequirements` to `markCompleted` (gated `mark_completed`) or `markBillingReady` (gated `mark_billing_ready`) — no separate waiver endpoint or key. This binds waiver authority to the gate key the spec (FR-010) requires and keeps the waiver atomic + audited (`document.waive`).

## Reads stay on `view_all_trips`

All 008 read surfaces — the Trip-Detail documents/billing sections, the Documents screen + missing-document list, the Billing pending/ready lists, export-batch history, the rate/requirement/type admin lists, and the document/export **signed-URL downloads** (download itself is gated: documents on `view_all_trips`, export files on `export_billing`) — are gated on `view_all_trips`, except the export-file download which is gated `export_billing` (the export is finance output). No new read key.

## Endpoint → permission

| Endpoint | Method | Permission | Service / read |
|---|---|---|---|
| `/api/trips/:id/documents` | POST | `upload_documents` | `uploadDocument` (validate type/size → Storage → row) |
| `/api/documents/:id` | PATCH | `verify_documents` | `verifyDocument` (accept/reject/pending) |
| `/api/documents/:id` | DELETE | `upload_documents` | `archiveDocument` (soft-delete) |
| `/api/trips/:id/documents/:docId/download` | GET | `view_all_trips` | signed URL |
| `/api/trips/:id/complete` | POST | `mark_completed` | `markCompleted` (gate + `transitionTripStatus` → completed → billing_pending + billing item) |
| `/api/trips/:id/billing-ready` | POST | `mark_billing_ready` | `markBillingReady` (gate + `transitionTripStatus` → billing_ready) |
| `/api/document-types` | GET / POST | GET `view_all_trips` · POST `manage_commercial_data` | list / create |
| `/api/document-types/:id` | PATCH | `manage_commercial_data` | update |
| `/api/document-requirements` | GET / POST | GET `view_all_trips` · POST `manage_commercial_data` | list / create checklist |
| `/api/document-requirements/:id` | PATCH | `manage_commercial_data` | update |
| `/api/rates` | GET / POST | GET `view_all_trips` · POST `edit_rates` | list / create |
| `/api/rates/:id` | PATCH | `edit_rates` | update |
| `/api/trips/:id/billing` | PATCH | `edit_rates` | `updateBillingItem` (manual base / period / dispute) |
| `/api/trips/:id/billing/adjustments` | POST | `edit_rates` | `addBillingAdjustment` |
| `/api/billing-adjustments/:id` | DELETE | `edit_rates` | `removeBillingAdjustment` |
| `/api/billing` | GET | `view_all_trips` | billing pending/ready lists (FR-019) |
| `/api/billing/exports` | GET / POST | GET `view_all_trips` · POST `export_billing` | history / create+enqueue |
| `/api/billing/exports/:id/download` | GET | `export_billing` | signed URL to the export file |
| `/api/trips` , `/api/trips/:id` , `/api/dashboard/summary` | GET | `view_all_trips` (005) | **extended** reads — documents/billing detail, `completedMissingDocuments` fill, `missingDocuments` board filter |

The worker jobs (`billing.export`, `documents.checks`) run server-side with the service-role connection — not user-facing endpoints, no permission key (background authority is server-side, Constitution III / STACK §6).

## Test focus (Constitution / STACK §3.13)

First-enforcement of all six keys is a required permission-check set, mirroring 004/005/006/007:

- An `upload_documents` holder (e.g. Dispatcher / Control Tower / Finance) can upload a document (`201`); Executive Viewer is refused (`403`).
- A `verify_documents` holder (Admin / Ops Mgr / Finance) can accept/reject (`200`); a Dispatcher / Control Tower / Fleet Coordinator (who can upload but not verify) is refused (`403`).
- A `mark_completed` holder (Admin / Ops Mgr / Control Tower) can complete a trip whose rules pass (`200`) and is **blocked** (`409 COMPLETION_BLOCKED`) when completion-required docs are missing and unwaived; a Dispatcher / Finance is refused the action (`403`).
- A `mark_billing_ready` holder (Admin / Finance) can mark Billing Ready when §19.4 holds (`200`) and is **blocked** (`409 BILLING_READY_BLOCKED`) on missing billing docs / no pricing / open dispute; an Ops Manager / Control Tower is refused (`403`).
- An `edit_rates` holder (Admin / Finance) can create a rate + add adjustments (`200`); others are refused (`403`).
- An `export_billing` holder (Admin / Finance) can trigger an export (`202`) and download the file (`200`); others are refused (`403`).
- A `manage_commercial_data` holder (Admin / Ops Mgr) can edit a customer's document checklist + document types (`200`); a Dispatcher / Finance is refused (`403`).
- A non-holder of every write key can still **read** documents, billing values, and export history via `view_all_trips` (`200`).

Verified in Playwright `e2e/` (route-level 401/403/400/404/409 per the route-HTTP-tests-in-e2e convention, MEMORY) plus shared Vitest over `ROLE_PERMISSIONS` / `can`.
