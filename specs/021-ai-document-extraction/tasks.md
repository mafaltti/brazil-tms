---

description: "Task list for slice 021 — AI Document Reading (CNH/CRLV prefill)"
---

# Tasks: AI Document Reading for Resource Registration

**Input**: Design documents from `specs/021-ai-document-extraction/`

## ⚠️ Traps

1. **Prefill only** — no code path may call a create/update service with extraction output (FR-004).
2. **Image is ephemeral** — never write the payload to disk/Storage/DB/logs (FR-005). No
   `console.log` of the request body in the route.
3. **Key is server-only** — `ANTHROPIC_API_KEY` via `process.env` in a `"server-only"` module;
   NEVER `NEXT_PUBLIC_*`, never sent to the client.
4. **Null over guess** — schema fields nullable; the prompt demands null for unreadable; the UI
   lists unread fields instead of hiding them.

## Tasks

- [X] T001 Branch `021-ai-document-extraction` off `dev`; baseline gates green; `pnpm --filter @brazil-tms/web add @anthropic-ai/sdk`.
- [X] T002 Shared schemas + tests (`packages/shared/src/schemas/document-extraction.ts`).
- [X] T003 `apps/web/lib/ai/extract-document.ts` (client factory, prompt, parse call, error mapping) + unit tests with injected fake client.
- [X] T004 Route `POST /api/master-data/extract-document` (auth + manage_fleet_data; 503/502/400 per plan).
- [X] T005 `useExtractDocument` hook + `document-read-button.tsx` (shared, review notice) + pt-BR keys.
- [X] T006 Mount on driver form (CNH → name/licenseExpiry) and vehicle+trailer forms (CRLV → plate/vehicleType/documentExpiry) via `setValue`.
- [X] T007 e2e `ai-extraction.spec.ts`: button on 3 forms; not-configured path; 403 for non-holders.
- [X] T008 Gates: lint/typecheck/build; Vitest; Playwright vs local mock-GoTrue stack (no key → exercises the dark path).
- [X] T009 Quickstart (live-key manual verification steps) + PR to `dev`; CLAUDE.md SPECKIT block.
