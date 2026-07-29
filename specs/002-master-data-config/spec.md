# Feature Specification: Master Data and Operational Configuration

**Feature Branch**: `002-master-data-config`

**Created**: 2026-05-29

**Status**: Draft — clarified 2026-05-29 (both specify-time gating inputs resolved at the master-data level; owned/subcontracted *assignment policy* remains owned by feature 006)

**Input**: User description: "002 - Master Data And Operational Configuration. Primary outcome: Authorized users can maintain the master data required to execute trips. Source docs: docs/PRD.md sections 13.1, 13.2, 13.6, 14.1, 15.7, 15.12, 22 Phase 1, 23; docs/STACK.md; docs/PRINCIPLES.md; docs/DELIVERY-WORKFLOW.md; docs/SPEC-SLICING.md. Primary requirement IDs: CUST-001, CUST-002, LANE-001, LANE-002, LANE-003, LANE-004, RES-001, RES-002, RES-003, RES-004, RES-005, RES-006, RES-007."

> **Feature slice**: This is feature **002** in `docs/SPEC-SLICING.md`. It is bounded to the **master data and operational configuration required to execute trips** — customers, locations, lanes, drivers, vehicles, trailers, and carriers — and the Administration and Resource Management screens that maintain them. It **builds on feature 001** (it reuses 001's role-aware permission model, BFF authorization, and reusable audit capability; it does not rebuild them). Trips, the trip status machine, import/templates, dispatch/assignment, execution, documents, billing, rates, and reports are owned by features 003–009 and are out of scope here. Customer-specific import templates (004), SLA rules (007), and document requirements (008) are explicitly owned by later features and are excluded.

---

## Clarifications

### Session 2026-05-29

- Q: PRD §18 pins only *archive* to Admin and never says who may **create/edit** master data — what is the create/edit role→permission mapping? → A: Split by domain — commercial data (customers, locations, lanes) → Admin + Operations Manager; fleet data (drivers, vehicles, trailers, carriers) → Admin + Operations Manager + Fleet Coordinator; **archive stays Admin-only**.
- Q: How should the owned-fleet vs subcontracted split (§29 Input #6) be modeled in master data? → A: One unified list per resource type with an explicit, **mandatory** owned/subcontracted flag; subcontracted requires a linked carrier, owned carries none. (Assignment-policy consequences remain owned by feature 006.)
- Q: Are locations customer-scoped or shared across customers? → A: **Customer-scoped** — each location belongs to one customer; a lane's origin/destination must belong to the lane's customer; location code is unique per customer.
- Q: How is "vehicle type" represented (it drives lane defaults and dispatch compatibility)? → A: **Fixed, code-defined enum** (not free text, not an admin-managed lookup); new types require a code change. Not listed among PRD §15.12 admin-managed config areas, consistent with this choice.
- Q: What is the documentation-expiry warning window ("imminent" was undefined)? → A: **Warn within 30 days** of expiry (configurable default), and mark **expired** on/after the expiry date.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Maintain customers (Priority: P1)

An authorized operator opens the Administration → Customers area, sees the list of customers, and creates a new customer with its identifying details (name, legal name, customer code, tax identifier where needed, contacts, and a billing contact). They can edit an existing customer and archive a customer that is no longer active instead of deleting it. The customer record is the anchor that later features (import templates, SLA rules, document requirements, rates) attach to, but those configuration areas are not edited here.

**Why this priority**: A customer is the top of the master-data hierarchy — lanes belong to customers and every imported trip is for a customer. Without customer records nothing downstream can be created. This slice delivers value on its own: the business can register its customers.

**Independent Test**: As an authorized user, create a customer with required fields, confirm it appears in the customer list; edit it and confirm the change persists; archive it and confirm it disappears from the active list but is not destroyed; confirm a second customer cannot reuse an already-used customer code.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they create a customer with name, legal name, customer code, and contact details, **Then** the customer is persisted and appears in the active customer list. *(CUST-001, CUST-002)*
2. **Given** an existing customer, **When** an authorized user edits its details, **Then** the changes are saved and the prior values are recorded in audit history. *(CUST-001; audit)*
3. **Given** an existing customer, **When** an authorized user archives it, **Then** it is hidden from active lists and selection pick-lists but is retained and still referenceable from historical records (no destructive delete). *(soft-delete business rule)*
4. **Given** a customer code already in use, **When** a user tries to create another customer with the same code, **Then** the system rejects the duplicate.
5. **Given** a customer record, **When** it is viewed in this feature, **Then** SLA rules, document requirements, and import-template configuration are NOT editable here (they are owned by features 007, 008, and 004 respectively).

---

### User Story 2 - Maintain locations and lanes (Priority: P1)

An authorized operator maintains origin and destination locations (name, code, address, city, state, country, gate/contact instructions, and optional geo-coordinates) and then creates lanes that connect an origin location to a destination location for a given customer, with the lane's operational attributes (expected transit time, default vehicle type, standard rate, toll estimate). Locations and lanes can be archived rather than deleted.

**Why this priority**: Lanes (origin→destination for a customer) are the structural backbone of a trip plan. A trip cannot be meaningfully planned, validated, or billed without the lane and its endpoints existing as clean master data. This is foundational and independently demonstrable.

**Independent Test**: As an authorized user, create a customer and two of its locations, then create a lane between them; confirm the lane lists its customer, origin, and destination; attempt to create a lane referencing a non-existent, archived, or different-customer location and confirm it is prevented; archive a location and confirm it is excluded from new lane selection while existing lanes that reference it are unaffected.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they create a location under a customer with name, code, address, city, state, and country, **Then** the location is persisted and available for use in that customer's lanes. *(LANE-001, LANE-002)*
2. **Given** an active customer with two of its active locations, **When** an authorized user creates a lane referencing them, **Then** the lane is persisted with its customer, origin, destination, expected transit time, default vehicle type, standard rate, and toll estimate. *(LANE-003, LANE-004)*
3. **Given** a lane being created, **When** the chosen origin and destination are the same location, **Then** the system warns or prevents the degenerate lane. *(edge case)*
4. **Given** a location referenced by one or more lanes, **When** an authorized user archives that location, **Then** it is excluded from new lane creation but existing lanes retain their reference (no orphaning, no destructive delete).
5. **Given** an authorized user, **When** they edit or archive a location or lane, **Then** the change is saved and recorded in audit history.

---

### User Story 3 - Maintain fleet resources: drivers, vehicles, and trailers (Priority: P1)

A fleet coordinator maintains the resources used to execute trips. They create and edit driver records (name, phone, license category, document expiry dates, employer/carrier, status, notes), vehicle records (plate, type, capacity, owner/carrier, document expiry dates, tracker identifier, status), and trailer records where applicable (plate, type, capacity, owner/carrier, document expiry dates, status). Each resource carries an operational status — active, inactive, unavailable, maintenance, or blocked — that reflects whether it is usable, and can be archived rather than deleted.

**Why this priority**: Drivers and vehicles are required to dispatch a trip; without resource master data the execution side of the product cannot function. Resource operational status is the mechanism the later dispatch feature relies on to know what is assignable. This slice delivers a usable fleet registry on its own.

**Independent Test**: As an authorized user, create a driver, a vehicle, and a trailer; set each one through the five operational statuses (active, inactive, unavailable, maintenance, blocked) and confirm the status is shown wherever the resource is listed; record document expiry dates and confirm a resource with a past expiry is visibly flagged; archive a resource and confirm it is hidden from active lists but retained.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they create a driver with name, phone, license category, and document expiry dates, **Then** the driver is persisted and appears in the driver list. *(RES-001, RES-002)*
2. **Given** an authorized user, **When** they create a vehicle with plate, type, capacity, and owner/carrier, **Then** the vehicle is persisted and appears in the vehicle list. *(RES-003, RES-004)*
3. **Given** trip operations that use trailers, **When** an authorized user creates a trailer with plate, type, and capacity, **Then** the trailer is persisted; where the operation does not use trailers, trailer maintenance is optional. *(RES-005)*
4. **Given** any resource (driver, vehicle, or trailer), **When** an authorized user sets its operational status, **Then** the status MUST be one of active, inactive, unavailable, maintenance, or blocked, and the chosen status is reflected in lists and detail. *(RES-007)*
5. **Given** a resource with a document expiry date in the past, **When** it is listed or opened, **Then** the expired/expiring documentation is visibly flagged (documentation expiration warning). *(PRD §15.7)*
6. **Given** a resource, **When** an authorized user archives it, **Then** it is hidden from active selection but retained and referenceable from historical records.

---

### User Story 4 - Maintain carriers and classify owned vs subcontracted resources (Priority: P2)

An authorized operator maintains carrier / subcontractor records (name, legal name, tax identifier where needed, contact details, contract status, documentation status, active status) and classifies each resource as **owned** (Brazil Transports' own fleet) or **subcontracted** (provided by a carrier). Subcontracted drivers, vehicles, and trailers are linked to the carrier that provides them; owned resources are not. This classification establishes the clean data that the later dispatch feature uses to apply owned-vs-subcontracted assignment policy.

**Why this priority**: Carriers and the owned/subcontracted split are part of Phase 1 master data, but customers, lanes, drivers, and vehicles (Stories 1–3) can be demonstrated first; carrier records and the ownership classification layer on top of the resource registry. The precise assignment-policy consequences of the split are owned by the dispatch feature (006), so this story sets up the data, not the policy.

**Independent Test**: As an authorized user, create a carrier; mark a vehicle and a driver as subcontracted and link them to that carrier; mark another vehicle as owned; confirm each resource is unambiguously classified and that every subcontracted resource is linked to a carrier; archive a carrier and confirm it is excluded from new resource linking while existing links are retained.

**Acceptance Scenarios**:

1. **Given** an authorized user, **When** they create a carrier with name, legal name, tax identifier, and contact details, **Then** the carrier is persisted and appears in the carrier list. *(RES-006)*
2. **Given** an existing active carrier, **When** an authorized user classifies a resource as subcontracted and links it to that carrier, **Then** the resource records its carrier and is identifiable as subcontracted.
3. **Given** a resource classified as owned, **When** it is saved, **Then** it carries no carrier link and is identifiable as owned fleet.
4. **Given** a resource classified as subcontracted, **When** it is saved without a carrier, **Then** the system requires a carrier before the record can be saved.
5. **Given** a carrier referenced by resources, **When** an authorized user archives it, **Then** it is excluded from new linking but existing resource links and history are retained.

---

### User Story 5 - Governed master data: permissions, non-destructive removal, and audit (Priority: P2)

Across every master-data area, the system enforces that only users whose role grants the relevant permission can create, edit, or archive records; removal is always archive (soft-delete), never destructive deletion; and every critical change (create, archive, status change, and edits to key fields) is recorded as an immutable audit entry reusing the audit capability established in feature 001. The user cannot perform a forbidden master-data action, even by calling the underlying endpoint directly.

**Why this priority**: These are cross-cutting guarantees that apply to Stories 1–4. They are essential for a trustworthy operational system but are demonstrated against the entities those stories create, so they are sequenced alongside (not ahead of) the entity CRUD. They reuse 001's foundation rather than building new platform capability.

**Independent Test**: With a user lacking master-data permission, attempt to create/edit/archive a customer, lane, and resource through the UI and by issuing the request directly — confirm all are denied with no state change; with an authorized user, archive a record and confirm it is retained (not destroyed); perform a critical change and confirm a matching, immutable audit entry exists and cannot be edited or deleted through the application.

**Acceptance Scenarios**:

1. **Given** a user whose role does not grant master-data management, **When** they attempt to create, edit, or archive any master-data record through any path (UI or direct request), **Then** it is refused, an authorization error is returned, and no state changes. *(PRD §18; STACK §3.8)*
2. **Given** an authorized user, **When** they remove any master-data record, **Then** the record is archived (soft-deleted) and retained, never destructively deleted. *(soft-delete business rule; PRD §18 "Delete / archive records")*
3. **Given** a critical master-data change (create, archive, operational-status change, or edit of a key field), **When** it is saved, **Then** an immutable audit entry is created capturing entity type, entity id, action, previous value, new value, acting user, and timestamp. *(audit business rule; STACK §5.4)*
4. **Given** an existing audit entry, **When** any user attempts to modify or delete it through the application, **Then** the attempt is refused (audit history is append-only). *(STACK §3.7)*

---

### Edge Cases

- **Duplicate natural keys**: creating a second customer with an existing customer code, a second vehicle/trailer with an existing plate, a second carrier with an existing tax identifier, or a second location with an existing code **within the same customer** is rejected. Customer code, plate, and carrier tax identifier are unique globally; location code is unique per customer.
- **Archiving a referenced record**: archiving a location, customer, or carrier that is referenced by lanes or resources excludes it from new selection but never orphans or deletes existing references; existing records keep their reference and remain readable.
- **Degenerate lane**: a lane whose origin and destination are the same location is warned or prevented.
- **Subcontracted resource without carrier**: a resource classified as subcontracted cannot be saved without a linked carrier.
- **Expired / expiring documentation**: a resource whose document expiry date is within the warning window (default 30 days) is flagged *expiring soon*, and once the date passes it is flagged *expired*; the record stays editable so the expiry can be updated.
- **Operational status vs archive**: an operational status of *inactive* means the resource exists but is not currently in service; *archived* means soft-deleted. The two are independent — an archived resource is removed from operational use regardless of its operational status.
- **Editing a resource's ownership classification**: changing a resource from subcontracted to owned clears/forbids the carrier link; changing from owned to subcontracted requires a carrier.
- **Direct endpoint access**: a forbidden master-data action invoked directly (without the UI) is denied identically to the UI path.
- **Locale**: all master-data screens render in pt-BR; no untranslated or hard-coded user-facing strings.

## Requirements *(mandatory)*

### Functional Requirements

**Customers**

- **FR-001**: Authorized users MUST be able to create and edit customer records. *(CUST-001; PRD §13.1, §15.12)*
- **FR-002**: A customer record MUST capture, at minimum: name, legal name, customer code, tax identifier (where needed), one or more contacts, a billing contact, and active status. *(CUST-002; PRD §14.1 Customer)*
- **FR-003**: Customer-specific import templates, SLA rules, and document requirements MUST NOT be configured in this feature; the customer record is the anchor those later features (004, 007, 008) attach to, and this feature MUST NOT prevent their later addition. *(SPEC-SLICING 002 scope; PRD §13.1 CUST-003/004/005 deferred)*
- **FR-004**: Customer master data MUST be data-driven (records, not per-customer code); the system MUST NOT introduce per-customer code paths. *(STACK §7; constitution config-driven rule)*

**Locations & lanes**

- **FR-005**: Authorized users MUST be able to maintain origin and destination locations. *(LANE-001; PRD §13.2)*
- **FR-006**: A location record MUST capture, at minimum: name, code, address, city, state, country, contact/gate instructions, optional geo-coordinates (latitude/longitude), and active status. Each location MUST belong to a single customer (customer-scoped), and its code MUST be unique within that customer. *(LANE-002; PRD §14.1 Location "Customer-specific code"; Clarification 2026-05-29)*
- **FR-007**: Authorized users MUST be able to create lanes between an origin location and a destination location. *(LANE-003; PRD §13.2)*
- **FR-008**: A lane record MUST capture, at minimum: customer, origin location, destination location, expected transit time, default vehicle type, standard rate, toll estimate, and active status. *(LANE-004; PRD §14.1 Lane)*
- **FR-009**: A lane MUST reference an existing, active customer, origin, and destination at creation time; its origin and destination MUST both belong to the lane's customer; the system MUST prevent creating a lane against a missing, archived, or different-customer customer/location. *(LANE-003/004 integrity; Clarification 2026-05-29)*
- **FR-010**: The lane's standard rate and toll estimate are stored as master-data attributes on the lane; detailed rate-table management and billing rate logic are owned by feature 008 and are out of scope here. *(SPEC-SLICING; PRD §14.1 "Rate reference")*

**Drivers, vehicles, trailers**

- **FR-011**: Authorized users MUST be able to create and edit driver records. *(RES-001; PRD §13.6)*
- **FR-012**: A driver record MUST capture, at minimum: name, phone, license category, document expiry date(s), employer/carrier, operational status, and notes. *(RES-002; PRD §14.1 Driver)*
- **FR-013**: Authorized users MUST be able to create and edit vehicle records. *(RES-003; PRD §13.6)*
- **FR-014**: A vehicle record MUST capture, at minimum: plate, type, capacity, owner/carrier, document expiry date(s), tracker identifier (where available), and operational status. Vehicle *type* MUST be drawn from a fixed, code-defined enum — the same controlled set used for the lane default vehicle type (FR-008) and later dispatch compatibility (DISP-006); it is not free text and not an admin-managed lookup. *(RES-004; PRD §14.1 Vehicle; Clarification 2026-05-29)*
- **FR-015**: Authorized users MUST be able to create and edit trailer records where the operation uses trailers; trailer maintenance MUST be optional for operations that do not. *(RES-005; PRD §14.1 Trailer)*
- **FR-016**: A trailer record MUST capture, at minimum: plate, type, capacity, owner/carrier, document expiry date(s), and operational status. *(RES-005; PRD §14.1 Trailer)*
- **FR-017**: The system MUST visibly flag drivers, vehicles, and trailers by documentation state: **expiring soon** when a document expiry date falls within a configurable warning window (default 30 days), and **expired** on/after the expiry date (documentation expiration warnings). *(PRD §15.7; RES-002/004; Clarification 2026-05-29)*

**Resource operational status**

- **FR-018**: The system MUST track an operational status for drivers, vehicles, and trailers constrained to the fixed set: **active, inactive, unavailable, maintenance, blocked**. *(RES-007; PRD §13.6)*
- **FR-019**: Operational status MUST be settable and editable by authorized users and MUST be visible wherever the resource is listed or opened, so later features can read assignable state. *(RES-007; SPEC-SLICING 002 exit criteria)*

**Carriers & owned-vs-subcontracted classification**

- **FR-020**: Authorized users MUST be able to create and edit carrier / subcontractor records. *(RES-006; PRD §13.6)*
- **FR-021**: A carrier record MUST capture, at minimum: name, legal name, tax identifier (where needed), contact details, contract status, documentation status, and active status. *(RES-006; PRD §14.1 Carrier)*
- **FR-022**: Each driver, vehicle, and trailer MUST carry an explicit, **mandatory** ownership classification — **owned** (own fleet) or **subcontracted** — and MUST be maintained in one unified list per resource type (no separate owned/subcontracted areas). A subcontracted resource MUST be linked to a carrier; an owned resource MUST carry no carrier link. *(Clarification 2026-05-29; PRD §29 Input #6; PRD §14.1 owner/carrier fields)*
- **FR-023**: The system MUST prevent saving a resource classified as subcontracted without a linked carrier. *(integrity; PRD §29 Input #6)*
- **FR-024**: The ownership classification model is resolved (FR-022). The precise *assignment-policy* consequences of the split (e.g., who may be assigned to which trips) are owned by the dispatch feature (006), not here; this feature provides only the clean classification data. The actual per-resource classification of the live fleet is operational data entry by Ops (PRD §29 Input #6) and is not a spec-level blocker. *(Clarification 2026-05-29; PRD §29 Input #6; SPEC-SLICING assignment policy → 006)*

**Cross-cutting: permissions, non-destructive removal, audit**

- **FR-025**: The system MUST enforce, server-side (BFF), that only users whose role grants the relevant master-data permission can create, edit, or archive master-data records; a denied request MUST return an authorization error and MUST cause no state change. This reuses the role-aware authorization capability established in feature 001. **Reading** a master-data area (its list/detail) likewise requires that area's manage permission — these are management screens; downstream features (006+) read the same data through their own permissions/services (FR-029, SC-011). *(PRD §18; STACK §3.8; reuses 001 FR-010)*
- **FR-026**: Removal of any master-data record MUST be a non-destructive **archive** (soft-delete, active/archived) rather than a destructive delete; archived records MUST be excluded from active selection/pick-lists while remaining retained and historically referenceable. *(soft-delete business rule; STACK §3.7; PRD §30 "soft-delete over hard delete")*
- **FR-027**: Per PRD §18, the **archive** action on records MUST be restricted to the role(s) granted "Delete / archive records" (Admin in the §18 matrix). *(PRD §18 "Delete / archive records" = Admin)*
- **FR-028**: Critical master-data changes — at minimum create, archive, operational-status change, and edits to key identifying/operational fields — MUST be recorded as immutable, append-only audit entries (entity type, entity id, action, previous value, new value, acting user, timestamp), reusing the audit capability established in feature 001. *(audit business rule; STACK §5.4 "customer updates"; reuses 001 FR-017/019/020)*
- **FR-029**: The role→permission mapping for *creating and editing* master data (the PRD §18 matrix enumerates only "Delete / archive records" = Admin) MUST be: **commercial master data** (customers, locations, lanes) — Admin and Operations Manager; **fleet master data** (drivers, vehicles, trailers, carriers) — Admin, Operations Manager, and Fleet Coordinator. Archiving any record remains Admin-only (FR-027). *(Clarification 2026-05-29; extends PRD §18 for the master-data create/edit gap)*

**Localization & access boundary (inherited from 001)**

- **FR-030**: All master-data UI MUST render in Brazilian Portuguese (pt-BR) through the i18n mechanism from feature 001; user-facing strings MUST NOT be hard-coded. Timestamps MUST be stored in UTC and displayed in America/Sao_Paulo; monetary values (e.g., lane standard rate, toll estimate) MUST use BRL. *(PRD §21.6; STACK §3.5; reuses 001 FR-021/022)*
- **FR-031**: The browser MUST NOT access the data store directly; all master-data reads and writes MUST flow through server-side application endpoints (the BFF), with the privileged data credential server-only. *(STACK §5.1, §5.2; reuses 001 FR-023)*

### Key Entities *(include if feature involves data)*

- **Customer**: A client whose trips Brazil Transports executes. In-scope attributes: name, legal name, customer code (unique), tax identifier (optional), contacts, billing contact, active/archived status. Deferred (owned by later features, not editable here): SLA configuration (007), document requirements (008), import templates (004). *(PRD §14.1)*
- **Location**: A physical origin or destination point. Attributes: code, name, address, city, state, country, optional latitude/longitude, contact/gate instructions, active/archived status. Belongs to a single customer (customer-scoped); code is unique per customer. *(PRD §14.1; Clarification 2026-05-29)*
- **Lane**: A customer-specific origin→destination route. Attributes: customer (ref), origin location (ref), destination location (ref), expected transit time, default/standard vehicle type, standard rate, toll estimate, optional standard distance, active/archived status. Monetary attributes (standard rate, toll estimate) are stored as integer minor units (centavos) in the app-wide currency BRL; "vehicle type" is a fixed code enum (see Assumptions). A lane requires a valid customer plus an origin and destination that both belong to that customer. *(PRD §14.1; Clarification 2026-05-29)*
- **Driver**: A person who operates a vehicle on trips. Attributes: name, phone, email (optional), license number, license category, license/document expiry date(s), employer or carrier (ref where subcontracted), ownership classification (owned/subcontracted), operational status (active/inactive/unavailable/maintenance/blocked), notes, active/archived status. *(PRD §14.1)*
- **Vehicle**: A powered unit used to execute trips. Attributes: plate (unique), type (fixed code enum), capacity (kg), owner, carrier (ref where subcontracted), ownership classification (owned/subcontracted), tracker provider/identifier (optional), document expiry date(s), operational status, notes, active/archived status. *(PRD §14.1)*
- **Trailer**: A towed unit used where applicable. Attributes: plate (unique), type (fixed code enum), capacity (kg), owner, carrier (ref where subcontracted), ownership classification, document expiry date(s), operational status, notes, active/archived status. *(PRD §14.1)*
- **Carrier**: A subcontractor that provides resources. Attributes: name, legal name, tax identifier (optional), contact details, contract status, documentation status, active/archived status. Contract-status and documentation-status value sets are documented defaults (see Assumptions). (Approved-customers / approved-lanes associations exist in the PRD data model but their enforcement is an assignment concern owned by feature 006; this feature may store them but does not enforce assignment rules.) *(PRD §14.1)*
- **Audit Log entry** *(reused from 001, not redefined here)*: An immutable record of a critical action — entity type, entity id, action, previous value, new value, acting user, timestamp, optional reason/note. This feature writes master-data changes through it. *(PRD §14; 001 spec)*

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: All seven master-data entity types (customer, location, lane, driver, vehicle, trailer, carrier) support create and edit, and an authorized user can create a record end-to-end in under 3 minutes with no engineering involvement.
- **SC-002**: 100% of record removals are archive operations; zero master-data records can be destructively deleted through the application.
- **SC-003**: Drivers, vehicles, and trailers can each be set to all five operational statuses (active, inactive, unavailable, maintenance, blocked), and the current status is visible in 100% of places the resource is listed or opened.
- **SC-004**: Every resource is unambiguously classified as owned or subcontracted, and 100% of subcontracted resources are linked to a carrier (none can be saved without one).
- **SC-005**: A user without master-data permission is denied 100% of create/edit/archive attempts through any path (UI or direct request), with no resulting state change.
- **SC-006**: 100% of critical master-data changes produce a retrievable, immutable audit entry containing all required fields, and no such entry can be altered or removed through the application.
- **SC-007**: 100% of archived records are excluded from active selection/pick-lists while remaining retrievable from and referenceable by historical records.
- **SC-008**: 100% of lanes reference a valid customer plus an origin and destination that belong to that customer; no lane can be created against a missing, archived, or different-customer reference.
- **SC-009**: 100% of resources with an expired document are flagged as *expired*, and 100% with a document expiring within the warning window (default 30 days) are flagged as *expiring soon*, in lists and detail.
- **SC-010**: 100% of master-data screens render in pt-BR with no untranslated or hard-coded user-facing strings.
- **SC-011**: Downstream features can retrieve clean, active master data (customers, locations, lanes, drivers, vehicles, trailers, carriers) for selection — satisfying the slice exit criterion that "later assignment features can query clean master data."

## Assumptions

- **Builds on 001**: The role-aware permission model, BFF authorization, reusable audit capability, i18n (pt-BR), and app/Administration shell from feature 001 already exist and are reused; this feature does not rebuild them.
- **Create/edit permission mapping (confirmed 2026-05-29)**: Commercial master data (customers, locations, lanes) is managed by Admin and Operations Manager; fleet master data (drivers, vehicles, trailers, carriers) is managed by Admin, Operations Manager, and Fleet Coordinator; archiving is Admin-only (PRD §18). This extends the §18 matrix, which did not enumerate master-data create/edit. No longer a sign-off blocker.
- **Owned vs subcontracted (confirmed 2026-05-29)**: Resources are maintained in one unified list per type with an explicit, mandatory owned/subcontracted flag; subcontracted resources require a carrier link, owned resources carry none. Assignment-policy implications remain owned by feature 006; the per-resource classification of the live fleet is operational data entry (§29 Input #6), not a spec blocker.
- **Billing boundary**: The customer "billing settings" in CUST-002 are represented here only as a billing contact; rate tables and billing configuration are owned by feature 008. Lane standard rate / toll estimate are stored as simple master-data attributes (BRL), not as managed rate tables.
- **Vehicle & trailer type (confirmed 2026-05-29)**: Vehicle type (on vehicles and as a lane default) is a **fixed, code-defined enum** — not free text and not an admin-managed lookup — shared by vehicles and lane defaults and used for later dispatch compatibility (DISP-006). It is not among the admin-managed config areas in PRD §15.12, consistent with this choice; new types require a code change (KISS/YAGNI for MVP). **Trailer type** follows the same decision (fixed code enum, mirroring the vehicle-type clarification by extension). The concrete enum **value sets** (the specific vehicle/trailer classes) are **documented defaults** (labeled scaffolding, Constitution II) confirmable with Ops; because they are code enums, a new class is a one-line migration and does not block.
- **Carrier status value sets (documented default)**: Carrier `contract status` (e.g., active/suspended/expired) and `documentation status` (e.g., pending/complete/expired) value sets are **documented defaults** not specified in the PRD; they are labeled scaffolding (Constitution II), confirmable with Ops, and MUST NOT be treated as final sign-off until confirmed.
- **Natural-key uniqueness**: Customer code, vehicle/trailer plate, and carrier tax identifier are unique globally; **location code is unique per customer** (locations are customer-scoped, Clarification 2026-05-29).
- **Documentation status (carrier) and document expiry (resources)**: Stored and flagged as master-data attributes; document *verification workflow* and required-document *checklists* are owned by feature 008 and are out of scope here.
- **Documentation warning window (confirmed 2026-05-29)**: A 30-day advance warning before document expiry, implemented as a single configurable default constant in `packages/shared` (e.g., `DOCUMENT_EXPIRY_WARNING_DAYS = 30`) consumed by the `documentExpiryState` helper — not hard-coded at call sites; documents are flagged *expired* on/after the expiry date.
- **Single feature, config-driven**: Per the constitution and STACK §7, customer/operational variation is data-driven; no per-customer code paths are introduced.

## Out of Scope

The following are explicitly excluded from this feature:

- **Customer import templates** — CUST-003; owned by feature 004.
- **Customer SLA rules / thresholds** — CUST-005; owned by feature 007.
- **Customer document requirements / required-document checklists** — CUST-004; owned by feature 008.
- **Resource calendars and planned unavailability** — RES-008 (Later); see Future Enhancements.
- **Unknown-location detection during import and location mapping** — LANE-005; owned by the import feature 004.
- **Dispatch / assignment, assignment conflict and document-expiry checks at assignment time, override reasons** — DISP-* (feature 006). This feature provides the data the checks read, not the checks.
- **Trips, the trip status machine, trip events, exceptions, SLA risk, alerts** — features 003, 005, 007.
- **Documents, document verification, billing readiness, rate tables, billing export** — feature 008.
- **Reporting, dashboards, and broad audit-history views** — feature 009. (This feature writes audit entries; it does not build operational audit-view screens.)
- **Building authentication, roles, the permission engine, the audit engine, or i18n** — these are owned by feature 001 and reused here.
- **Supabase Realtime / Edge Functions / external broker / RLS** — excluded per the constitution; freshness is polling; authorization is BFF-only.

## Future Enhancements

- **RES-008 — Resource calendars and planned unavailability** (PRD §13.6, priority *Later*): scheduling driver/vehicle availability windows and planned downtime. Out of scope for this feature; recorded here so the resource model can accommodate it later without rework.

## Dependencies, Constraints & Gating Inputs

**Dependencies**

- **Feature 001 (Platform, Access, App Shell)** — required: reuses the 7-role model, BFF authorization, reusable audit capability, i18n (pt-BR), and the Administration shell. *(SPEC-SLICING 002 depends on 001)*
- **Features 003–009 depend on this feature** for clean master data (import consumes customers/locations/lanes; dispatch queries drivers/vehicles/trailers/carriers; billing references customers/lanes). This feature must leave master data queryable and clean for them. *(SPEC-SLICING)*

**Governing constraints inherited from STACK / PRINCIPLES / DELIVERY-WORKFLOW** (these govern HOW and are non-negotiable):

- **Authorization is enforced in the Next.js BFF** (single source of truth in MVP); RLS deferred; the privileged service-role credential is server-only; the data gateway is never exposed publicly. *(STACK §3.8, §5.1, §5.2)*
- **Soft-delete (active/archived) over hard delete** for auditable entities; **immutable audit/event records** for critical history. *(STACK §3.7; PRD §30)*
- **Config-driven customer variation** — one set of master-data records, no per-customer code packages. *(STACK §7; constitution)*
- **KISS / DRY / YAGNI** — do not build configurability "just in case"; abstract only after ≥3 real repetitions; keep the permission surface minimal and reuse 001's authorization rather than re-deriving role rules. *(PRINCIPLES; STACK §3.8)*
- **One app + one worker; no microservices, no Realtime, no Edge Functions, no external broker.** *(STACK)*
- **Delivery**: short-lived branch off `dev`; feature PR targets **`dev`, never `main`**; AI must not merge to `main`. Quality gates (lint, typecheck, tests, build) must pass; permission, archive, and audit behavior are explicit test targets (Vitest + Playwright). *(DELIVERY-WORKFLOW)*

**Gating inputs (PRD §29) and sign-off status** — the two business-input gates flagged at specify time are now **resolved at the master-data level** (see *Clarifications*, Session 2026-05-29):

- ~~§29 Input #6 — Owned-fleet vs subcontracted resource split~~ — **RESOLVED at the master-data level (Clarification 2026-05-29)**: modeled as an explicit, mandatory owned/subcontracted flag with a carrier link for subcontracted resources (FR-022). The *assignment-policy* consequences remain owned by feature 006; the live per-resource classification is operational data entry by Ops, not a spec-level blocker. *(PRD §29 Input #6)*
- ~~PRD §18 create/edit permission gap~~ — **RESOLVED (Clarification 2026-05-29)**: create/edit mapping pinned in FR-029 (commercial → Admin + Ops Manager; fleet → Admin + Ops Manager + Fleet Coordinator; archive Admin-only). No longer blocking.

Per the user constraint, no missing customer / SLA / document / billing details were invented; the two gating inputs were resolved via clarification rather than assumption. Remaining downstream concerns (owned/subcontracted *assignment policy*) are owned by feature 006.

## Traceability (PRD Mapping)

| Spec item | PRD requirement / section |
|---|---|
| FR-001, FR-002 / SC-001; Story 1 | CUST-001, CUST-002; PRD §13.1, §14.1 (Customer), §15.12 |
| FR-003, FR-004; Story 1 | SPEC-SLICING 002 scope (CUST-003/004/005 deferred to 004/007/008); STACK §7 |
| FR-005, FR-006 / SC-001; Story 2 | LANE-001, LANE-002; PRD §13.2, §14.1 (Location) |
| FR-007, FR-008, FR-009 / SC-008; Story 2 | LANE-003, LANE-004; PRD §13.2, §14.1 (Lane) |
| FR-010 | PRD §14.1 ("Rate reference"); SPEC-SLICING (rates owned by 008) |
| FR-011, FR-012 / SC-001; Story 3 | RES-001, RES-002; PRD §13.6, §14.1 (Driver) |
| FR-013, FR-014; Story 3 | RES-003, RES-004; PRD §13.6, §14.1 (Vehicle) |
| FR-015, FR-016; Story 3 | RES-005; PRD §13.6, §14.1 (Trailer) |
| FR-017 / SC-009; Story 3 | PRD §15.7 ("Documentation expiration warnings"); RES-002/004 |
| FR-018, FR-019 / SC-003; Story 3 | RES-007; PRD §13.6; SPEC-SLICING 002 exit criteria |
| FR-020, FR-021 / SC-001; Story 4 | RES-006; PRD §13.6, §14.1 (Carrier) |
| FR-022, FR-023, FR-024 / SC-004; Story 4 | PRD §29 Input #6; §14.1 (owner/carrier fields); SPEC-SLICING (assignment policy → 006) |
| FR-025 / SC-005; Story 5 | PRD §18; STACK §3.8; reuses 001 authorization (FR-010) |
| FR-026, FR-027 / SC-002, SC-007; Story 5 | soft-delete business rule; STACK §3.7; PRD §18 ("Delete / archive records" = Admin), §30 |
| FR-028 / SC-006; Story 5 | audit business rule; STACK §5.4 ("customer updates", "manual edits"), §3.7; reuses 001 audit (FR-017/019/020) |
| FR-029 | PRD §18 (create/edit gap resolved); Clarification 2026-05-29 |
| FR-030 / SC-010 | PRD §21.6; STACK §3.5; reuses 001 i18n (FR-021/022) |
| FR-031 | STACK §5.1, §5.2; reuses 001 access boundary (FR-023) |
| SC-011 | SPEC-SLICING 002 exit criteria ("later assignment features can query clean master data") |
| Phase context / exit criteria | PRD §22 Phase 1 ("Customers, Locations, Lanes, Drivers, Vehicles, Carriers"; exit: "Users can maintain master data needed to execute trips") |
| Acceptance alignment | PRD §23 ("Permission rules prevent unauthorized operational and billing changes"; "Critical changes appear in audit history") |
| Out of scope: import templates / SLA / docs | CUST-003 (→004), CUST-005 (→007), CUST-004 (→008) |
| Out of scope: resource calendars | RES-008 (Later) → Future Enhancements |
| Out of scope: unknown-location mapping | LANE-005 (→ import feature 004) |

> **Note on PRD §22 / §23**: PRD §22 Phase 1 lists Customers, Locations, Lanes, Drivers, Vehicles, and Carriers as Phase-1 deliverables with the exit criterion "Users can maintain master data needed to execute trips" — the primary outcome of this feature. §23's MVP acceptance lines that this feature underpins are the permission and audit guarantees ("Permission rules prevent unauthorized operational and billing changes"; "Critical changes appear in audit history"); the entity-CRUD acceptance is captured by this spec's Success Criteria (SC-001–SC-011).
