# Research: Collapse Validation Statuses into "Recebida" (slice 015)

Phase 0 decisions. All were grounded in a repo-wide impact map (domain/db/workers/web/tests/docs) and the
user's scope clarifications (2026-06-07). No `NEEDS CLARIFICATION` remain.

---

## R1 — Remove `validation_error` + `validated` from the *active* machine; keep `confirmed`

**Decision**: The active trip status machine drops exactly two values — `validation_error` and
`validated` — leaving 16. `received` becomes the first dispatchable status. `assigned`, `confirmed`, and
every state from `confirmed` onward are unchanged.

**Rationale**: Import applies only `valid`/`warning` rows, so a created trip is inherently valid; a
separate trip-level validate state carries no information (PRD §11.2 validation is a *row* outcome, not a
trip status). The user explicitly narrowed scope to this single collapse; the `assigned`/`confirmed`
collapse and confirm-step removal are out of scope.

**Alternatives considered**: (a) Also collapse `assigned`/`confirmed` (the original ask) — **rejected by
the user** mid-clarification; would have orphaned the confirmation-cutoff SLA, the confirm route/schema/UI,
and inverted the `trip-plan.ts` review gate. (b) UI-relabel only (keep all 18 internal states, merge
labels) — rejected: leaves the redundant hop and operators still click through it; the user chose a real
lifecycle collapse.

---

## R2 — Transition table rewrite (the only legality change)

**Decision**:

```ts
// BEFORE
received:        ["validated", "validation_error", "cancelled"],
validation_error:["received"],
validated:       ["assigned", "cancelled"],
assigned:        ["confirmed", "validated", "cancelled"],   // validated = unassign
confirmed:       ["at_origin", "cancelled"],
// AFTER
received:        ["assigned", "cancelled"],
assigned:        ["confirmed", "received", "cancelled"],     // received = unassign
confirmed:       ["at_origin", "cancelled"],                 // UNCHANGED
```

The `validation_error` and `validated` rows are deleted; `at_origin` onward is unchanged. `ACTIVE_TRIP_STATUSES`
drops the two values (12 → 10); `NON_EDITABLE_TRIP_STATUSES` is unchanged (6); the partition invariant
`active + nonEditable === TRIP_STATUSES.length` still holds (10 + 6 = 16).

**Rationale**: Mirrors the collapse exactly. `received → assigned` is the assign hop; `assigned → received`
is unassign (replacing the removed `validated` target); the confirm hop is preserved.

**Alternatives**: making `received` self-dispatchable while *also* allowing `received → confirmed` (skip
assign) — rejected; assignment is still required before confirmation (no behavior change there).

---

## R3 — DB enum: dormant values, not physical removal

**Decision**: Keep all 18 values in the `trip_status` pgEnum (`packages/db/schema/enums.ts`). Mark
`validation_error`/`validated` **dormant** in a comment. Pin the Drizzle column types to the 16-value
`TripStatus` via `.$type<TripStatus>()` on `trips.current_status` and `trips.disputed_from_status`
(type-only; no generated SQL). Do **not** add a CHECK constraint.

**Rationale**: Postgres has no `ALTER TYPE … DROP VALUE`. True removal means creating a new type and
rewriting all four columns that use it (`trips.current_status`, `trips.disputed_from_status`,
`trip_events.status_before`, `trip_events.status_after`) — which would rewrite the **immutable**
`trip_events` audit history (Constitution III violation) or force keeping the old type for events anyway.
Dormant values match the repo precedent (the dormant `import_templates` table, MEMORY
`import_template_optional_ui_required_worker`). `.$type<>()` is Drizzle's supported way to narrow an
inferred column type without touching the DB, so typecheck sees the 16-value machine while Postgres keeps
the 18-member type. After the R4 backfill, no live row holds a dormant value, and every writer (BFF, worker,
seeds) is TS-typed to the 16-value `TripStatus`, so the dormant members are unreachable in practice.

**Alternatives**: (a) Drop the two values from the pgEnum array in `enums.ts` — rejected: `drizzle-kit
generate` would emit an unsupported destructive `ALTER TYPE`, and it breaks `trip_events` history. (b) Add
a `trips_current_status_ck` CHECK forbidding the two values — considered as hardening; rejected for now
(KISS/YAGNI: the type system + transition table already prevent writes; revisitable if raw-SQL writers ever
appear).

**Note (intentional divergence)**: `enums.ts` `trip_status` (18) and `shared` `TRIP_STATUSES` (16) are now
deliberately **not** identical; the lockstep comment in `trip-status.ts`/`enums.ts` is updated to document
the two dormant members. No automated test pins them equal (lockstep was PR-enforced prose, not a test).

---

## R4 — Backfill existing rows (migration 0008, data-only)

**Decision**: A hand-filled, `--custom`-scaffolded migration:

```sql
UPDATE trips SET current_status = 'received'
  WHERE current_status IN ('validated', 'validation_error');
UPDATE trips SET disputed_from_status = 'received'
  WHERE disputed_from_status IN ('validated', 'validation_error');
```

`trip_events` rows (`status_before`/`status_after` = `validated`/`validation_error`) are **left intact** as
immutable history. Scaffold with `drizzle-kit generate --custom --name=collapse_validation_statuses` (which
appends the journal entry + a snapshot with no schema diff), then write the two `UPDATE`s into the `.sql`.

**Rationale**: FR-006 — a leftover dormant value would render as a missing i18n key in the status badge and
can break the page (project memory on next-intl). `validated → received` is not a legal lifecycle
transition, so `transitionTripStatus` can't express it; a one-time migration is correct. Mapping both
removed values to `received` matches the collapse (they all become "Recebida").

**Mechanics confirmed**: journal is at version 7, entries `0000`–`0007`; next is `0008`. `db:migrate` =
`drizzle-kit migrate`. `--custom` is the documented Drizzle path for data migrations and keeps the
journal/snapshot bookkeeping consistent (no hand-edited `_journal.json`).

**Alternatives**: hand-authoring the `.sql` + `_journal.json` + snapshot — rejected (error-prone vs.
`--custom`). Auditing each row — rejected (R1 in plan Complexity Tracking).

---

## R5 — Born-received (revert slice 014's `createTrip` param)

**Decision**: Remove the `initialStatus` parameter (and its guard/type `InitialTripStatus`) from
`createTrip`; insert `current_status = "received"` and the `trip.create` audit `newValue.currentStatus =
"received"` (hardcoded, as pre-014). The two `confirm-import` call sites drop the `"validated"` argument.

**Rationale**: Slice 014 added the param solely to birth trips `validated`. With `validated` removed and
`received` now dispatchable, the param's only use disappears (YAGNI). Manual create already passes no
argument → stays `received`. No other caller passed a non-default value (verified in the impact map).

**Crash-window safety (re-derived for born-received)**: The trip is written atomically in `createTrip`'s
single transaction with `received`; there is no intermediate non-dispatchable state to strand it (the
property is *stronger* than 014's, since `received` is itself dispatchable). The confirm re-run idempotency
(`applied_at` guard + unique index) and the status-neutral `updateTripPlan` race fallback are unchanged, so
an already-`assigned`/in-execution trip is never downgraded (FR-007 / 014 FR-002 preserved).

**Alternatives**: keep the param defaulting to `"received"` only — rejected (a dead single-value param;
KISS says remove it).

---

## R6 — Dispatch queue + assign/unassign retarget

**Decision**:
- `DISPATCH_QUERY` (`dispatch-board.tsx`): `assigned=false&status=validated&sort=pickupStart` →
  `assigned=false&status=received&sort=pickupStart`.
- `assignTrip` (`trip-assignments.ts`): optimistic source guard `WHERE current_status = 'received'` (was
  `'validated'`); `statusBefore`/audit `previousValue` → `received`.
- `unassignTrip`: `canTransition('assigned','received')`; `set current_status='received'`; `statusAfter`/
  audit `newValue` → `received`.
- BFF assign branch (`assignment/route.ts`): `expectedFromStatus === 'received' ? assignTrip : reassignTrip`.
- `assignment-panel.tsx` `ASSIGNABLE_STATUSES` and `control-tower-table.tsx` quick-assign gate → `received`.

**Rationale**: A non-empty `status` filter suppresses the `scope=active` default in `buildWhere`
(`trips-read.ts`) and composes with `assigned=false` → exactly unassigned `received` trips, every one
assignable (`received → assigned`). This is the same mechanic slice 014 used, retargeted from `validated`
to `received`. `reassignTrip` and `confirmTripAssignment` are unchanged (still keyed on `assigned`/
`confirmed`).

**Alternatives**: revert `DISPATCH_QUERY` to `scope=active` — rejected: `scope=active` includes
in-execution trips; the queue must show only unassigned, ready-to-dispatch (`received`) trips, mirroring the
014 intent.

---

## R7 — What stays untouched (no-regression boundary)

**Decision / verified unchanged**: `confirmed` status; `confirmTripAssignment`, `/assignment/confirm`
route, `useConfirmAssignment`, the "Confirmar" button + its i18n keys; `confirmAssignmentSchema`;
`trip.confirm` audit; `confirmed_by`/`confirmed_at` assignment columns; the SLA confirmation-cutoff
(`missed_confirmation` reason, `unconfirmed_within_window` alert, `confirmationCutoffMinutes` policy +
seed); the `sla-sweep` `REASON_TO_ALERT`/`ALERT_SEVERITY` maps; `trip-plan.ts` post-`confirmed` review gate
(`indexOf("confirmed")` stays valid because `confirmed` remains in the array); all `confirmed`-onward
execution/billing transitions; the **`import_batch_status`** enum and every `importBatches.status` =
`validated`/`confirming` reference; the import engine; audit/event semantics; duplicate detection.

**Rationale**: The scope is the validation collapse only. Keeping `confirmed` means none of the
confirmation machinery is orphaned, the SLA section of the PRD stays consistent, and the most dangerous
landmine in the full-collapse variant (`indexOf("confirmed") === -1` forcing every plan edit into
authorized review) never arises.

---

## R8 — The `import_batch_status` name-collision trap

**Decision**: Treat `import_batch_status` (its own pgEnum: `received | parsing | validating | validated |
confirming | completed | failed`) as strictly out of scope. **No blind find-replace of `'validated'` /
`'confirming'` / `'received'`.**

**Rationale**: The batch enum independently contains `validated` ("preview ready, awaiting confirm") and
`confirming`. These appear in `workers/lib/batch-progress.ts`, `detect-duplicates/index.ts:268`,
`confirm-import/index.ts:258` (`setBatchStatus`), `import-batches-service.ts`, the import UI, and many
`importBatches.status` test assertions — all of which **stay**. Several files interleave both enums (e.g.
`confirm.test.ts` line ~196 is batch status `validated` = KEEP, while line ~208 is trip status `validated`
= CHANGE; `trip-import.spec.ts` line ~138 batch vs. line ~255 trip). Edits must be made by **meaning**, not
by string.

---

## R9 — Test/e2e: retarget vs. invert

**Decision**: Distinguish three kinds of test change:
1. **Retarget** (mechanical): `validated`→`received` seeds and `expectedFromStatus` across assign/unassign/
   transitions/SLA-with-validated-seed.
2. **Invert** (semantic — the assertion encodes the *old* design): `dispatch-board.spec.ts` "a `received`
   trip is **excluded** from the queue" → now **included**; `trip-import.spec.ts` "badge shows **Validada**,
   not Recebida" → "shows **Recebida**"; `trips-service.test.ts` born-validated test → **delete**.
3. **Keep** (confirmed machinery): every `confirmed` seed, the confirm-route/authz/coverage tests, the
   reassign-from-`confirmed` test, and all batch-status `validated` assertions stay.

**Rationale**: Only re-seeding the inverted tests would make them pass for the wrong reason (false green).
The `TripStatus` union shrink makes most stale literals a **typecheck error** (a good safety net), but
plain strings in query constants, pt-BR JSON, and Playwright text matchers are invisible to `tsc` and need
manual edits + render/e2e verification.

---

## R10 — PRD amendment, not shipped-spec edits

**Decision**: Amend `docs/PRD.md` (§12 status table → 16; §12.1 transitions; §7/§11.2/11.3/11.4/§19.1
prose to drop the validate hop; §30 decision-log entry recording the collapse and superseding slice 014's
born-`validated`). Do **not** edit shipped specs (003/004/006/013/014). Constitution unchanged (Principle
III "explicit enumerated machine" holds at 16 values; no principle removed → not even a PATCH-worthy edit).

**Rationale**: Repo convention (MEMORY "Corrective work = new referencing slice"): the PRD is the product
source of truth and is the amend target; shipped specs are referenced. The "18 values" framing lives in
003's spec/research (frozen), not the constitution, so no constitution amendment is needed.
