# Implementation Plan: Documents Tab for Drivers and Vehicles

**Branch**: `025-resource-documents` | **Date**: 2026-07-28 | **Spec**: [spec.md](./spec.md)

## Summary

Issue #32 [0009]: a "Documentos" tab on the driver/vehicle edit pages — append-only upload history
backed by the 008 storage plumbing. New lean `resource_documents` table (metadata only), nested BFF
routes mirroring the 008 upload/download shape (validate-before-store, binary rollback, signed
URLs), one shared service + one shared tab component, `manage_fleet_data` throughout.

## Technical Context

**New dependency (justified)**: `@radix-ui/react-tabs` via the shadcn `tabs` primitive — the issue
literally asks for an "aba"; same Radix family as the existing dialog/select/dropdown primitives.

**Storage**: reuse the private `documents` bucket; new key helper
`resourceDocumentStorageKey(entityType, entityId, documentId, ext)` →
`resources/<entityType>/<entityId>/<documentId>.<ext>` (no bucket/env change).

**Migration**: additive CREATE TABLE. NOTE: numbered **0009 on this branch** — PR #39 and PR #40
each carry their own 0009 too (all off dev, top 0008); each later merge renumbers during its
conflict pass (established in the PR #40 note).

**Local harness**: `.local/brazil-tms-dev/mock-gotrue.mjs` (outside the repo) gains minimal
Storage endpoints (upload / signed URL / signed download, in-memory) so the full flow runs in the
no-Docker e2e harness; the real stack path is the quickstart's manual step.

**Testing**: Vitest — shared meta-schema cases; service integration (DB on 5433) — the service
ended up storage-free by design (the ROUTE owns the binary), so its tests need no fake storage;
the storage round-trip (upload → signed URL → bytes) is covered end-to-end by Playwright against
the extended mock. The binary-rollback branch stays covered by the 008-pattern review only.

## Constitution Check

- [x] **Simplicity (I)**: one table, one service, one shared tab component reused by both entities; free-text type avoids a config surface; no worker involvement.
- [x] **Scope (II)**: direct issue-#32 fix; trailers/verification/type-master/expiry-linkage out of scope.
- [x] **System-of-record (III)**: append-only history + audit per upload; binaries only in Storage (STACK §3.9); no hard-delete anywhere.
- [x] **Authz (IV)**: BFF-enforced `manage_fleet_data`; service-role key server-only; signed URLs only.
- [x] **Config (V)**: reuses `DOCUMENTS_BUCKET`/`DOCUMENT_MAX_BYTES`; no new env.
- [x] **Workflow**: branch `025-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS.**

## Project Structure

```text
packages/db/schema/resource-documents.ts     # NEW — table (CHECK entity_type, indexes, FKs to users)
packages/db/schema/index.ts                  # EDIT — export
packages/db/src/storage.ts                   # EDIT — resourceDocumentStorageKey()
packages/db/migrations/0009_*.sql            # NEW — CREATE TABLE (generated)
packages/shared/src/schemas/resource-documents.ts  # NEW — entity types, meta schema (docType ≤60), DTO type
packages/shared/src/index.ts                 # EDIT — export
apps/web/lib/supabase/storage.ts             # EDIT — re-export the new key helper
apps/web/lib/master-data/resource-documents-service.ts  # NEW — list/insert(+audit, tx)/fileKey; parent
                                             #   preflight (exists + not archived)
apps/web/app/api/master-data/drivers/[id]/documents/route.ts             # NEW — GET list + POST upload
apps/web/app/api/master-data/drivers/[id]/documents/[docId]/download/route.ts  # NEW — signed URL
apps/web/app/api/master-data/vehicles/[id]/documents/route.ts            # NEW — same, vehicle
apps/web/app/api/master-data/vehicles/[id]/documents/[docId]/download/route.ts # NEW
apps/web/components/ui/tabs.tsx              # NEW — shadcn tabs (@radix-ui/react-tabs)
apps/web/components/master-data/resource-documents-tab.tsx  # NEW — shared history + upload UI
apps/web/components/master-data/driver-detail-client.tsx    # EDIT — tabs (edit mode only)
apps/web/components/master-data/vehicle-detail-client.tsx   # EDIT — tabs (edit mode only)
apps/web/messages/pt-BR.json                 # EDIT — Resources.documents block
docs/PRD.md                                  # EDIT — §14 Driver/Vehicle "Attached documents…", §30

packages/shared/src/schemas/resource-documents.test.ts       # NEW — meta schema cases
apps/web/lib/master-data/resource-documents-service.test.ts  # NEW — DB integration + fake storage
apps/web/e2e/resource-documents.spec.ts      # NEW — tab, upload→history→download (mock Storage)
```

## Complexity Tracking

`@radix-ui/react-tabs` — new UI primitive, demanded by the feature ("aba"), same family as the
five Radix packages already shipped; the shadcn wrapper is ~40 lines.
