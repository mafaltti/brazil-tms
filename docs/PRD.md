# Brazil Transports Linehaul Execution Management System PRD

## 1. Document Control

**Product name:** Brazil Transports Linehaul Execution Management System  
**Document type:** Product Requirements Document  
**Version:** 1.1  
**Status:** Draft (spec reconciled with STACK.md; build still gated on business inputs — see Section 29)  
**Draft date:** 2026-05-28  
**Last updated:** 2026-05-29  
**Primary business:** Linehaul execution for pre-planned trips  
**Initial customers supported:** Shopee, DHL eCommerce, Mercado Livre  

## 2. Executive Summary

Brazil Transports operates as a linehaul executor. Customers such as Shopee, DHL eCommerce, and Mercado Livre send pre-planned trips that Brazil Transports must validate, assign, execute, track, prove, and bill.

The proposed system is an execution-focused transportation management platform. It is not primarily a route optimizer. Its core purpose is to give Brazil Transports a reliable control tower for planned trips, operational resources, trip events, exceptions, documentation, service-level performance, and billing readiness.

The first release should replace fragmented spreadsheet, email, messaging, and manual follow-up workflows with a single operational system of record. The system should make every trip traceable from customer intake through completion and billing.

## 3. Business Context

Brazil Transports receives transportation plans from large e-commerce and parcel customers. These plans typically define the requested origin, destination, schedule, vehicle type, trip identifier, loading and unloading windows, and operational requirements.

The business challenge is not deciding where trucks should go. The challenge is executing customer plans consistently while controlling exceptions, proving service delivery, avoiding missed trips, and producing clean billing records.

Common operational pain points include:

- Trip plans arriving in different formats by customer.
- Manual re-entry of trip information into spreadsheets or chat groups.
- Limited visibility into whether a planned trip has been assigned, confirmed, loaded, delayed, completed, or cancelled.
- Driver, vehicle, and subcontractor assignments managed outside a central system.
- Delays and exceptions discovered too late.
- Documents and proof of execution scattered across email, WhatsApp, portals, or local folders.
- Difficulty reconciling completed trips against customer plans and contracted rates.
- Weak audit trail for customer disputes, penalties, and billing differences.

## 4. Goals

### 4.1 Business Goals

- Create a single system of record for all linehaul trips received from customers.
- Improve operational visibility across planned, assigned, in-transit, delayed, completed, cancelled, and disputed trips.
- Reduce manual work in trip intake, validation, assignment, status updates, proof collection, and billing preparation.
- Improve on-time pickup and on-time delivery performance.
- Reduce unassigned trips, no-shows, missed departures, and late exception escalation.
- Improve billing accuracy by connecting customer plans, executed trips, documents, exceptions, and rates.
- Provide customer-specific operational reporting for Shopee, DHL eCommerce, and Mercado Livre.

### 4.2 Product Goals

- Normalize trip data from multiple customers into one internal trip model.
- Provide dispatchers with a fast daily operating board.
- Support resource assignment for drivers, vehicles, trailers, and subcontractors.
- Track trip lifecycle events and exceptions.
- Store and validate proof-of-execution documents.
- Generate operational dashboards and billing-ready exports.
- Provide role-based access for operations, dispatch, finance, management, and customer-facing users.

## 5. Non-Goals

The initial product should not attempt to solve every transportation problem at once.

Out of scope for the MVP:

- Route optimization for customer-provided trips.
- Full ERP accounting replacement.
- Full fleet maintenance system.
- Full driver payroll system.
- Native customer mobile app.
- Automated freight marketplace bidding.
- Real-time telematics integrations with every possible provider.
- Automated tax, legal, or regulatory compliance decisions without customer or legal validation.

The system should store and organize operational and document references needed by the business, but final tax, legal, and regulatory rules should remain configurable and reviewed by qualified local specialists.

## 6. Target Users

### 6.1 Operations Manager

Responsible for overall linehaul execution performance. Needs visibility into daily network health, delays, customer SLA performance, capacity problems, and unresolved exceptions.

Primary needs:

- Monitor all active and upcoming trips.
- Identify risks before customer impact.
- Review team performance.
- Escalate critical exceptions.
- Analyze SLA and billing readiness.

### 6.2 Dispatcher

Responsible for assigning and managing trips in real time.

Primary needs:

- See trips needing assignment.
- Assign driver, vehicle, trailer, and carrier.
- Confirm departure readiness.
- Update statuses quickly.
- Log delays and exceptions.
- Communicate operational changes.

### 6.3 Control Tower Analyst

Responsible for tracking active trips, monitoring milestones, and following up on exceptions.

Primary needs:

- Track trips by status and SLA risk.
- Receive alerts for missed milestones.
- Record events and exception reasons.
- Maintain timeline accuracy.
- Escalate operational issues.

### 6.4 Fleet or Carrier Coordinator

Responsible for driver, vehicle, and subcontractor availability.

Primary needs:

- Maintain resource records.
- Track availability and conflicts.
- Verify documentation and operational eligibility.
- Support substitutions when a resource becomes unavailable.

### 6.5 Finance Analyst

Responsible for billing reconciliation and customer invoice preparation.

Primary needs:

- See completed trips ready for billing.
- Validate proof of execution.
- Apply rates, tolls, extras, penalties, and adjustments.
- Export billing data by customer and period.
- Resolve disputes.

### 6.6 Executive or Business Owner

Responsible for profitability, service quality, and customer performance.

Primary needs:

- View high-level KPIs.
- Compare customers, lanes, carriers, and regions.
- Track revenue, penalties, exceptions, and margin indicators.
- Identify operational bottlenecks.

### 6.7 Optional Customer Viewer

Customer-facing user who may be granted restricted access to trips belonging to their company.

Primary needs:

- View assigned trip status.
- See milestone updates.
- Download proof documents if permitted.
- Track exceptions and closure notes.

## 7. Operating Model

The product should support the following operating model:

1. Customer sends planned trips.
2. System imports and normalizes trip data.
3. System validates trip completeness, duplicates, schedule feasibility, and required fields.
4. Operations reviews exceptions and confirms accepted trips.
5. Dispatch assigns driver, vehicle, trailer, and carrier.
6. Trip is confirmed for execution.
7. System tracks milestone events from origin arrival through unloading.
8. Control tower manages delays, incidents, and exceptions.
9. Documents and proof of execution are attached.
10. Completed trip is validated for billing.
11. Finance exports billing data and resolves disputes.
12. Management reviews SLA, exception, and financial performance.

## 8. Assumptions

- Customers provide trip plans before execution through spreadsheet, CSV, email, portal export, API, or another structured source.
- Trip plans include at least customer trip ID, customer name, origin, destination, pickup date/time, delivery date/time or expected transit time, vehicle type, and service requirements.
- Brazil Transports may execute trips using owned fleet, dedicated partners, subcontracted carriers, or a mix of resources.
- Some customers may require documents such as trip sheets, proof of delivery, gate receipts, CT-e references, MDF-e references, occurrence reports, photos, or signed documents.
- Not every vehicle or driver will have real-time GPS available on day one.
- Manual milestone updates must be supported even if later GPS integrations are added.
- The system should support Portuguese labels in production, but this PRD is written in English for product planning.

## 9. Success Metrics

### 9.1 Operational Metrics

- Percentage of trips imported without manual correction.
- Percentage of trips assigned before cutoff time.
- Percentage of trips confirmed before scheduled pickup.
- On-time pickup percentage.
- On-time arrival percentage.
- Average delay detection time.
- Average exception resolution time.
- Number of unassigned trips within next 24 hours.
- Number of trips missing required documents after completion.

### 9.2 Financial Metrics

- Percentage of completed trips ready for billing within 24 hours.
- Number of billing disputes by customer and month.
- Value of penalties by customer, lane, and reason.
- Value of approved extras and accessorials.
- Revenue by customer, lane, vehicle type, and period.

### 9.3 User Adoption Metrics

- Percentage of trips managed entirely in the system.
- Number of manual spreadsheet edits outside the system.
- Average dispatcher actions per trip.
- Number of active daily users by role.
- Percentage of completed trips with complete event timeline.

## 10. Product Scope

### 10.1 MVP Scope

The MVP should include:

- Customer and lane master data.
- Driver, vehicle, trailer, and carrier records.
- Trip import from CSV or spreadsheet.
- Customer-specific import templates.
- Trip validation and duplicate detection.
- Unified trip list and control tower board.
- Trip detail page with timeline, assignment, documents, and billing fields.
- Manual assignment of resources.
- Manual status updates and milestone timestamps.
- Exception logging with reason codes.
- Document upload and document checklist.
- Basic SLA dashboard.
- Billing-ready export.
- User roles and permissions.
- Audit trail for critical changes.
- Portuguese (pt-BR) UI with i18n scaffolding from day one (see 21.6).
- Internal agregados freight rate lookup ("Tabela de Fretes") with spreadsheet
  replace-by-upload (added 2026-07-13, see 13.14 and 30).

### 10.2 Post-MVP Scope

Post-MVP enhancements may include:

- API integrations with customer systems.
- Email inbox ingestion for customer planning files.
- GPS and telematics integrations.
- Driver mobile web app for check-ins and document capture.
- Automated alerts through email, SMS, or WhatsApp provider integration.
- Advanced billing rules and invoice generation.
- Carrier scorecards.
- Predictive delay detection.
- Customer portal.
- Profitability and margin dashboard.
- Integration with accounting, fleet maintenance, HR, or document systems.

## 11. Core Workflows

### 11.1 Trip Import Workflow

1. User selects customer and upload file.
2. System detects or user selects import template.
3. System maps file columns to internal fields.
4. System validates required fields.
5. System detects duplicates using customer, external trip ID, origin, destination, and schedule.
6. System shows import summary:
   - New trips
   - Updated trips
   - Duplicate trips
   - Trips with validation errors
7. User resolves validation errors or exports error report.
8. User confirms import.
9. System creates or updates trips and records import batch history.

### 11.2 Trip Validation Workflow

System checks:

- Customer exists and is active.
- External trip ID is present.
- Origin and destination are recognized or marked for review.
- Pickup and delivery windows are valid.
- Vehicle type is present.
- Planned distance or transit time is plausible when available.
- Required customer fields are present.
- Trip is not a duplicate.
- Trip does not conflict with already accepted customer updates.

Validation outcomes (per imported row; see §11.1):

- Valid: the row creates/updates a trip born `Received` — itself dispatchable, ready for assignment (slice 015; there is no separate trip-level "Validated" hop).
- Warning: trip can proceed but requires user attention.
- Error: trip cannot proceed until corrected.

### 11.3 Assignment Workflow

1. Dispatcher opens unassigned trip list.
2. Dispatcher selects one or more trips.
3. System shows available vehicles, trailers, drivers, and carriers.
4. Dispatcher assigns resources.
5. System checks conflicts:
   - Driver already assigned.
   - Vehicle already assigned.
   - Trailer already assigned.
   - Resource documentation expired.
   - Vehicle type mismatch.
   - Carrier not approved for customer or lane.
6. Dispatcher resolves conflicts or records override reason if permitted.
7. System changes trip status to Assigned.
8. Dispatcher confirms trip when operational readiness is complete.

### 11.4 Execution Tracking Workflow

1. Trip moves from Confirmed to At Origin when vehicle arrives at origin.
2. Trip moves to Loaded when loading is complete.
3. Trip moves to In Transit when vehicle departs origin.
4. Trip moves to At Destination when vehicle arrives at destination.
5. Trip moves to Unloaded when unloading is complete.
6. Trip moves to Completed when required documents and closure data are complete.

Each event should capture:

- Event type.
- Timestamp.
- User or source.
- Location if available.
- Notes.
- Related exception if applicable.

### 11.5 Exception Workflow

1. User identifies an issue or system detects missed milestone.
2. User creates exception or alert is generated.
3. User selects reason code and severity.
4. User adds description, responsible party, expected resolution time, and attachments if applicable.
5. System marks trip as at risk or delayed where appropriate.
6. Operations follows up and updates exception status.
7. Exception is resolved with closure reason and timestamp.
8. Exception data is included in SLA and billing analysis.

### 11.6 Completion and Proof Workflow

1. Trip reaches Unloaded status.
2. User uploads required documents or marks unavailable with reason if permitted.
3. System checks customer-specific document requirements.
4. User reviews timeline, exceptions, and billing fields.
5. User marks trip as Completed.
6. System marks trip as Billing Pending.
7. Finance validates and moves trip to Billing Ready.

### 11.7 Billing Export Workflow

1. Finance selects customer and billing period.
2. System lists completed trips with billing status.
3. Finance filters exceptions, missing documents, penalties, extras, and disputes.
4. System applies rates where configured.
5. Finance reviews calculated values.
6. Finance exports billing file.
7. System records export batch and locks or flags exported trips depending on configuration.

## 12. Trip Lifecycle

The system should support the following standard statuses:

| Status | Meaning | Typical Owner |
|---|---|---|
| Received | Trip imported or manually created; the first **dispatchable** status | Operations |
| Assigned | Driver, vehicle, and/or carrier assigned | Dispatcher |
| Confirmed | Assignment confirmed for execution | Dispatcher |
| At Origin | Vehicle arrived at pickup location | Control Tower |
| Loading | Loading process started | Control Tower |
| Loaded | Loading complete | Control Tower |
| In Transit | Vehicle departed origin | Control Tower |
| At Destination | Vehicle arrived at delivery location | Control Tower |
| Unloading | Unloading process started | Control Tower |
| Unloaded | Unloading complete | Control Tower |
| Completed | Operational execution complete | Operations |
| Billing Pending | Waiting finance validation | Finance |
| Billing Ready | Ready to invoice/export | Finance |
| Billed | Included in billing export or invoice | Finance |
| Cancelled | Trip cancelled before completion | Operations |
| Disputed | Trip has customer, service, or billing dispute | Finance/Ops |

The product should allow customer-specific status labels to map into the internal standard statuses.

### 12.1 Allowed Status Transitions

Transitions not listed are invalid and must be rejected by the status machine (STACK.md `packages/shared` status-machine).

| From | Allowed next | Trigger / owner |
|---|---|---|
| Received | Assigned, Cancelled | Dispatcher / Operations |
| Assigned | Confirmed, Received (unassign), Cancelled | Dispatcher |
| Confirmed | At Origin, Cancelled | Control Tower |
| At Origin | Loading, In Transit, Cancelled | Control Tower |
| Loading | Loaded, Cancelled | Control Tower |
| Loaded | In Transit, Cancelled | Control Tower |
| In Transit | At Destination | Control Tower |
| At Destination | Unloading, Unloaded | Control Tower |
| Unloading | Unloaded | Control Tower |
| Unloaded | Completed | Operations |
| Completed | Billing Pending, Disputed | System / Finance |
| Billing Pending | Billing Ready, Disputed | Finance |
| Billing Ready | Billed, Disputed | Finance |
| Billed | Disputed | Finance |
| Disputed | (status it was entered from), Cancelled | Finance / Operations |
| Cancelled | (terminal) | — |

Notes:

- **Loading** and **Unloading** are optional sub-states; operations may skip directly (At Origin → In Transit, At Destination → Unloaded).
- **Cancelled** is allowed from any non-terminal status before **Completed**, and requires the Section 19.5 cancellation data.
- **Disputed** records the status it was entered from so it can return there on resolution; dispute detail is tracked on the Billing Item (Section 14).
- A **Warning** validation outcome (11.2) is not a status — it is a flag on a `Received` trip that needs attention but does not block progression.
- **Slice 015** collapsed the three former validation states (`Received`, `Validation Error`, `Validated`) into a single `Received`, which is now the first dispatchable status (the redundant trip-level validate hop was removed; import already validates per row). This supersedes slice 014's born-`Validated` decision — imported trips are born `Received`. See §30.

### 12.2 SLA Status

SLA status is tracked separately from trip status (Trip.`SLA status`), recalculated by the worker (STACK.md §3.11) and on relevant status changes:

- **On Track** — no breached or at-risk thresholds.
- **At Risk** — within a warning window of a threshold (e.g., approaching pickup or confirmation cutoff), or has an open high-severity exception.
- **Late** — a planned window (pickup or delivery) has been missed.
- **Breached** — a customer-defined SLA threshold has been exceeded.

MVP computes SLA status from the planned pickup window, planned delivery window, and assignment/confirmation cutoffs (the timestamps customers actually provide). Milestone-level risk (loading, departure) is derived from time-in-status, not per-milestone planned times, until customers supply them (Input #2, Section 29).

## 13. Functional Requirements

### 13.1 Customer Management

| ID | Requirement | Priority |
|---|---|---|
| CUST-001 | Users can create and edit customer records. | MVP |
| CUST-002 | Customer records include name, legal name, tax identifier where needed, contacts, billing settings, SLA rules, document requirements, and active status. | MVP |
| CUST-003 | Users can configure customer-specific import templates. | MVP |
| CUST-004 | Users can configure customer-specific required document checklists. | MVP |
| CUST-005 | Users can configure customer-specific SLA thresholds. | MVP |

### 13.2 Location and Lane Management

| ID | Requirement | Priority |
|---|---|---|
| LANE-001 | Users can maintain origin and destination locations. | MVP |
| LANE-002 | Location records include name, code, address, city, state, country, contact instructions, geofence coordinates if available, and active status. | MVP |
| LANE-003 | Users can create lanes between origin and destination locations. | MVP |
| LANE-004 | Lane records include customer, origin, destination, expected transit time, default vehicle type, standard rate, toll estimate, and active status. | MVP |
| LANE-005 | System identifies unknown locations during import and flags them for mapping. | MVP |

### 13.3 Trip Intake

| ID | Requirement | Priority |
|---|---|---|
| INT-001 | Users can upload CSV or spreadsheet files containing planned trips. | MVP |
| INT-002 | System supports separate import templates for Shopee, DHL eCommerce, Mercado Livre, and future customers. | MVP |
| INT-003 | System maps customer fields into the internal trip model. | MVP |
| INT-004 | System stores import batch history, including file name, user, timestamp, customer, number of rows, and outcome counts. | MVP |
| INT-005 | System detects duplicate trips. | MVP |
| INT-006 | System allows authorized users to resolve import errors. | MVP |
| INT-007 | System supports manual trip creation for exceptions, ad hoc trips, or file failures. | MVP |
| INT-008 | System supports API-based trip ingestion from customers. | Later |
| INT-009 | System supports scheduled email attachment ingestion. | Later |

### 13.4 Trip Management

| ID | Requirement | Priority |
|---|---|---|
| TRIP-001 | Users can view all trips in a searchable, filterable list. | MVP |
| TRIP-002 | Users can filter by customer, date, status, origin, destination, lane, vehicle type, assigned driver, assigned vehicle, carrier, SLA risk, and billing status. | MVP |
| TRIP-003 | Users can open a trip detail page. | MVP |
| TRIP-004 | Trip detail page shows customer plan, assignment, timeline, exceptions, documents, billing details, and audit history. | MVP |
| TRIP-005 | Authorized users can edit operational fields before completion. | MVP |
| TRIP-006 | System maintains original customer plan values separately from executed values when they differ. | MVP |
| TRIP-007 | System records customer changes and internal changes with audit trail. | MVP |
| TRIP-008 | Users can bulk update selected trips where appropriate. | Later |

### 13.5 Dispatch and Assignment

| ID | Requirement | Priority |
|---|---|---|
| DISP-001 | Dispatchers can assign a driver to a trip. | MVP |
| DISP-002 | Dispatchers can assign a vehicle to a trip. | MVP |
| DISP-003 | Dispatchers can assign a trailer to a trip where applicable. | MVP |
| DISP-004 | Dispatchers can assign a carrier or subcontractor to a trip. | MVP |
| DISP-005 | System checks resource conflicts at assignment time. | MVP |
| DISP-006 | System checks vehicle type compatibility. | MVP |
| DISP-007 | System flags expired or missing driver, vehicle, or carrier documentation. | MVP |
| DISP-008 | Users with permission can override assignment warnings with a reason. | MVP |
| DISP-009 | System supports assignment notes and confirmation timestamp. | MVP |
| DISP-010 | System recommends available resources based on schedule, lane, and vehicle type. | Later |

### 13.6 Resource Management

| ID | Requirement | Priority |
|---|---|---|
| RES-001 | Users can create and edit driver records. | MVP |
| RES-002 | Driver records include name, phone, license category, document expiry dates, carrier/employer, status, and notes. | MVP |
| RES-003 | Users can create and edit vehicle records. | MVP |
| RES-004 | Vehicle records include plate, type, capacity, owner/carrier, document expiry dates, tracker identifier if available, and status. | MVP |
| RES-005 | Users can create and edit trailer records where applicable. | MVP |
| RES-006 | Users can create and edit carrier/subcontractor records. | MVP |
| RES-007 | System tracks resource active, inactive, unavailable, maintenance, and blocked statuses. | MVP |
| RES-008 | System supports resource calendars and planned unavailability. | Later |

### 13.7 Execution Events

| ID | Requirement | Priority |
|---|---|---|
| EVT-001 | Users can add standard trip events. | MVP |
| EVT-002 | System automatically records timestamp, user, and previous/new status for status changes. | MVP |
| EVT-003 | Users can add event notes and attachments. | MVP |
| EVT-004 | System supports planned vs actual timestamp comparison. | MVP |
| EVT-005 | System displays trip event timeline in chronological order. | MVP |
| EVT-006 | System can ingest GPS-based events from telematics providers. | Later |
| EVT-007 | System can detect geofence arrival and departure events. | Later |

### 13.8 Exceptions and Incidents

| ID | Requirement | Priority |
|---|---|---|
| EXC-001 | Users can create exceptions linked to a trip. | MVP |
| EXC-002 | Exceptions include category, reason code, severity, owner, status, description, timestamps, and attachments. | MVP |
| EXC-003 | System supports exception statuses: Open, Monitoring, Resolved, Cancelled. | MVP |
| EXC-004 | System supports reason codes for delay, no-show, vehicle breakdown, driver issue, customer delay, loading delay, unloading delay, documentation issue, accident, route deviation, cancellation, and other. | MVP |
| EXC-005 | Users can mark whether an exception is customer-caused, Brazil Transports-caused, carrier-caused, force majeure, or unknown. | MVP |
| EXC-006 | Exception data feeds SLA, billing, and dispute reporting. | MVP |
| EXC-007 | System supports escalation alerts based on severity and age. | Later |

### 13.9 Documents and Proof of Execution

| ID | Requirement | Priority |
|---|---|---|
| DOC-001 | Users can upload documents to a trip. | MVP |
| DOC-002 | Documents include type, file, upload user, upload timestamp, notes, and verification status. | MVP |
| DOC-003 | System supports customer-specific required document checklists. | MVP |
| DOC-004 | Users can mark documents as accepted, rejected, or pending review. | MVP |
| DOC-005 | System prevents or warns against moving trips to Billing Ready when required documents are missing. | MVP |
| DOC-006 | System stores document references such as CT-e number, MDF-e number, POD reference, gate receipt number, or customer portal reference where applicable. | MVP |
| DOC-007 | System supports photo upload from mobile devices. | Later |
| DOC-008 | System supports OCR or document data extraction. | Later |

### 13.10 SLA and Control Tower

| ID | Requirement | Priority |
|---|---|---|
| SLA-001 | System calculates on-time pickup based on customer-specific pickup window rules. | MVP |
| SLA-002 | System calculates on-time arrival based on customer-specific delivery window rules. | MVP |
| SLA-003 | System shows trips at risk due to missing assignment, missed confirmation, delayed origin arrival, delayed loading, delayed departure, delayed destination arrival, or open high-severity exception. | MVP |
| SLA-004 | Control tower dashboard shows active trips by status and customer. | MVP |
| SLA-005 | Control tower dashboard shows SLA performance by customer, lane, and period. | MVP |
| SLA-006 | System supports configurable alert thresholds. | Later |
| SLA-007 | System supports automated notifications to internal users. | Later |

### 13.11 Billing and Revenue

| ID | Requirement | Priority |
|---|---|---|
| BILL-001 | System tracks billing status per trip. | MVP |
| BILL-002 | Finance can configure simple rates by customer, lane, vehicle type, and effective date. | MVP |
| BILL-003 | System calculates planned freight amount where a rate is available. | MVP |
| BILL-004 | Users can add tolls, waiting time, redelivery, extra stops, penalties, discounts, and manual adjustments. | MVP |
| BILL-005 | System shows planned value, executed value, adjustment value, and final billable value. | MVP |
| BILL-006 | System blocks or warns billing when trip is missing required proof. | MVP |
| BILL-007 | Finance can export billing-ready trips to CSV or spreadsheet. | MVP |
| BILL-008 | System records billing export batch history. | MVP |
| BILL-009 | System supports customer-specific invoice layouts. | Later |
| BILL-010 | System integrates with accounting or ERP systems. | Later |

### 13.12 Reporting and Analytics

| ID | Requirement | Priority |
|---|---|---|
| REP-001 | System provides daily operations dashboard. | MVP |
| REP-002 | System provides customer SLA dashboard. | MVP |
| REP-003 | System provides exception dashboard. | MVP |
| REP-004 | System provides billing readiness dashboard. | MVP |
| REP-005 | Users can export filtered trip lists. | MVP |
| REP-006 | System provides lane performance report. | Later |
| REP-007 | System provides carrier scorecard. | Later |
| REP-008 | System provides profitability dashboard. | Later |

### 13.13 User and Permission Management

| ID | Requirement | Priority |
|---|---|---|
| AUTH-001 | System supports user login. | MVP |
| AUTH-002 | System supports roles: Admin, Operations Manager, Dispatcher, Control Tower, Fleet Coordinator, Finance, Executive Viewer, Customer Viewer. | MVP |
| AUTH-003 | Permissions control who can create, edit, cancel, complete, bill, export, and delete records. | MVP |
| AUTH-004 | Customer Viewer users can only access trips belonging to their customer. | Later |
| AUTH-005 | System records audit history for critical actions. | MVP |
| AUTH-006 | System supports single sign-on. | Later |

### 13.14 Freight Rate Lookup (Agregados)

Internal spot-price table for agregado (owner-operator) freight, maintained as a
spreadsheet outside the system and replaced wholesale on upload. Unrelated to
customer lane pricing (LANE-004) and to customer trip intake (13.3). Added
2026-07-13 (see 30); implemented by feature slice 016.

| ID | Requirement | Priority |
|---|---|---|
| RATE-LOOKUP-001 | System maintains an internal freight rate table: route (origin UF/city, destination UF/city), distance (km), vehicle type, one-way price, return price, and notes. | MVP |
| RATE-LOOKUP-002 | Internal users can search and filter rates by origin UF/city, destination UF/city and one-way price range, with sorting by price and distance. | MVP |
| RATE-LOOKUP-003 | Results display distance, vehicle type, both prices and notes in pt-BR with BRL formatting; missing values render as "—". | MVP |
| RATE-LOOKUP-004 | Authorized users (Admin, Finance) replace the entire table by uploading the standard spreadsheet; the replace is atomic and a rejected file changes nothing, reporting row-level errors. | MVP |
| RATE-LOOKUP-005 | Every successful import is recorded (file name, user, timestamp, counts) and appears in the audit trail. | MVP |
| RATE-LOOKUP-006 | Freight rate data is restricted to internal roles and never exposed on customer-facing surfaces. | MVP |

## 14. Data Model

Field lists below are the conceptual model. Column types, nullability, enums, foreign keys, indexes, and constraints are defined in the migration layer (STACK.md `packages/db`). Conventions: UUID primary keys; UTC timestamps (displayed in `America/Sao_Paulo`); monetary values as integer minor units + currency code; soft-delete (`active`/`archived`) rather than hard delete for auditable entities. Enum values listed below are authoritative.

### 14.1 Core Entities

#### Customer

Fields:

- Customer ID.
- Name.
- Legal name.
- Customer code.
- Tax identifier, if used.
- Primary contacts.
- Billing contact.
- SLA configuration.
- Document requirements.
- Import templates.
- Active status.

#### Location

Fields:

- Location ID.
- Customer-specific code.
- Name.
- Address.
- City.
- State.
- Country.
- Latitude and longitude, if available.
- Contact details.
- Gate instructions.
- Active status.

#### Lane

Fields:

- Lane ID.
- Customer.
- Origin location.
- Destination location.
- Expected transit time.
- Standard vehicle type.
- Standard distance, if available.
- Rate reference.
- Toll estimate.
- Active status.

#### Trip

Fields:

- Trip ID.
- Customer.
- External customer trip ID.
- Import batch ID.
- Origin.
- Destination.
- Lane.
- Planned pickup window start.
- Planned pickup window end.
- Planned delivery window start.
- Planned delivery window end.
- Planned vehicle type.
- Planned volume, weight, or pallet count if provided.
- Planned route notes.
- Customer service requirements.
- Current status.
- SLA status.
- Billing status.
- Cancellation reason.
- Created timestamp.
- Updated timestamp.

Planned vs executed: the planned window fields above hold the original customer plan (immutable after import; TRIP-006). Actual/executed timestamps (origin arrival, loaded, departure, destination arrival, unloaded, completion) are recorded as Trip Events (EVT-004) and surfaced on the trip. If a plan field is later changed by an accepted customer update, the prior value is preserved in the audit log.

#### Trip Assignment

Fields:

- Assignment ID.
- Trip ID.
- Driver ID.
- Vehicle ID.
- Trailer ID.
- Carrier ID.
- Assigned by.
- Assigned timestamp.
- Confirmed by.
- Confirmed timestamp.
- Assignment notes.
- Override reason if applicable.
- Is current (boolean).
- Superseded by / superseded timestamp.

Cardinality: a trip has at most one current assignment. Reassignment/substitution (6.4) supersedes the previous assignment; superseded assignments are retained for history and audit.

#### Driver

Fields:

- Driver ID.
- Name.
- Phone.
- Email if available.
- License number.
- License category.
- License expiration date.
- Employer or carrier.
- Status.
- Notes.

#### Vehicle

Fields:

- Vehicle ID.
- Plate.
- Vehicle type.
- Capacity.
- Owner.
- Carrier.
- Tracker provider.
- Tracker identifier.
- Document expiration dates.
- Status.
- Notes.

#### Trailer

Fields:

- Trailer ID.
- Plate.
- Trailer type.
- Capacity.
- Owner.
- Carrier.
- Document expiration dates.
- Status.
- Notes.

#### Carrier

Fields:

- Carrier ID.
- Name.
- Legal name.
- Tax identifier, if used.
- Contact details.
- Approved customers.
- Approved lanes.
- Contract status.
- Documentation status.
- Active status.

#### Trip Event

Fields:

- Event ID.
- Trip ID.
- Event type.
- Status before.
- Status after.
- Event timestamp.
- Source.
- User ID.
- Location.
- Notes.
- Related exception ID.

#### Exception

Fields:

- Exception ID.
- Trip ID.
- Category.
- Reason code.
- Severity.
- Responsible party.
- Status.
- Opened timestamp.
- Resolved timestamp.
- Description.
- Closure notes.
- Attachments.

#### Document

Fields:

- Document ID.
- Trip ID.
- Document type.
- File location.
- External reference.
- Uploaded by.
- Uploaded timestamp.
- Verification status.
- Verified by.
- Verified timestamp.
- Notes.

#### Rate

Fields:

- Rate ID.
- Customer.
- Lane.
- Vehicle type.
- Effective start date.
- Effective end date.
- Base amount.
- Currency.
- Toll handling rule.
- Waiting time rule.
- Extra stop rule.
- Active status.

#### Billing Item

Fields:

- Billing item ID.
- Trip ID.
- Customer.
- Billing status.
- Base freight amount.
- Tolls.
- Extras.
- Penalties.
- Discounts.
- Currency.
- Final billable amount.
- Billing period.
- Export batch ID.
- Dispute status.
- Notes.

#### Import Batch

Fields:

- Import batch ID.
- Customer.
- File name.
- Uploaded by.
- Uploaded timestamp.
- Total rows.
- Created trips.
- Updated trips.
- Duplicate rows.
- Error rows.
- Status.
- Error report.

#### Audit Log

Fields:

- Audit log ID.
- Entity type.
- Entity ID.
- Action.
- Previous value.
- New value.
- User ID.
- Timestamp.
- Reason or note.

#### User

Fields:

- User ID.
- Name.
- Email (login identifier).
- Role (see Section 18; one role per user for MVP).
- Status (active, disabled).
- Last login timestamp.
- Created/updated timestamps.

Authentication is handled by Supabase Auth (STACK.md §3.8); this entity holds the application profile and role binding.

#### Role and Permissions

For MVP, roles are a fixed enum (Section 18) and permissions are enforced in the BFF. A dedicated permissions table is introduced only if roles become customer-configurable (post-MVP).

#### Import Template

Defines how one customer's file columns map to the internal trip model (CUST-003, INT-002/003). One engine, many configs (STACK.md §3.12).

Fields:

- Template ID.
- Customer.
- Name / version.
- File type (CSV, XLSX).
- Column mappings (source column -> internal field).
- Date/number parsing rules (formats, timezone, decimal/thousand separators).
- Required-field overrides.
- Status-mapping reference (see Status Mapping).
- Active status.

#### Customer SLA Rule

Customer-specific SLA thresholds (CUST-005, SLA-001/002).

Fields:

- SLA rule ID.
- Customer.
- Scope (optional lane or vehicle type).
- Pickup window rule (on-time definition / tolerance).
- Delivery window rule (on-time definition / tolerance).
- Confirmation cutoff (lead time before pickup).
- At-risk warning window.
- Effective start/end dates.
- Active status.

#### Document Requirement

Customer-specific required-document checklist (CUST-004, DOC-003/005).

Fields:

- Requirement ID.
- Customer.
- Document type.
- Required for completion (blocks Completed).
- Required for billing (blocks Billing Ready).
- Conditions (e.g., vehicle type, lane) if applicable.
- Active status.

#### Reason Code

Configurable exception reason codes (EXC-004, Administration).

Fields:

- Reason code ID.
- Category (delay, no-show, breakdown, driver issue, customer delay, loading delay, unloading delay, documentation, accident, route deviation, cancellation, other).
- Label.
- Default severity.
- Default responsible party.
- Active status.

#### Status Mapping

Maps customer-specific status terminology to internal standard statuses (Section 12, Administration).

Fields:

- Mapping ID.
- Customer.
- Customer label / code.
- Internal status.
- Active status.

## 15. Required Screens

### 15.1 Login

Purpose:

- Authenticate users.

Requirements:

- Email and password login.
- Forgot password.
- Optional single sign-on later.

### 15.2 Home Dashboard

Purpose:

- Give each user a role-specific operational overview.

Required widgets:

- Trips today by status.
- Trips at risk.
- Unassigned trips.
- Active exceptions.
- On-time pickup percentage.
- On-time arrival percentage.
- Completed trips missing documents.
- Billing pending count.

### 15.3 Trip Import

Purpose:

- Upload and validate customer trip plans.

Required features:

- Customer selector.
- Template selector.
- File upload.
- Preview table.
- Validation results.
- Duplicate warnings.
- Error export.
- Import confirmation.
- Import batch history.

### 15.4 Trip Control Tower

Purpose:

- Main operating board for dispatch and control tower.

Required features:

- Search and filters.
- Saved views by role.
- Status columns or dense table view.
- SLA risk indicators.
- Exception indicators.
- Assignment indicators.
- Bulk selection.
- Quick status update.
- Quick exception creation.

Recommended default views:

- Today.
- Next 24 hours.
- Unassigned.
- At risk.
- In transit.
- Missing documents.
- Billing pending.

### 15.5 Trip Detail

Purpose:

- Complete record for one trip.

Required sections:

- Header with customer, trip ID, lane, status, SLA risk, billing status.
- Planned schedule.
- Actual milestone timestamps.
- Assignment panel.
- Timeline.
- Exceptions.
- Documents.
- Billing.
- Notes.
- Audit history.

### 15.6 Dispatch Board

Purpose:

- Assign resources efficiently.

Required features:

- Unassigned trips by pickup time.
- Resource availability.
- Conflict warnings.
- Assignment confirmation.
- Carrier assignment.
- Vehicle type matching.

### 15.7 Resource Management

Purpose:

- Maintain drivers, vehicles, trailers, and carriers.

Required screens:

- Driver list and detail.
- Vehicle list and detail.
- Trailer list and detail.
- Carrier list and detail.
- Documentation expiration warnings.

### 15.8 Exception Management

Purpose:

- Track operational issues.

Required features:

- Open exception list.
- Filters by severity, customer, lane, reason, owner, and age.
- Exception detail.
- Resolution workflow.
- Attachments.

### 15.9 Documents

Purpose:

- Manage proof-of-execution files and references.

Required features:

- Document checklist by customer.
- Upload documents.
- Review and verification.
- Missing document list.
- Document download.

### 15.10 Billing

Purpose:

- Prepare clean billing exports.

Required features:

- Billing pending list.
- Billing ready list.
- Rate application.
- Extras and penalties.
- Missing proof warnings.
- Export by customer and period.
- Export batch history.

### 15.11 Reports

Purpose:

- Analyze operational and financial performance.

Required reports:

- SLA by customer.
- SLA by lane.
- Delay reasons.
- Exception volume.
- Billing readiness.
- Revenue by customer and lane.
- Carrier performance.

### 15.12 Administration

Purpose:

- Configure master data and system rules.

Required features:

- Users and roles.
- Customers.
- Locations.
- Lanes.
- Import templates.
- Status mappings.
- Reason codes.
- Document requirements.
- SLA rules.
- Rate tables.

### 15.13 Freight Rates (Tabela de Fretes)

Purpose:

- Look up agregado spot prices by route without opening the spreadsheet.

Required features:

- Filters: origin UF/city, destination UF/city, one-way price range.
- Columns: origin, destination, km, vehicle type, one-way price, return price, notes.
- Sorting by one-way price and by distance (missing values last).
- Spreadsheet upload (Admin, Finance) that atomically replaces the whole table,
  with row-level errors on rejection.
- Empty states for "table not loaded yet" and "no rates match the filters".

The navigation label is "Tabela de Fretes" — "Rotas" already names the Lanes screen
(15.12 master data).

## 16. UX Requirements

The product should feel like an operational control system, not a marketing website.

UX principles:

- Dense but readable tables.
- Fast filters and saved views.
- Clear status colors with accessible contrast.
- Minimal clicks for high-frequency dispatcher actions.
- Inline warnings for conflicts and missing data.
- Persistent trip search.
- Keyboard-friendly table navigation where practical.
- Clear separation between customer plan, internal assignment, execution events, documents, and billing.
- Responsive layout for tablets and mobile document upload, but desktop should be the primary design target for MVP.

Critical UX behaviors:

- Dispatchers must be able to assign a trip from the control tower or dispatch board without opening many screens.
- Control tower users must see which trips need immediate attention.
- Finance users must see exactly why a trip is not billing-ready.
- Managers must be able to answer "What is going wrong today?" within one dashboard.

## 17. Notifications and Alerts

### MVP

In-app alerts should be created for:

- Trip within configurable time window and still unassigned.
- Trip within configurable time window and not confirmed.
- Missed planned origin arrival.
- Missed planned departure.
- Missed planned destination arrival.
- High-severity exception opened.
- Trip completed but missing required documents.
- Billing item blocked by missing proof.

MVP uses fixed default time windows for these alerts; per-customer thresholds (SLA-006) and external delivery channels (SLA-007) are post-MVP. Alerts map to the planned data customers actually provide — pickup window start (origin) and delivery window end (destination); "missed departure" uses the confirmation cutoff and time-in-status until per-milestone planned times are supplied (Input #2, Section 29).

### Later

External notifications may include:

- Email alerts.
- SMS alerts.
- WhatsApp provider integration.
- Customer portal notifications.
- Webhooks.

## 18. Permissions

Recommended permission matrix:

| Action | Admin | Ops Manager | Dispatcher | Control Tower | Fleet Coord. | Finance | Executive | Customer Viewer |
|---|---|---|---|---|---|---|---|---|
| View all trips | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| View own customer trips | Yes | Yes | Yes | Yes | Yes | Yes | Yes | Yes |
| Import trips | Yes | Yes | No | No | No | No | No | No |
| Edit trip plan fields | Yes | Yes | Limited | Limited | No | No | No | No |
| Assign resources | Yes | Yes | Yes | No | Yes | No | No | No |
| Update trip status | Yes | Yes | Yes | Yes | No | No | No | No |
| Cancel trip | Yes | Yes | Limited | No | No | No | No | No |
| Mark trip Completed | Yes | Yes | No | Yes | No | No | No | No |
| Mark Billing Ready | Yes | No | No | No | No | Yes | No | No |
| Resolve dispute | Yes | Yes | No | No | No | Yes | No | No |
| Delete / archive records | Yes | No | No | No | No | No | No | No |
| Create exceptions | Yes | Yes | Yes | Yes | Yes | No | No | No |
| Resolve exceptions | Yes | Yes | Yes | Yes | Limited | No | No | No |
| Upload documents | Yes | Yes | Yes | Yes | Yes | Yes | No | Limited |
| Verify documents | Yes | Yes | No | No | No | Yes | No | No |
| Edit rates | Yes | No | No | No | No | Yes | No | No |
| Export billing | Yes | No | No | No | No | Yes | No | No |
| Manage users | Yes | No | No | No | No | No | No | No |
| View freight rate table (13.14) | Yes | Yes | Yes | Yes | Yes | Yes | Yes | No |
| Import freight rate table (13.14) | Yes | No | No | No | No | Yes | No | No |

## 19. Business Rules

### 19.1 Match, Update, and Duplicate Detection

Matching is keyed on **(customer + external trip ID)**:

- **No existing match → New trip.**
- **Existing match with changed plan fields → Update.** The trip is re-planned: original imported plan values are preserved (TRIP-006 / audit log) and the change is recorded as a customer update. A trip already past `Confirmed` requires authorized review before plan fields are updated.
- **Existing match, identical data → No-op** (reported as unchanged), not a new row.

**Potential duplicate** (flagged, not auto-created) when there is **no external trip ID match** but the trip matches another on customer + origin + destination + pickup window + vehicle type within a configurable tolerance.

System should:

- Treat a repeated external trip ID as an update or no-op, never as a blocking duplicate.
- Flag potential duplicates (fuzzy match) for user review; allow creation only with a recorded reason.
- Preserve original imported values and import batch history.

### 19.2 Assignment Conflict Detection

System should warn or block if:

- Driver is already assigned to overlapping trip.
- Vehicle is already assigned to overlapping trip.
- Trailer is already assigned to overlapping trip.
- Driver status is inactive or blocked.
- Vehicle status is inactive, maintenance, or blocked.
- Carrier is not approved or active.
- Vehicle type does not match trip requirement.
- Required resource documentation is expired.

Blocking vs warning behavior should be configurable by customer and company policy.

### 19.3 Completion Rules

A trip can be marked Completed when:

- Required execution milestones have been recorded or exception reason has been provided.
- Trip is not cancelled.
- Unloading is complete, or equivalent completion event exists.
- Required operational closure fields are complete.

### 19.4 Billing Ready Rules

A trip can be marked Billing Ready when:

- Trip is Completed.
- Required documents are accepted or approved exception exists.
- Billing rate or manual billing amount exists.
- Open billing disputes are resolved or explicitly allowed.
- Finance user confirms billing review.

### 19.5 Cancellation Rules

Trip cancellation should require:

- Cancellation reason.
- Cancelled by user.
- Cancellation timestamp.
- Customer-caused, Brazil Transports-caused, carrier-caused, or unknown classification.
- Billing impact selection, such as no charge, cancellation fee, or manual review.

## 20. Integrations

### 20.1 Customer Trip Plans

MVP:

- CSV import.
- Spreadsheet import.
- Manual creation.

Later:

- Customer API.
- Customer portal scraping only if contractually and technically permitted.
- Email attachment ingestion.
- Webhooks.

### 20.2 GPS and Telematics

MVP:

- Manual milestone updates.
- Optional storage of tracker identifiers.

Later:

- Provider integration.
- Location polling.
- Geofence arrival/departure.
- Route deviation alerts.
- ETA prediction.

### 20.3 Documents

MVP:

- File upload and reference fields.

Later:

- OCR.
- External document storage.
- Customer portal document sync.
- CT-e/MDF-e provider integration if selected.

### 20.4 Finance

MVP:

- CSV or spreadsheet billing export.

Later:

- ERP/accounting integration.
- Invoice generation.
- Accounts receivable status sync.

## 21. Non-Functional Requirements

### 21.1 Availability

- MVP target: available during business operating hours with clear maintenance windows.
- Future target: 99.5 percent monthly uptime or better for production.

### 21.2 Performance

- Trip list loads within 3 seconds for common filters.
- Trip detail loads within 2 seconds for standard records.
- Import preview for up to 5,000 rows completes within 60 seconds.
- Search and filter interactions should feel responsive for daily operating volumes.

### 21.3 Scalability

The system should be designed to support:

- Multiple customers.
- Thousands of trips per month.
- Multiple locations and lanes.
- Multiple carriers.
- Large document volume.
- Historical reporting across years.

### 21.4 Security

- Role-based access control.
- Customer data segregation for customer-facing users.
- Secure file storage.
- Audit trail for critical actions.
- Password policy or identity provider integration.
- Encrypted transport for web traffic.
- Principle of least privilege for administrative features.

### 21.5 Auditability

System must preserve:

- Original imported customer data.
- User edits to critical fields.
- Assignment changes.
- Status changes.
- Exception creation and resolution.
- Document verification.
- Billing changes.
- Export batch history.

### 21.6 Localization

Production system should support:

- Portuguese user interface.
- Brazil date/time formats.
- Brazil currency formatting.
- Time zone support.
- Customer-specific terminology.

MVP decision: build with an i18n framework from day one and ship the MVP UI in Portuguese (pt-BR) as the production language. English may be used during development. Currency BRL; timezone `America/Sao_Paulo` (STACK.md §3.5).

### 21.7 Data Retention

Retention requirements should be configurable by company policy and customer contract.

At minimum, system should retain:

- Trip records.
- Event timelines.
- Documents or document references.
- Billing records.
- Audit logs.

## 22. MVP Release Plan

### Phase 1: Foundation

Deliver:

- User authentication.
- Customers.
- Locations.
- Lanes.
- Drivers.
- Vehicles.
- Carriers.
- Basic roles and permissions.

Exit criteria:

- Users can maintain master data needed to execute trips.

### Phase 2: Trip Intake and Control Tower

Deliver:

- CSV/spreadsheet import.
- Import templates.
- Validation.
- Duplicate detection.
- Trip list.
- Trip detail.
- Status model.
- Basic dashboard.

Exit criteria:

- Brazil Transports can import customer trip plans and manage trips in one operating board.

### Phase 3: Dispatch and Execution

Deliver:

- Assignment workflow.
- Conflict warnings.
- Manual event timeline.
- Exception management.
- SLA risk indicators.

Exit criteria:

- Dispatch and control tower can run daily execution from the system.

### Phase 4: Documents and Billing Readiness

Deliver:

- Document upload.
- Document checklist.
- Completion validation.
- Rate tables.
- Billing status.
- Billing export.

Exit criteria:

- Finance can generate billing-ready exports from completed trips.

### Phase 5: Reports and Hardening

Deliver:

- SLA dashboard.
- Exception reporting.
- Billing readiness dashboard.
- Audit history views.
- User acceptance fixes.

Exit criteria:

- Business users can manage daily operations and review performance without relying on external spreadsheets as the system of record.

## 23. MVP Acceptance Criteria

The MVP is acceptable when:

- Shopee, DHL eCommerce, and Mercado Livre trips can be imported using configured templates.
- Invalid rows are flagged with clear error messages.
- Duplicate trips are detected.
- Operations can view and filter all trips.
- Dispatch can assign resources and confirm trips.
- Control tower can update statuses and log exceptions.
- Trip timeline shows planned and actual events.
- Users can upload required proof documents.
- Completed trips can be marked billing pending.
- Finance can validate and export billing-ready trips.
- Dashboards show active trips, at-risk trips, SLA performance, exceptions, and billing readiness.
- Permission rules prevent unauthorized operational and billing changes.
- Critical changes appear in audit history.

## 24. Risks and Mitigations

| Risk | Impact | Mitigation |
|---|---|---|
| Customer files vary frequently | Imports break or require manual fixes | Build configurable import templates and validation reports |
| Operational users keep using spreadsheets | System data becomes incomplete | Make control tower faster than spreadsheet workflow and require system status for billing |
| Missing documents delay billing | Revenue leakage and disputes | Customer-specific document checklists and billing blockers |
| Incomplete resource data | Assignment checks become unreliable | Start with minimal required driver/vehicle/carrier fields and enforce active status |
| Too many custom customer rules | Complexity grows quickly | Use configurable mappings, reason codes, SLA rules, and document requirements |
| Manual milestone updates are late | SLA data quality suffers | Add alerting first, then GPS/mobile integrations after MVP |
| Billing rules are more complex than expected | Finance exports require manual cleanup | Start with simple rates plus manual adjustments, then expand billing engine |

## 25. Open Questions

Items that block the build are consolidated into an actionable checklist in Section 29.

Business and operations:

- What exact trip files are currently received from Shopee, DHL eCommerce, and Mercado Livre?
- How far in advance does each customer send planned trips?
- How often do customers update or cancel trips after sending the plan?
- What are the required SLA rules per customer?
- What are the required proof documents per customer?
- What are the common delay and exception categories used today?
- Which resources are owned fleet versus subcontracted?
- Do drivers need a mobile interface in the MVP, or can control tower update events centrally?

Billing:

- Are rates primarily by lane, vehicle type, customer contract, spot negotiation, or customer-provided value?
- How are tolls handled by customer?
- How is waiting time charged?
- How are cancellations charged?
- How are penalties calculated?
- What exact billing export format does finance need?

Technology (resolved — see STACK.md and Section 30):

- Web-only for MVP: **yes** (desktop-first).
- Document storage: **Supabase Storage** (self-hosted).
- Authentication provider: **Supabase Auth**.
- Customer portal in first release: **no** (Customer Viewer is post-MVP).
- Existing ERP/accounting/fleet/GPS/document systems to integrate: **none for MVP** (integrations are post-MVP); confirm with the business whether any hard dependency exists (Input #7, Section 29).

## 26. Technology Architecture

The authoritative technology and infrastructure decisions live in **STACK.md**. This PRD does not duplicate them; in any conflict, STACK.md governs.

Product-level constraints the architecture must satisfy:

- Web application (desktop-first) for operations, dispatch, control tower, finance, and management.
- Relational database as the system of record for trips, resources, events, exceptions, billing, and audit history.
- Object storage for uploaded documents (metadata in the database).
- Background processing for imports, validation, exports, SLA recalculation, and alerts.
- Authorization enforced in the application (BFF); database-level RLS is deferred until direct client access exists (STACK.md §5.2).

The "services" below are **logical modules within one application + one worker** (STACK.md: monolith + worker, not microservices): trip, import, assignment, event/exception, document, billing, reporting, notification, audit.

## 27. Glossary

| Term | Meaning |
|---|---|
| Linehaul | Transport movement between hubs, fulfillment centers, sorting centers, cross-docks, or major nodes. |
| Pre-planned trip | Trip created by customer planning process and sent to Brazil Transports for execution. |
| Control tower | Operational team and system view responsible for monitoring active transport execution. |
| SLA | Service-level agreement or operational service target. |
| POD | Proof of delivery or proof of execution document. |
| CT-e | Electronic transport knowledge document reference used in Brazil operations when applicable. |
| MDF-e | Electronic fiscal manifest document reference used in Brazil operations when applicable. |
| Carrier | External subcontracted transport provider. |
| Lane | Origin-destination pair, usually customer-specific. |
| Exception | Operational event that may affect execution, SLA, safety, billing, or customer communication. |
| Billing Ready | Completed trip with sufficient proof and pricing data for billing export or invoice preparation. |

## 28. Summary

Brazil Transports needs an execution system centered on operational control, not route planning. The highest-value first release is a control tower platform that receives customer trip plans, validates them, assigns resources, tracks execution, manages exceptions, stores proof, and prepares billing.

The MVP should make the system the daily source of truth for operations and finance. Once that foundation is stable, Brazil Transports can add GPS integrations, customer APIs, driver mobile workflows, automated alerts, advanced billing, and customer portals.

## 29. Inputs Required Before Build (Gating Checklist)

These are business/customer inputs the team cannot invent. Each gates specific MVP requirements; collect before the corresponding phase (Section 22).

| # | Input needed | Source | Gates | Gated phase |
|---|---|---|---|---|
| 1 | Real sample files from Shopee, DHL eCommerce, Mercado Livre (current formats) | Customers / Ops | INT-002/003, CUST-003, import templates, 19.1 | Phase 2 |
| 2 | Per-customer SLA rules (pickup/delivery on-time definitions, tolerances, confirmation cutoffs) | Customers / Ops | SLA-001/002/003, CUST-005, REP-002, 12.2 | Phase 3 |
| 3 | Per-customer required proof documents | Customers / Ops | DOC-003/005, BILL-006, 19.4 | Phase 4 |
| 4 | Finance billing export format (exact columns / layout) | Finance | BILL-007/008 | Phase 4 |
| 5 | Billing rules: toll / waiting-time / penalty / cancellation handling per customer | Finance | BILL-004 (MVP uses manual adjustments until provided) | Phase 4 |
| 6 | Owned-fleet vs subcontracted resource split | Ops | RES-* setup, assignment policy | Phase 1 |
| 7 | Confirm no hard ERP/GPS/document integration dependency for MVP | Business | Scope guard (Section 5) | Phase 1 |

Until Input #1 is available, the import engine can be built but customer configs and import tests cannot be finalized. Until Inputs #2–#5 arrive, SLA, document-gating, and billing can be scaffolded against defaults but not signed off.

## 30. Decision Log (v1.1)

Decisions made to bring this PRD to execution-readiness. Override any of these if the business disagrees.

- **Architecture** reconciled to STACK.md (Section 26); removed the conflicting "data-layer RBAC" and the microservice decomposition.
- **Roles**: MVP ships 7 internal roles; Customer Viewer is post-MVP; collapse roles with identical permissions (AUTH-002, STACK.md §3.8).
- **Status machine** (12.1) and **SLA status enum** (12.2) defined; Loading/Unloading optional; Cancelled/Disputed entry/exit defined; "Warning" is a flag, not a status.
- **Import semantics** (19.1): a repeated external trip ID is an update or no-op, never a blocking duplicate; a fuzzy match without an ID is a flagged potential duplicate.
- **Planned vs executed** (Section 14, Trip): plan immutable after import; actuals recorded as Trip Events; prior plan values preserved in the audit log.
- **Assignment cardinality** (Section 14): one current assignment per trip; substitutions supersede and are retained for history.
- **Data model**: added User, Import Template, Customer SLA Rule, Document Requirement, Reason Code, Status Mapping; added currency to Billing Item; soft-delete over hard delete.
- **Permissions** (Section 18): added Cancel, Mark Completed, Mark Billing Ready, Resolve dispute, Delete/Archive.
- **Localization** (21.6): i18n from day one; MVP UI in pt-BR.
- **SLA milestone data**: MVP SLA computed from pickup/delivery windows + assignment/confirmation cutoffs; per-milestone planned times deferred to Input #2.
- **Collapse validation statuses** (slice 015, 2026-06-07): the three early validation states — `Received`, `Validation Error`, `Validated` — are collapsed into a single `Received`, which becomes the first **dispatchable** status (§12, §12.1). Import already validates every row (only Valid/Warning rows are applied), so a separate trip-level validate hop carried no information. The active status machine drops from 18 to 16 values; `Assigned`/`Confirmed` and everything from `Confirmed` onward are unchanged (the confirm step and the confirmation-cutoff SLA are out of scope). This **supersedes slice 014's born-`Validated`** decision: imported trips are now born `Received`, and assign/unassign run `Received → Assigned` / `Assigned → Received`. The `trip_status` DB enum keeps all 18 physical members (Postgres has no `DROP VALUE`); the two removed values become **dormant** (retained only for immutable `trip_events` history) and a one-time data migration backfills any live trip off them. The separate `import_batch_status` enum (which also has `validated`) is untouched.
- **Freight rate lookup (slice 016, 2026-07-13)**: NEW scope added on the product owner's request — an internal agregados spot-price table ("Tabela de Fretes", 13.14 / 15.13) searchable by route and one-way price, replaced wholesale by uploading the standard spreadsheet (Admin + Finance, mirroring the "Edit rates" precedent in Section 18). Deliberately separate from customer lane pricing (LANE-004): lane rates are contracted per customer; this table is agregado spot pricing maintained outside the system. Vehicle types are free-form labels from the sheet (not the fleet vehicle-type enum) so new labels never require a migration. The spreadsheet holds commercial data and must never enter the (public) repository — tests and seeds are synthetic.
- **Trip cancellation exposure & Dispatcher "Limited" (slice 017, 2026-07-27)**: the §18 `Cancel trip` action ships in the UI on three surfaces — Trip Detail, the Dispatch board row, and the Control Tower table row — all driving the single justified flow (§19.5: reason + responsible party + billing impact; user and timestamp recorded server-side). The Dispatcher's **"Limited"** cell is defined as: a Dispatcher may cancel only trips still in the **dispatch phase** (`Received`, `Assigned`, `Confirmed`); Admin and Ops Manager may cancel any legally cancellable trip (§12.1). Cancellation is reachable ONLY through the dedicated cancellation flow — the generic status-update path refuses `Cancelled` as a target, closing a §19.5 bypass. Default pt-BR cancellation **reason** options are seeded as labeled scaffolding (billing impacts were already seeded per §19.5); the final lists remain config-driven with business sign-off pending.
