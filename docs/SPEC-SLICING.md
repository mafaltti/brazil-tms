# Spec Kit Feature Slicing Guide

This document explains how to turn the large PRD into smaller Spec Kit features without losing coverage.

Use `docs/PRD.md` as the product source of truth. Use this file as the slicing and traceability guide when creating each feature spec.

## Core Rule

Do not create one Spec Kit feature for the whole PRD.

A Spec Kit feature should be one reviewable product increment with:

- A clear user-facing outcome.
- A bounded set of PRD requirement IDs.
- A small number of screens or workflows.
- Explicit data model changes.
- Explicit permissions and audit behavior.
- Clear out-of-scope items.
- Clear dependency on business inputs from PRD Section 29.

## Workflow

For each feature slice:

1. Pick the next feature from the slice map below.
2. Copy only the relevant PRD sections and requirement IDs into the `/speckit-specify` prompt.
3. Include the global constraints from this file.
4. Run `/speckit-clarify` before planning.
5. If a required business input is unavailable, keep the implementation configurable and mark final sign-off as blocked.
6. Run `/speckit-checklist`, `/speckit-plan`, `/speckit-tasks`, `/speckit-analyze`, then `/speckit-implement`.
7. Before opening a PR, confirm the feature's requirement IDs are covered or explicitly deferred.

## Global Constraints For Every Feature

Every spec should inherit these constraints:

- Product is a linehaul execution system, not route optimization.
- MVP UI ships in Portuguese (`pt-BR`) with i18n scaffolding from day one.
- Canonical business timezone is `America/Sao_Paulo`; store timestamps in UTC.
- Web app uses Next.js App Router, TypeScript, Tailwind CSS, shadcn/ui, TanStack Query, TanStack Table, Zod, and Luxon.
- Backend access goes through the Next.js BFF under `/app/api/*`.
- Supabase service role key stays server-only.
- Authorization is enforced in the BFF for MVP.
- Supabase Realtime and Edge Functions are not used for MVP.
- Long-running work goes to the worker and Postgres-backed job queue.
- Heavy import/export processing does not run directly inside request/response handlers.
- Polling via TanStack Query is the freshness mechanism.
- Critical operational changes must produce audit history.
- Follow KISS, DRY, and YAGNI from `docs/PRINCIPLES.md`.
- Feature PRs target `dev`, never `main`.

## Slice Map

### 001 - Platform, Access, And App Shell

Primary outcome:

- Users can log in, reach the authenticated app shell, and operate under a role-aware permission model.

Owns:

- PRD sections: 13.13, 15.1, 15.12, 18, 21.4, 21.6.
- Requirement IDs: AUTH-001, AUTH-002, AUTH-003, AUTH-005.
- Data entities: User, fixed Role enum, Audit Log foundation.
- Screens: Login, Administration shell for users and roles.
- Stack concerns: monorepo layout, Next.js app shell, Supabase Auth connection, BFF auth context, i18n setup.

Important scope notes:

- Customer Viewer is post-MVP even though it appears in the broad role list. The decision log says tenant-scoped customer access is deferred.
- SSO is later.
- Do not create a configurable permissions table unless roles become customer-configurable later.

Exit criteria:

- Internal users can authenticate.
- BFF endpoints can identify the current user and role.
- Permission checks can be reused by later features.
- Critical action audit helper exists, even if only used lightly in this slice.

### 002 - Master Data And Operational Configuration

Primary outcome:

- Authorized users can maintain the master data required to execute trips.

Owns:

- PRD sections: 13.1, 13.2, 13.6, 14.1, 15.7, 15.12.
- Requirement IDs: CUST-001, CUST-002, LANE-001, LANE-002, LANE-003, LANE-004, RES-001, RES-002, RES-003, RES-004, RES-005, RES-006, RES-007.
- Data entities: Customer, Location, Lane, Driver, Vehicle, Trailer, Carrier.
- Screens: Resource Management, Administration master data areas.

Important scope notes:

- Customer import templates are owned by Feature 004.
- Customer SLA rules are owned by Feature 007.
- Customer document requirements are owned by Feature 008.
- Resource calendars are later.

Exit criteria:

- Users can maintain customers, locations, lanes, drivers, vehicles, trailers, and carriers.
- Active, inactive, unavailable, maintenance, and blocked statuses exist where required.
- Later assignment features can query clean master data.

### 003 - Trip Domain, Status Machine, And Audit Semantics

Primary outcome:

- The system has a durable trip model, status lifecycle, billing status lifecycle, and audit rules before import and operational screens depend on them.

Owns:

- PRD sections: 12, 13.4, 14.1, 19.3, 19.5, 21.5.
- Requirement IDs: TRIP-006, TRIP-007.
- Data entities: Trip, Trip Event foundation, Audit Log expansion.
- Business rules: allowed status transitions, cancellation rules, original plan versus executed data.

Important scope notes:

- This slice does not need the final control tower UI.
- Manual trip creation is owned by Feature 004.
- Timeline interaction is owned by Feature 007.
- Billing Ready enforcement is owned by Feature 008.

Exit criteria:

- Trip statuses and allowed transitions are explicit.
- Planned customer values are separated from execution events.
- Changes to critical fields produce audit records.
- Later import, dispatch, execution, and billing features use the same status model.

### 004 - Trip Import, Templates, Validation, And Duplicate Handling

Primary outcome:

- Operations can upload customer trip plans, validate rows, detect duplicates, and create or update trips through import batches.

Owns:

- PRD sections: 11.1, 11.2, 13.1, 13.2, 13.3, 14.1, 15.3, 19.1, 20.1, 22 Phase 2, 23.
- Requirement IDs: CUST-003, LANE-005, INT-001, INT-002, INT-003, INT-004, INT-005, INT-006, INT-007.
- Data entities: Import Template, Import Batch, Status Mapping.
- Screens: Trip Import.
- Worker jobs: parse uploaded file, validate rows, detect duplicates, generate error report, confirm import.

Gated by PRD Section 29:

- Input 1: real sample files from Shopee, DHL eCommerce, and Mercado Livre.

Important scope notes:

- API-based ingestion and email attachment ingestion are later.
- If real customer files are unavailable, build the template engine and tests with sample fixtures but mark customer config sign-off as blocked.
- A repeated external trip ID is an update or no-op, not a blocking duplicate.

Exit criteria:

- Import creates an import batch record.
- Invalid rows have clear messages.
- Potential duplicates are flagged for review.
- Accepted rows create or update trips through the shared trip domain model.

### 005 - Control Tower, Trip List, Trip Detail, And Daily Dashboard

Primary outcome:

- Operations can see, search, filter, and inspect trips in one operating board.

Owns:

- PRD sections: 11.4, 13.4, 13.12, 15.2, 15.4, 15.5, 16, 22 Phase 2, 23.
- Requirement IDs: TRIP-001, TRIP-002, TRIP-003, TRIP-004, TRIP-005, REP-001, REP-005.
- Screens: Home Dashboard, Trip Control Tower, Trip Detail.

Important scope notes:

- Quick assignment actions are owned by Feature 006.
- Quick exception creation is owned by Feature 007.
- Documents and billing sections can appear as empty or read-only placeholders until Feature 008.
- Bulk update is later.

Exit criteria:

- Users can view and filter all trips they are permitted to see.
- Trip detail shows plan, current status, assignment placeholder, timeline placeholder, exceptions placeholder, documents placeholder, billing placeholder, notes, and audit history.
- Daily dashboard answers "what needs attention today?" at a basic level.

### 006 - Dispatch Assignment And Conflict Warnings

Primary outcome:

- Dispatchers can assign resources to trips and see conflict or eligibility warnings.

Owns:

- PRD sections: 11.3, 13.5, 14.1, 15.6, 16, 19.2, 22 Phase 3, 23.
- Requirement IDs: DISP-001, DISP-002, DISP-003, DISP-004, DISP-005, DISP-006, DISP-007, DISP-008, DISP-009.
- Data entities: Trip Assignment.
- Screens: Dispatch Board, assignment panels inside Control Tower and Trip Detail.

Important scope notes:

- Resource recommendation is later.
- Conflict checks should be authoritative in the BFF/domain layer, not only in the UI.
- Blocking versus warning behavior can start with company defaults unless customer policy is provided.

Exit criteria:

- A trip has at most one current assignment.
- Reassignments supersede older assignments and retain history.
- Assignment confirmation timestamp and notes are captured.
- Override reasons are required when permitted users bypass warnings.

### 007 - Execution Events, Exceptions, SLA Risk, And In-App Alerts

Primary outcome:

- Control tower users can track trip execution, update milestones, log exceptions, and identify SLA risk.

Owns:

- PRD sections: 11.4, 11.5, 12.2, 13.7, 13.8, 13.10, 15.5, 15.8, 17, 19.3, 20.2, 22 Phase 3, 23.
- Requirement IDs: CUST-005, EVT-001, EVT-002, EVT-003, EVT-004, EVT-005, EXC-001, EXC-002, EXC-003, EXC-004, EXC-005, EXC-006, SLA-001, SLA-002, SLA-003, SLA-004.
- Data entities: Trip Event, Exception, Customer SLA Rule, Reason Code.
- Screens: Exception Management, timeline section of Trip Detail, SLA indicators in Control Tower.
- Worker jobs: SLA risk recalculation, in-app alert generation.

Gated by PRD Section 29:

- Input 2: per-customer SLA rules.

Important scope notes:

- GPS, geofence events, automated external notifications, and configurable external alert channels are later.
- If SLA inputs are unavailable, use explicit default rules and mark customer SLA sign-off as blocked.

Exit criteria:

- Users can add standard trip events.
- Status changes record timestamp, user, and previous/new status.
- Exceptions can be created, monitored, and resolved.
- At-risk indicators exist for missing assignment, missed confirmation, delayed milestones, and high-severity open exceptions.

### 008 - Documents, Completion, Billing Readiness, Rates, And Export

Primary outcome:

- Users can attach proof documents, validate completion, mark trips billing-ready, maintain simple rates, and export billing-ready trips.

Owns:

- PRD sections: 11.6, 11.7, 13.1, 13.9, 13.11, 14.1, 15.9, 15.10, 19.3, 19.4, 20.3, 20.4, 22 Phase 4, 23.
- Requirement IDs: CUST-004, DOC-001, DOC-002, DOC-003, DOC-004, DOC-005, DOC-006, BILL-001, BILL-002, BILL-003, BILL-004, BILL-005, BILL-006, BILL-007, BILL-008.
- Data entities: Document, Document Requirement, Rate, Billing Item, Export Batch if implemented separately from Billing Item.
- Screens: Documents, Billing.
- Worker jobs: billing export generation, missing document checks.

Gated by PRD Section 29:

- Input 3: per-customer required proof documents.
- Input 4: finance billing export format.
- Input 5: billing rules for tolls, waiting time, penalties, and cancellation handling.

Important scope notes:

- Photo upload from mobile devices, OCR, customer-specific invoice layouts, and ERP integration are later.
- MVP billing should support simple rates plus manual adjustments.
- If final finance rules are missing, allow manual values and mark export sign-off as blocked.

Exit criteria:

- Required document checklist appears per customer.
- Documents can be uploaded, referenced, reviewed, accepted, rejected, or left pending.
- Billing Ready is blocked or warned when required proof is missing.
- Finance can export billing-ready trips by customer and period.
- Export batch history is recorded.

### 009 - Reporting, Audit Views, Hardening, And MVP Acceptance

Primary outcome:

- Business users can review SLA, exception, and billing readiness performance without relying on external spreadsheets as the system of record.

Owns:

- PRD sections: 9, 13.10, 13.12, 15.11, 21, 22 Phase 5, 23, 24.
- Requirement IDs: SLA-005, REP-002, REP-003, REP-004.
- Screens: Reports, audit history views where not already embedded.
- Quality focus: performance, permission coverage, audit completeness, localization coverage, UAT fixes.

Important scope notes:

- Lane performance, carrier scorecard, and profitability dashboard are later.
- Do not expand into advanced BI if MVP dashboards satisfy the acceptance criteria.

Exit criteria:

- Dashboards show SLA by customer/lane/period, exceptions, and billing readiness.
- Audit history is visible for critical operational records.
- MVP acceptance criteria from PRD Section 23 are checked end to end.
- Lint, typecheck, tests, and build pass before PR.

## Requirement Ownership Matrix

Use this matrix to make sure every MVP functional requirement has one primary owner.

| Requirement group | Primary feature |
|---|---|
| AUTH-001, AUTH-002, AUTH-003, AUTH-005 | 001 |
| AUTH-004, AUTH-006 | Later |
| CUST-001, CUST-002 | 002 |
| CUST-003 | 004 |
| CUST-004 | 008 |
| CUST-005 | 007 |
| LANE-001, LANE-002, LANE-003, LANE-004 | 002 |
| LANE-005 | 004 |
| INT-001, INT-002, INT-003, INT-004, INT-005, INT-006, INT-007 | 004 |
| INT-008, INT-009 | Later |
| TRIP-001, TRIP-002, TRIP-003, TRIP-004, TRIP-005 | 005 |
| TRIP-006, TRIP-007 | 003 |
| TRIP-008 | Later |
| DISP-001 through DISP-009 | 006 |
| DISP-010 | Later |
| RES-001 through RES-007 | 002 |
| RES-008 | Later |
| EVT-001 through EVT-005 | 007 |
| EVT-006, EVT-007 | Later |
| EXC-001 through EXC-006 | 007 |
| EXC-007 | Later |
| DOC-001 through DOC-006 | 008 |
| DOC-007, DOC-008 | Later |
| SLA-001 through SLA-004 | 007 |
| SLA-005 | 009 |
| SLA-006, SLA-007 | Later |
| BILL-001 through BILL-008 | 008 |
| BILL-009, BILL-010 | Later |
| REP-001, REP-005 | 005 |
| REP-002, REP-003, REP-004 | 009 |
| REP-006, REP-007, REP-008 | Later |

## Business Input Gates

Do not let a generated spec invent these details.

| Input | Needed before final sign-off | Feature |
|---|---|---|
| Real sample files from Shopee, DHL eCommerce, and Mercado Livre | Customer import templates and tests | 004 |
| Per-customer SLA rules | SLA status, risk thresholds, SLA reports | 007, 009 |
| Per-customer proof document requirements | Document checklist and Billing Ready blockers | 008 |
| Finance billing export format | Billing export file | 008 |
| Billing rules per customer | Billing calculations beyond manual adjustments | 008 |
| Owned-fleet versus subcontracted resource split | Resource setup and assignment policy | 002, 006 |
| Confirmation that ERP/GPS/document integrations are not hard MVP dependencies | Scope control | 001 and every later feature |

## Spec Prompt Template

Use this shape for each `/speckit-specify` prompt:

```text
Create a Spec Kit feature spec for [feature number and name].

Primary outcome:
[one sentence from this guide]

Use these source docs:
- docs/PRD.md sections: [section list]
- docs/STACK.md
- docs/PRINCIPLES.md
- docs/DELIVERY-WORKFLOW.md

Primary requirement IDs:
[IDs from this guide]

Screens/workflows:
[screens and workflows from this guide]

Data entities:
[entities from this guide]

Business rules:
[rules from this guide]

Business inputs and gates:
[inputs from PRD Section 29]

Out of scope:
[later/deferred items from this guide]

Constraints:
- Keep the spec bounded to this feature only.
- Do not include Later priority requirements except under Future Enhancements.
- Do not invent missing customer, SLA, document, or billing details.
- Use Portuguese UI labels in product behavior where relevant.
- Include a traceability section mapping acceptance criteria back to PRD IDs.
```

## Review Checklist For Each Generated Spec

Before accepting a generated Spec Kit spec, check:

- Does it list the PRD requirement IDs it owns?
- Does each acceptance criterion map to one or more PRD IDs?
- Does it mention the relevant screens and workflows?
- Does it include data entities and lifecycle rules?
- Does it state permissions and audit behavior?
- Does it include worker jobs where work is long-running?
- Does it defer Later items instead of silently implementing them?
- Does it mark missing business inputs as blocked instead of guessing?
- Does it respect the stack constraints from `docs/STACK.md`?
- Is it small enough for one reviewable PR or a short sequence of PRs?
