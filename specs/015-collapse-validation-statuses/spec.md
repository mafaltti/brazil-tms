# Feature Specification: Collapse Validation Statuses into "Recebida"

**Feature Branch**: `015-collapse-validation-statuses`

**Created**: 2026-06-07

**Status**: Draft

**Input**: User description: "Simplify trip status — 'Recebida', 'Erro de validação', 'Validada' become a single 'Recebida'."

---

## Context & Traceability *(references, not edits)*

This is a **corrective, cross-cutting slice** in the spirit of the PRD's single trip status
machine (PRD §12 / §12.1). It **references** shipped slices and **supersedes** one decision:

- **003 — Trip Domain & Lifecycle**: owns the canonical status machine and transition table.
- **004 — Trip Import & Validation**: import-time per-row validation (Valid / Warning / Error)
  is the only validation gate; only Valid/Warning rows are applied.
- **006 — Dispatch & Assignment**: assign / unassign / confirm flows.
- **013 — Predefined Import Template**: imported trips land via the standard format.
- **014 — Auto-Validate Imported Trips**: made imported trips *born `Validada`* and narrowed the
  dispatch queue to `Validada`. **This slice supersedes that decision** (born `Recebida` instead).

It **does NOT edit** any shipped spec. It **amends** `docs/PRD.md` (§7, §9.1, §11.2/11.3/11.4,
§12, §12.1, §19.1, §30). The **constitution is not amended** (Principle III — "explicit enumerated
state machine with declared legal transitions" — holds equally for a 16-value machine).

---

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Dispatch a trip straight from "Recebida" (Priority: P1)

After importing a batch of customer trips, the dispatcher opens the Expedição (dispatch) queue and
sees the newly imported trips listed as **"Recebida"**, ready to assign. They pick a trip, attach a
driver/vehicle, and assign it — moving it directly to **"Atribuída"**. There is **no separate
"Validar" step** to perform first: a trip that passed import validation is already dispatchable.

**Why this priority**: This is the core of the simplification and the user's stated goal. It removes
a redundant operator hop and resolves the long-standing trap where imported/manual trips were
stranded in a non-dispatchable state. Without it, nothing else in the slice has value.

**Independent Test**: Import and confirm a standard batch; open the dispatch queue; verify the trips
appear as "Recebida"; assign one and verify it becomes "Atribuída" with no `ILLEGAL_TRANSITION` error
and no intermediate validation step.

**Acceptance Scenarios**:

1. **Given** a confirmed import that created new trips, **When** the dispatcher opens the dispatch
   queue, **Then** those trips appear as "Recebida" and are offered an "Atribuir" action.
2. **Given** an unassigned "Recebida" trip in the dispatch queue, **When** the dispatcher assigns a
   driver/vehicle, **Then** the trip moves "Recebida" → "Atribuída" and leaves the unassigned queue.
3. **Given** the trip lifecycle UI, **When** the dispatcher inspects any trip, **Then** the statuses
   "Validada" and "Erro de validação" never appear (they are not selectable, displayable, or
   reachable).

---

### User Story 2 - Unassigning returns a trip to "Recebida" (Priority: P2)

A dispatcher who assigned a trip in error removes the assignment. The trip returns to **"Recebida"**
(its dispatchable state) and reappears in the dispatch queue so it can be reassigned. The dialog text
reflects this ("os recursos serão removidos e a viagem voltará para **Recebida**").

**Why this priority**: Unassign is an existing capability whose return target was the now-removed
"Validada"; it must land somewhere valid and dispatchable. Important for correctness but secondary to
the primary assign flow.

**Independent Test**: Assign a "Recebida" trip, then unassign it; verify the trip is "Recebida"
again, reappears in the dispatch queue, and the confirmation copy reads "Recebida".

**Acceptance Scenarios**:

1. **Given** an "Atribuída" trip, **When** the dispatcher removes the assignment, **Then** the trip
   becomes "Recebida" and reappears as unassigned in the dispatch queue.
2. **Given** the unassign confirmation dialog, **When** it is shown, **Then** it states the trip will
   return to "Recebida".

---

### User Story 3 - Existing trips in the removed states are resolved (Priority: P3)

When the change is rolled out, any trip already sitting in "Validada" or "Erro de validação" is
resolved to **"Recebida"** so it renders correctly, stays dispatchable, and never shows a blank or
broken status. No trip is stranded by the vocabulary change.

**Why this priority**: A data-correctness safeguard. Lower priority because it only affects
pre-existing records, but required so the rollout cannot orphan live trips.

**Independent Test**: With a trip seeded as "Validada" (and one as "Erro de validação"), apply the
change; verify both now read "Recebida", render with a proper status label/badge, and are
dispatchable.

**Acceptance Scenarios**:

1. **Given** an existing trip in "Validada", **When** the change is applied, **Then** the trip reads
   "Recebida" and is dispatchable.
2. **Given** an existing trip in "Erro de validação", **When** the change is applied, **Then** the
   trip reads "Recebida".
3. **Given** an existing trip whose dispute origin was "Validada"/"Erro de validação", **When** the
   change is applied, **Then** its recorded prior-status reference is resolved to "Recebida" so any
   dispute round-trip stays legal.

---

### Edge Cases

- **Confirm step untouched**: A trip that reaches "Atribuída" is still confirmed ("Confirmada") and
  proceeds through execution exactly as before — the confirm hop, its button, and the
  confirmation-cutoff SLA alert are unchanged.
- **Import "update" to an in-flight trip**: A later import that updates a trip already past
  "Recebida" (e.g. "Atribuída"/in execution) does **not** change its status (preserves the slice-014
  no-downgrade guarantee).
- **Import-batch status is a different concept**: The import *batch* progresses through its own
  "Validado"/"Confirmando" states in the /imports screen; these are unrelated to trip status and are
  **not** affected.
- **Re-import after the change**: Newly created trips are born "Recebida" and are immediately
  dispatchable; no re-run or manual hop is needed to make them usable.
- **Historical audit/event trail**: Past status-change history that recorded "Validada"/"Erro de
  validação" is preserved as immutable history (the append-only audit trail is not rewritten).

---

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: The trip status vocabulary MUST be reduced to **16 states** by removing **"Validada"**
  (`validated`) and **"Erro de validação"** (`validation_error`). "Recebida" (`received`) becomes the
  first dispatchable state. The retained order is: Recebida → Atribuída → Confirmada → Na origem →
  Carregando → Carregada → Em trânsito → No destino → Descarregando → Descarregada → Concluída →
  Faturamento pendente → Pronta p/ faturar → Faturada (+ Cancelada, Em disputa).
- **FR-002**: Legal transitions MUST become: "Recebida" → {Atribuída, Cancelada}; "Atribuída" →
  {Confirmada, **Recebida** (unassign), Cancelada}. All transitions from "Confirmada" onward MUST be
  unchanged. The "Validada" and "Erro de validação" transition rows MUST be removed.
- **FR-003**: Newly imported trips MUST be created in **"Recebida"** (superseding slice 014's born-
  "Validada"). Manually created trips remain "Recebida" (unchanged).
- **FR-004**: The dispatch (Expedição) assignment queue MUST list unassigned **"Recebida"** trips
  (superseding slice 014's "Validada"-only queue). Every trip it offers for assignment MUST be
  assignable without error.
- **FR-005**: Assignment MUST run "Recebida" → "Atribuída". Unassignment MUST run "Atribuída" →
  "Recebida". The confirm step ("Atribuída" → "Confirmada") MUST remain in the lifecycle, unchanged.
- **FR-006**: Existing trips in the removed states MUST be resolved to "Recebida" ("Validada" →
  "Recebida"; "Erro de validação" → "Recebida"), including any recorded prior-status reference used
  by the dispute round-trip. Existing trips MUST NOT be deleted, and historical status-change records
  MUST be preserved as-is.
- **FR-007 (no-regression)**: The following MUST remain functionally unchanged: the "Confirmada"
  status and the entire confirm flow (confirm action, confirmation timestamps, the "Confirmar"
  control); the confirmation-cutoff SLA signal and its alert/metric; the rule that plan edits to a
  trip in execution require authorized review; all transitions from "Confirmada" onward; the import
  *batch* status lifecycle; audit semantics; and import row-validation and duplicate detection.
- **FR-008**: `docs/PRD.md` MUST be amended so the status table (§12) and transition table (§12.1)
  reflect the 16-state machine, the affected workflow prose (§7, §11.2/11.3/11.4, §19.1) no longer
  describes a separate validate hop, and §30 records this collapse as a labeled decision that
  supersedes slice 014's born-"Validada" decision.
- **FR-009**: No status label that previously read "Validada" or "Erro de validação" may remain
  anywhere operators can see it (status badges, filters, queues, dialogs, audit/inspector views) —
  every such surface MUST show "Recebida" or omit the removed values.

### Key Entities *(include if feature involves data)*

- **Trip**: Has a single `current_status` drawn from the trip status machine. After this change its
  pre-dispatch state is "Recebida" (no "Validada"/"Erro de validação").
- **Trip Status Machine**: The one enumerated set of states + declared legal transitions (PRD §12.1).
  Reduced from 18 to 16 active states; "Confirmada"-onward unchanged.
- **Dispatch (Expedição) Queue**: The list of unassigned, dispatchable trips. Its membership rule
  changes from "Validada" to "Recebida".
- **Import Batch**: A separate concept with its **own** status lifecycle (including its own
  "Validado"/"Confirmando" states). Explicitly **out of scope** and unchanged — named here only to
  prevent conflation with trip status.

---

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: A trip is dispatchable (assignable) immediately after import confirmation, with **zero**
  intermediate operator steps between "trip created" and "assign".
- **SC-002**: The operator-visible trip status vocabulary contains exactly **16** states; "Validada"
  and "Erro de validação" appear in **0** UI surfaces.
- **SC-003**: **100%** of trips previously in "Validada" or "Erro de validação" display as "Recebida"
  after rollout, with none stranded, blank, or unrenderable.
- **SC-004**: For every trip shown in the dispatch queue, assignment succeeds (a **0%**
  illegal-transition failure rate for queued trips).
- **SC-005**: Confirm-step and "Confirmada"-onward behaviors (confirmation, execution milestones,
  billing progression, confirmation-cutoff SLA alert) are unchanged — **no** regression in the
  existing automated suite for those flows.
- **SC-006**: Unassigning a trip returns it to "Recebida" and it reappears in the dispatch queue
  **100%** of the time.

---

## Assumptions

- **Import validation is sufficient validation**: Because import applies only Valid/Warning rows, a
  created trip is inherently valid; a separate trip-level validate state adds no information and is
  therefore removed (not relabeled).
- **Non-destructive data resolution**: Existing trips in the removed states are migrated to
  "Recebida" rather than deleted; the immutable audit/event history that recorded the old states is
  left intact. (Migration mechanics are a planning concern, not part of this spec.)
- **Confirm capability is retained as-is**: The "Confirmada" status, the confirm action, confirmation
  timestamps, and the confirmation-cutoff SLA/metric remain. This slice deliberately does **not**
  touch the assign↔confirm portion of the machine.
- **Import-batch status is untouched**: The import *batch* lifecycle (which separately includes a
  "Validado" state) is a different concept and is not modified.
- **No new UI is introduced**: The validate hop is removed, not replaced by a manual "Validar"
  action; there is nothing new for operators to learn.
- **PRD is the amend target; shipped specs are referenced only**: Per repo convention, the WHAT is
  updated in `docs/PRD.md`; shipped slice specs (003/004/006/013/014) are not edited.

## Out of Scope *(Future)*

- Removing "Confirmada" or the confirm step; collapsing "Atribuída"/"Confirmada".
- Any new trip status, or any SLA redesign beyond leaving the confirmation cutoff intact.
- Changing the import *batch* status lifecycle.
- Changing customer status-mapping value sets beyond what the removal forces.
- Backfilling anything other than the two removed trip statuses.
- A manual "Validar" UI action or a reintroduced readiness gate.
