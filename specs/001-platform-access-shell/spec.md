# Feature Specification: Platform, Access, and App Shell

**Feature Branch**: `001-platform-access-shell`

**Created**: 2026-05-29

**Status**: Draft

**Input**: User description: "001 - Platform, Access, And App Shell. Primary outcome: Users can log in, reach the authenticated app shell, and operate under a role-aware permission model. Source docs: docs/PRD.md sections 13.13, 15.1, 15.12, 18, 21.4, 21.6, 22 Phase 1, 23; docs/STACK.md; docs/PRINCIPLES.md; docs/DELIVERY-WORKFLOW.md; docs/SPEC-SLICING.md. Primary requirement IDs: AUTH-001, AUTH-002, AUTH-003, AUTH-005."

> **Feature slice**: This is feature **001** in `docs/SPEC-SLICING.md`. It is the platform foundation that every later feature depends on. It is intentionally bounded to **platform, access, roles, the authenticated app shell, the Users & Roles administration area, an audit foundation, and i18n scaffolding**. All operational domains (master data, trips, import, dispatch, documents, billing, reports) are owned by features 002–009 and are out of scope here.

---

## Clarifications

### Session 2026-05-29

- Q: When an administrator creates a new user, how does that user obtain their initial access (first password)? → A: Both supported — the administrator can either send an invite/set-password email (user sets their own password; user starts in a pending state until first sign-in) or set an initial temporary password the user must change on first login.
- Q: Which role(s) may view the audit log in this feature (001)? → A: Admin only. In this slice only user/role changes are audited; broader operational audit views are owned by feature 009.
- Q: What is the brute-force / failed-login protection posture for MVP? → A: Provider rate-limiting only — rely on the authentication service's built-in login rate-limiting; no custom application-level account lockout in MVP; thresholds are configurable provider defaults.
- Q: What session timeout policy should MVP use? → A: Rolling session with token refresh that stays valid while actively used and expires after an idle period; idle window and absolute max lifetime are configurable defaults.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Sign in and reach the app (Priority: P1)

An internal Brazil Transports employee opens the application, enters their email and password, and lands on the authenticated home shell. If they are not signed in, any attempt to open an internal area sends them to the login screen. They can sign out, and they can recover access through a "Esqueci minha senha" (forgot password) flow.

**Why this priority**: Without authentication there is no product. This is the minimum slice that delivers value on its own — a person can prove who they are and get into a protected workspace. Every other story depends on it.

**Independent Test**: Provision one user, sign in with valid credentials and confirm arrival at the authenticated shell; sign in with invalid credentials and confirm a clear error and no session; while signed out, open a deep link to an internal area and confirm redirection to login; sign out and confirm the session ends; trigger the forgot-password flow and confirm a reset can be completed.

**Acceptance Scenarios**:

1. **Given** a registered, active user, **When** they submit a correct email and password, **Then** they are authenticated and shown the authenticated app shell.
2. **Given** an unauthenticated visitor, **When** they request any authenticated area, **Then** they are redirected to the Login screen and shown no protected content.
3. **Given** an authenticated user, **When** they sign out, **Then** their session is ended and protected areas again require login.
4. **Given** a user who forgot their password, **When** they use the forgot-password flow, **Then** they can set a new password and sign in with it.
5. **Given** an email that is not registered, **When** it is submitted to forgot-password, **Then** the system responds neutrally and does not reveal whether the account exists.
6. **Given** a disabled user, **When** they attempt to sign in, **Then** access is denied.

---

### User Story 2 - Operate under a role-aware permission model (Priority: P1)

Each user is assigned exactly one role. The authenticated shell shows that user only the navigation and areas their role permits, and every protected action and data read is checked server-side against the role's permissions before it is allowed. A user can never perform an action their role forbids, even by calling the underlying endpoint directly.

**Why this priority**: Role-aware access is the second half of the primary outcome and the foundation every later feature reuses to decide who may import, assign, complete, bill, export, or delete. It must exist and be authoritative before any operational feature is built.

**Independent Test**: Create users across the 7 MVP roles; for each, confirm the shell exposes only permitted areas, that a permitted action succeeds, that a forbidden action is refused in the UI, and that issuing the forbidden action directly (bypassing the hidden UI) is also refused and changes no data.

**Acceptance Scenarios**:

1. **Given** a user with role Finance, **When** they open the app, **Then** the shell presents only the areas their role permits and hides the rest.
2. **Given** a user whose role does not permit an action, **When** they attempt that action through any path (UI or direct request), **Then** it is refused, an authorization error is returned, and no state changes.
3. **Given** a user with role Admin, **When** they perform an action reserved for Admin, **Then** it succeeds.
4. **Given** any user, **When** their assigned role is evaluated, **Then** exactly one role applies (no multi-role users in MVP).
5. **Given** a role whose permissions match the §18 permission matrix, **When** each matrix action is exercised, **Then** the allow/deny result matches the matrix for that role.

---

### User Story 3 - Administer users and roles (Priority: P2)

An administrator opens the Administration area, manages the list of users, creates a new user with a name, email, and a single assigned role, and can enable or disable users. Only an administrator (a role granted "Manage users") can reach this area; everyone else is denied.

**Why this priority**: User and role administration is what makes stories 1 and 2 usable in practice — it is how accounts and roles come to exist — but the platform can be demonstrated end to end with seeded users before this UI exists, so it ranks just below the access primitives.

**Independent Test**: As an administrator, create a user with a role and confirm that user can sign in and sees role-appropriate navigation; change a user's role and disable a user; confirm a non-administrator cannot open or act in the Users & Roles area.

**Acceptance Scenarios**:

1. **Given** an administrator, **When** they create a user with name, email, and one role and choose the invite path, **Then** the user is persisted in the pending state, receives an invite to set their password, and becomes active on first sign-in.
2. **Given** an administrator, **When** they create a user and set an initial temporary password, **Then** the user can sign in and is required to change the password on first sign-in.
3. **Given** an administrator, **When** they change a user's role or disable a user, **Then** the change takes effect on that user's next request or sign-in.
4. **Given** a non-administrator, **When** they attempt to open or act in the Users & Roles area, **Then** they are denied.
5. **Given** an existing user's email, **When** an administrator tries to create another user with the same email, **Then** the system rejects the duplicate.
6. **Given** the last remaining active administrator, **When** an attempt is made to disable or down-role that account, **Then** the system prevents locking the system out of administration.

---

### User Story 4 - Audit foundation for critical actions (Priority: P2)

The system records an immutable audit entry for critical actions. In this slice the critical actions are user and role administration changes (and, where applicable, security-relevant access events). Each entry captures what changed, the before/after values, who did it, and when, with an optional note. Later features reuse the same mechanism for their own critical actions.

**Why this priority**: AUTH-005 requires audit history for critical actions, and the slice exit criteria require the reusable audit helper to exist even if lightly used here. It is foundational but only lightly exercised in this feature, so it sits alongside administration rather than ahead of access.

**Independent Test**: Perform a critical action (e.g., change a user's role), then retrieve the audit history and confirm an entry exists with entity type/id, action, previous value, new value, acting user, timestamp, and that the entry cannot be edited or deleted through the application.

**Acceptance Scenarios**:

1. **Given** an administrator changes a user's role, **When** the change is saved, **Then** an audit entry is created with entity type, entity id, action, previous value, new value, acting user, and timestamp.
2. **Given** an existing audit entry, **When** any user attempts to modify or delete it through the application, **Then** the attempt is refused (audit history is append-only).
3. **Given** a critical user/role change, **When** the audit history is reviewed, **Then** that change is present (no critical user/role change is missing).
4. **Given** a non-Admin user, **When** they attempt to view audit history, **Then** they are denied; only Admin may view it in this feature.

---

### Edge Cases

- **Invalid credentials**: a clear, non-revealing error is shown; no session is created.
- **Repeated failed logins**: protection relies on the authentication service's built-in rate-limiting (configurable thresholds); there is no custom application-level account lockout in MVP.
- **Disabled user mid-session**: a user disabled while signed in loses access on their next protected request.
- **Session expiry**: sessions are rolling (refreshed while in use) and expire after a configurable idle period or absolute maximum; when a session expires, the next protected action redirects to login.
- **Role change mid-session**: a role change applies on the user's next request or sign-in; in-flight authorization always reflects the currently stored role.
- **Last administrator protection**: the system prevents disabling or down-roling the final active administrator so the platform cannot be locked out of user management.
- **Duplicate email**: user creation with an already-registered email is rejected.
- **Forgot-password for unknown email**: response is neutral and does not disclose account existence.
- **Direct endpoint access**: a forbidden action invoked directly (without the UI) is denied identically to the UI path.
- **Deep link while signed out**: redirected to login; returning the user to the originally requested area after login is allowed but not required for MVP.
- **Customer Viewer selection attempt**: the Customer Viewer role is reserved for a later release and cannot be assigned to a user in MVP.

## Requirements *(mandatory)*

### Functional Requirements

**Authentication & session**

- **FR-001**: The system MUST authenticate users with email and password. Accounts are provisioned by an administrator; there is no public self sign-up. *(AUTH-001; PRD §15.1)*
- **FR-002**: The system MUST require an authenticated session for every internal area and redirect unauthenticated requests to the Login screen, exposing no protected content. *(AUTH-001)*
- **FR-003**: Users MUST be able to sign out, ending their session.
- **FR-003a**: Sessions MUST use a rolling model with token refresh: a session stays valid while actively used and expires after a configurable idle period, with a configurable absolute maximum lifetime. On expiry, the next protected action MUST redirect to Login. *(Clarification 2026-05-29)*
- **FR-004**: Users MUST be able to recover access through a forgot-password flow; responses MUST NOT disclose whether a given email is registered. *(PRD §15.1)*
- **FR-005**: A disabled user MUST NOT be able to authenticate or retain an active session. *(PRD §14 User status active/disabled)*

**Roles & authorization**

- **FR-006**: Each user MUST have exactly one role; multi-role assignment is out of scope for MVP. *(AUTH-002; PRD §14 "one role per user for MVP")*
- **FR-007**: The system MUST define a fixed enumeration of MVP roles: Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator, Finance, and Executive Viewer (7 internal roles). Customer Viewer MUST be reserved as a known future role and MUST NOT be assignable in MVP. *(AUTH-002; PRD §30 decision: "MVP ships 7 internal roles; Customer Viewer is post-MVP")*
- **FR-008**: The role-to-action permission mapping in PRD §18 MUST be the single source of truth for which role may create, edit, cancel, complete, mark billing-ready, export, delete, and otherwise act on records. *(AUTH-003; PRD §18)*
- **FR-009**: The system MUST enforce authorization server-side for every protected action and data read; a denied request MUST return an authorization error and MUST cause no state change. *(AUTH-003; PRD §21.4 least privilege)*
- **FR-010**: Authorization MUST be provided as a single reusable capability that later features consume, so that no later feature re-derives role rules independently. *(SPEC-SLICING 001 exit criteria; PRINCIPLES DRY)*
- **FR-011**: The app shell MUST present each user only the navigation and areas their role permits. Hiding UI is in addition to — never a substitute for — server-side enforcement (FR-009). *(AUTH-003)*

**Administration — Users & Roles**

- **FR-012**: The system MUST provide an Administration shell whose only in-scope domain for this feature is Users & Roles. Other Administration domains listed in PRD §15.12 (customers, locations, lanes, import templates, status mappings, reason codes, document requirements, SLA rules, rate tables) MUST be treated as deferred and MUST NOT be implemented here. *(PRD §15.12)*
- **FR-013**: An administrator (a role granted "Manage users") MUST be able to create a user with name, email, and one assigned role, and MUST be able to enable or disable a user. *(PRD §18 "Manage users" = Admin)*
- **FR-013a**: When creating a user, the administrator MUST be able to onboard them by EITHER (a) sending an invite/set-password email so the user sets their own password on first access, OR (b) setting an initial temporary password that the user MUST change on first sign-in. A user onboarded via invite remains in the **pending** state until first successful sign-in, after which they become **active**. *(Clarification 2026-05-29)*
- **FR-014**: Only roles granted "Manage users" MUST be able to access or act within the Users & Roles area; all other roles MUST be denied. *(PRD §18; AUTH-003)*
- **FR-015**: The system MUST treat email as the unique login identifier and MUST reject creation of a second user with an existing email. *(PRD §14 User: "Email (login identifier)")*
- **FR-016**: The system MUST prevent disabling or down-roling the last active administrator. *(Derived safeguard; least-privilege/operability)*

**Audit foundation**

- **FR-017**: The system MUST provide an audit capability that records, for a critical action: entity type, entity id, action, previous value, new value, acting user, timestamp, and an optional reason/note. *(AUTH-005; PRD §14 Audit Log)*
- **FR-018**: User and role administration changes (create, role change, enable/disable) MUST be recorded as audit entries. *(AUTH-005; STACK §5.4 "Permission and user changes")*
- **FR-019**: Audit records MUST be append-only (immutable); the application MUST NOT allow editing or deleting them. *(STACK §3.7 "immutable event/audit records")*
- **FR-020**: The audit capability MUST be reusable so later features record their critical actions through the same mechanism. *(SPEC-SLICING 001 exit criteria)*
- **FR-020a**: In this feature, only the Admin role MUST be able to view audit history; all other roles MUST be denied. Broader, operational-record audit views are owned by feature 009 and are out of scope here. *(Clarification 2026-05-29; PRD §18 least-privilege alignment)*

**Localization (pt-BR) & i18n scaffolding**

- **FR-021**: All user-facing UI MUST ship in Brazilian Portuguese (pt-BR) as the production language, delivered through an i18n mechanism present from day one; user-facing strings MUST NOT be hard-coded. *(PRD §21.6; §30 "i18n from day one; MVP UI in pt-BR")*
- **FR-022**: The system MUST store timestamps in UTC and display them in the America/Sao_Paulo timezone using Brazilian date/time formats; monetary values, where shown, MUST use BRL. (No monetary values are displayed in feature 001; the BRL formatter is a shared helper first consumed by later features. Timestamp display applies here — e.g. last-login and audit times.) *(PRD §21.6; STACK §3.5)*

**Platform access boundary**

- **FR-023**: The browser MUST NOT access the data store directly; all data access MUST flow through server-side application endpoints (the BFF), and the privileged data credential MUST remain server-only. *(STACK §5.1, §5.2 — see Out of Scope: direct browser access; configurable permissions table)*

### Key Entities *(include if feature involves data)*

- **User**: The application profile and role binding for a person who can sign in. Attributes: name, email (the unique login identifier), exactly one role, status (**pending** / **active** / **disabled**), a forced-password-change flag (set for the temp-password onboarding path; see FR-013a), last-login timestamp, created/updated timestamps. A user onboarded via invite is **pending** until first sign-in, then **active**; a user given an initial password starts **active** with a forced password change on first sign-in. Authentication credentials are held by the platform authentication service, not by this profile. *(PRD §14; Clarification 2026-05-29)*
- **Role (fixed enum)**: A closed set of MVP roles — Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator, Finance, Executive Viewer — each mapped to a permission set defined by the PRD §18 matrix. Customer Viewer is a reserved future value, not assignable in MVP. Roles are an enum in code, not a customer-configurable table. *(PRD §18, §30)*
- **Audit Log entry**: An immutable record of a critical action. Attributes: entity type, entity id, action, previous value, new value, acting user, timestamp, optional reason/note. *(PRD §14)*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: 100% of authenticated areas are unreachable without a valid session — every protected route redirects an unauthenticated visitor to login and reveals no protected content.
- **SC-002**: Across all 7 MVP roles, a user can perform exactly the actions their role permits per the §18 matrix and zero forbidden actions succeed. *(In feature 001 this is validated at the permission-catalog level for all roles × all matrix actions, plus end-to-end for the two permissions that have enforcement points here — `manage_users` and `view_audit_log`. End-to-end enforcement of the remaining matrix actions completes as features 002–009 add their endpoints.)*
- **SC-003**: Any forbidden action attempted by bypassing the UI (direct request) is denied 100% of the time and results in no data change.
- **SC-004**: An administrator can create a new user who then signs in successfully, end to end, in under 3 minutes and with no engineering involvement.
- **SC-005**: 100% of critical user/role administration changes produce a retrievable audit entry containing all required fields, and no such entry can be altered or removed through the application.
- **SC-006**: 100% of shipped user-facing screens render in pt-BR with no untranslated or hard-coded strings.
- **SC-007**: A disabled user loses access on their next protected request 100% of the time.

## Assumptions

- **Provisioning model**: This is an internal TMS; users are administrator-provisioned and there is no public self sign-up. Onboarding supports both an invite/set-password email (user sets their own password; user is pending until first sign-in) and an admin-set initial temporary password (forced change on first sign-in).
- **Password policy & reset delivery**: Password strength rules and reset-email delivery rely on the platform's standard authentication capabilities. No business-specified password policy was provided, so policy values are configurable defaults rather than hard-coded; this is a configurable default, not a blocking gap.
- **Brute-force protection**: Login throttling relies on the authentication service's built-in rate-limiting with configurable thresholds; no custom account-lockout logic is built in MVP.
- **Role change timing**: Role and status changes take effect on the affected user's next request or sign-in (not retroactively on in-flight requests).
- **Session policy**: Rolling session with token refresh; idle window and absolute maximum lifetime are configurable defaults (no business-specified durations were provided).
- **"Limited" permissions**: Where the §18 matrix marks a role's action as "Limited," the precise constraint is finalized by the feature that owns that action (e.g., trip edit, cancel, document upload). This feature establishes the permission model and reusable checks but does not finalize the semantics of "Limited" cells.
- **Customer Viewer**: The Customer Viewer role value is reserved but intentionally non-selectable in MVP; tenant-scoped customer data access (AUTH-004) is deferred (see Out of Scope).
- **Single shipped locale**: pt-BR is the only locale shipped for MVP; the i18n mechanism is structured so additional locales can be added later without re-architecting.
- **Seeded users for early demo**: Stories 1 and 2 can be demonstrated with seeded users before the Users & Roles admin UI (Story 3) exists.

## Out of Scope

The following are explicitly excluded from this feature:

- **Single sign-on (SSO)** — AUTH-006, marked Later.
- **Customer Viewer access & tenant-scoped customer data segregation** — AUTH-004, marked Later; Customer Viewer is post-MVP per the §30 decision log.
- **Configurable / customer-editable permissions table** — roles are a fixed enum; a permissions table is introduced only if roles become customer-configurable (post-MVP).
- **Multi-role users** — exactly one role per user in MVP.
- **Direct browser access to the data store / publicly exposed data gateway** — all access is server-side through the BFF.
- **Supabase Realtime and Edge Functions** — not used for MVP; freshness is polling.
- **Other Administration domains** — customers, locations, lanes, import templates, status mappings, reason codes, document requirements, SLA rules, and rate tables are owned by features 002–008 and appear here only as deferred (placeholder or absent).
- **All other operational features** — master data, trips, the trip status machine, import, dispatch, execution/exceptions, documents, billing, and reports (features 002–009).

## Dependencies, Constraints & Gating Inputs

**Governing constraints inherited from STACK / PRINCIPLES / DELIVERY-WORKFLOW** (these govern HOW and are non-negotiable for this feature):

- Authentication is handled by the platform authentication service (Supabase Auth); **authorization is enforced in the Next.js BFF**, which is the single source of truth for permissions in MVP. *(STACK §3.8)*
- Database **RLS is deferred**; the BFF is the sole authorization point; the privileged (service-role) credential is **server-only**; the data API gateway is **never exposed publicly**. *(STACK §5.1, §5.2, §3.7)*
- One app + one worker; **no microservices, no external broker, no Realtime, no Edge Functions**. *(STACK §2, §3.10, §3.11, §4.1)*
- Monorepo layout `apps/web`, `packages/{shared,db}`, `workers/`, `infra/`; start with the two packages `shared` and `db` and split only after ≥3 real repetitions. *(STACK §7; PRINCIPLES)*
- KISS / DRY / YAGNI: do **not** build a configurable permissions table for a fixed role enum; collapse roles with identical permissions until they genuinely diverge. *(PRINCIPLES; STACK §3.8)*
- Delivery: work on a short-lived branch off `dev`; the feature PR targets **`dev`, never `main`**; AI must not merge to `main`. Quality gates (lint, typecheck, tests, build) must pass; permission checks are an explicit test target (Vitest + Playwright). *(DELIVERY-WORKFLOW)*

**Gating inputs (PRD §29) and sign-off status**:

- This feature requires **no customer, SLA, document, or billing business inputs**. None of the §29 data-input gates (Inputs #1–#5) apply to platform/access/shell. **Final sign-off for this feature is therefore not blocked by §29 business inputs.**
- §29 **Input #7** (Business confirmation that there is *no hard ERP/GPS/document integration dependency for MVP*) is a Phase-1 scope guard. It should be confirmed during this phase but does **not** block building authentication, the app shell, or the permission model. If this confirmation is not obtained, it is a scope-control flag, not an implementation blocker for 001.

**Reconciliation note (recorded, not a clarification)**: PRD AUTH-002 lists 8 roles including Customer Viewer and is marked MVP, while the §30 decision log states "MVP ships 7 internal roles; Customer Viewer is post-MVP." This spec **adopts the decision log**: 7 internal roles are MVP, Customer Viewer is reserved/post-MVP (consistent with AUTH-004 being Later).

## Traceability (PRD Mapping)

| Spec item | PRD requirement / section |
|---|---|
| FR-001, FR-002, FR-003, FR-005 / SC-001, SC-007; Story 1 | AUTH-001; PRD §15.1 (Login); §14 (User.status) |
| FR-004; Story 1 (forgot password) | PRD §15.1 ("Forgot password") |
| FR-006, FR-007; Story 2 | AUTH-002; PRD §14 ("one role per user"); §30 ("7 internal roles; Customer Viewer post-MVP") |
| FR-008, FR-009, FR-010, FR-011 / SC-002, SC-003; Story 2 | AUTH-003; PRD §18 (permission matrix); §21.4 (least privilege, RBAC) |
| FR-012; Story 3 | PRD §15.12 (Administration — Users and roles) |
| FR-013, FR-014, FR-015, FR-016 / SC-004; Story 3 | AUTH-003; PRD §18 ("Manage users" = Admin); §14 (User: email = login id) |
| FR-017, FR-018, FR-019, FR-020 / SC-005; Story 4 | AUTH-005; PRD §14 (Audit Log); §21.4 (audit trail); STACK §5.4 (audit "Permission and user changes"), §3.7 (immutable) |
| FR-021, FR-022 / SC-006 | PRD §21.6 (Localization); §30 ("i18n from day one; MVP UI pt-BR"); STACK §3.5 |
| FR-023 | STACK §5.1, §5.2 (BFF-only access, service-role server-only, no public gateway) |
| Phase context / exit criteria | PRD §22 Phase 1 ("User authentication", "Basic roles and permissions"); SPEC-SLICING 001 exit criteria |
| Acceptance alignment | PRD §23 ("Permission rules prevent unauthorized operational and billing changes"; "Critical changes appear in audit history") |
| Out of scope: SSO | AUTH-006 (Later) |
| Out of scope: Customer Viewer / tenant scoping | AUTH-004 (Later); PRD §30 |

> **Note on PRD §23**: §23 contains no standalone acceptance line for login, app-shell navigation, or pt-BR specifically. The two §23 criteria above are the ones this feature underpins; login/shell/i18n acceptance is captured by this spec's Success Criteria (SC-001, SC-004, SC-006) and traced to §15.1, §22 Phase 1, and §21.6.
