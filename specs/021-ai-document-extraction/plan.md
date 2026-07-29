# Implementation Plan: AI Document Reading for Resource Registration

**Branch**: `021-ai-document-extraction` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

## Summary

Issue #29 [0006]: register drivers/vehicles by sending a document image. Design (clarified
2026-07-27: Claude API · CNH+CRLV · prefill-for-review):

1. **NEW dependency** `@anthropic-ai/sdk` (apps/web only) — the one justified add: a vision-capable
   LLM cannot be hand-rolled; the official SDK is the sanctioned access path (typed errors, retries).
2. **Shared schemas** (`packages/shared/src/schemas/document-extraction.ts`):
   `cnhExtractionSchema` `{ name, licenseExpiry }` and `crlvExtractionSchema`
   `{ plate, vehicleType (existing VehicleType enum), documentExpiry }` — every field `nullable`
   (unreadable → null, never guessed; FR-003). Dates `YYYY-MM-DD` strings.
3. **BFF route** `POST /api/master-data/extract-document` — `requireAuth` +
   `requirePermission("manage_fleet_data")`; body `{ docType: "cnh"|"crlv", mediaType, data }`
   (base64; media-type-aware caps — images ≤ 10 MiB ENCODED, the Anthropic per-image limit
   ≈ 7,5 MiB raw; PDFs ≤ 10 MiB raw; oversize → 400, never sent to the provider; image/* or
   application/pdf). Calls Claude **`claude-opus-4-8`** with adaptive
   thinking + **structured outputs** (`client.messages.parse` + `zodOutputFormat`) and the image as
   a vision/document block; pt-BR prompt instructs null-when-unreadable. Response
   `{ fields, unreadable: string[] }`. The image lives only in the request scope (FR-005). Errors:
   503 `EXTRACTION_NOT_CONFIGURED` (no `ANTHROPIC_API_KEY`), 502 `EXTRACTION_FAILED` (typed SDK
   errors → friendly retry), 400 Zod. Per-request timeout 60 s — a single extraction call is
   NOT batch work (016 R1 synchronous-parse precedent; the worker/queue is for heavy batches).
4. **UI**: "Ler documento (IA)" file button on the driver form (CNH) and vehicle/trailer forms
   (CRLV) → base64 → hook → `setValue` the mapped fields + review notice listing unread fields
   (FR-004: prefill only; submit stays on the existing create/update paths).

No schema/migration/worker change; no Storage use; key server-only (Constitution IV parity with the
service-role key).

## Technical Context

**New Dependency**: `@anthropic-ai/sdk` (apps/web). Model pinned `claude-opus-4-8`; `thinking:
{type: "adaptive"}`; `max_tokens` 2048 (small structured output — no streaming needed).

**Testing**: Vitest — pure mapping/schema tests (`document-extraction.test.ts` in shared) +
extraction-service unit with an injected fake client (no network). Playwright — button present on
the three forms; not-configured path (no key on the local stack → 503 surfaces the pt-BR message;
form untouched); permission: non-`manage_fleet_data` denied. **Live extraction** is manual with a
real key (quickstart) — CI has no key by design.

**Constraints**: polling/no-Realtime untouched; BFF-only; image ephemeral; pt-BR.

**Scale/Scope**: 1 dep · 1 shared schema file · 1 lib (`apps/web/lib/ai/extract-document.ts`) ·
1 route · 1 client hook + 3 form touches + i18n · tests/e2e.

## Constitution Check

- [x] **Simplicity (I)**: one endpoint, one lib, one shared schema; the new package is justified (no LLM without it) and confined to apps/web. No queue/worker for a single ~seconds call (016 precedent).
- [x] **Scope (II)**: issue #29 directly; PRD §5 keeps final compliance human — prefill-for-review honors it. Auto-registration explicitly out.
- [x] **System-of-record (III)**: no state written by the AI path; records still enter via the existing validated services.
- [x] **Authz & secrets (IV)**: `manage_fleet_data` gate; `ANTHROPIC_API_KEY` server-only env (never NEXT_PUBLIC); image never persisted (also privacy/PII).
- [x] **Config over code (V)**: n/a (no customer variation).
- [x] **Tech constraints**: no Realtime/Edge/Redis/microservices; one external HTTPS API call from the BFF.
- [x] **Workflow**: branch `021-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS** — the new dependency + external service are the logged design decisions (above), each with the rejected simpler alternative (no AI = the issue stays unsolved; hand-rolled HTTP = worse than the typed SDK).

## Project Structure

```text
apps/web (package.json)            # EDIT — add @anthropic-ai/sdk

packages/shared/src/schemas/
└── document-extraction.ts         # NEW — docType, cnh/crlv zod schemas (nullable fields,
                                   #   vehicleType constrained to VEHICLE_TYPE_VALUES), request schema
                                   #   (base64, media-type-aware caps: image ≤10MiB encoded /
                                   #   pdf ≤10MiB raw; allowed media types) + unit tests.

apps/web/lib/ai/
└── extract-document.ts            # NEW ("server-only") — lazy Anthropic client (env key; absent →
                                   #   Conflict EXTRACTION_NOT_CONFIGURED); buildPrompt(docType);
                                   #   extractDocument(input, client?) using messages.parse +
                                   #   zodOutputFormat + vision/document block; maps SDK errors →
                                   #   EXTRACTION_FAILED; returns { fields, unreadable }.
                                   #   + extract-document.test.ts (fake client injected).

apps/web/app/api/master-data/extract-document/
└── route.ts                       # NEW — POST per plan §3; force-dynamic; 60s timeout.

apps/web/lib/master-data/client.ts # EDIT — useExtractDocument mutation (no invalidation — transient).
apps/web/components/master-data/
├── document-read-button.tsx       # NEW — shared file-input button + review notice (used 3×).
├── driver-form.tsx                # EDIT — mount for CNH → setValue(name, licenseExpiry).
└── resource-form-fields.tsx / vehicle & trailer forms  # EDIT — mount for CRLV → plate/type/expiry.

apps/web/messages/pt-BR.json       # EDIT — MasterData.aiRead.* keys (button, reading…, review
                                   #   notice, unreadable list, notConfigured, failed).

apps/web/e2e/ai-extraction.spec.ts # NEW — button on the 3 forms; not-configured 503 path (pt-BR
                                   #   message, form untouched); manage_fleet_data 403 for dispatcher.

# UNCHANGED: db schema, services, worker, Storage, permissions matrix (manage_fleet_data exists).
```

## Complexity Tracking

| Design choice | Why acceptable | Simpler alternative rejected because |
|---|---|---|
| New runtime dependency `@anthropic-ai/sdk` + external paid API | Only way to deliver the issue; official SDK gives typed errors/retries/timeouts; confined to one lib file behind one route | "No AI" leaves issue #29 unsolved; raw fetch to the REST API re-implements the SDK poorly (skill guidance: SDK is the default) |
| Synchronous extraction in the BFF request (60 s cap) | Single-document, seconds-scale call with the user actively waiting; queue+worker+poll adds 3 moving parts for no UX gain (016 synchronous-parse precedent) | pg-boss round-trip — more surface, worse latency, same result |
