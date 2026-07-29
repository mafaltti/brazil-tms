# Implementation Plan: License/Document Expiry Visibility in Resource Lists

**Branch**: `020-license-expiry-visibility` | **Date**: 2026-07-27 | **Spec**: [spec.md](./spec.md)

## Summary

Issue #27 [0004]: the "Validade da CNH" column never shows the date (`ok` → "—"; warn/expired →
badge only) and "no date" is conflated with "healthy". Everything needed is already delivered to
the client (`licenseExpiry`/`documentExpiry` + `documentExpiryState`, 30-day window). Fix: one
shared **`ExpiryCell`** rendering date + state across the drivers, vehicles, and trailers lists
(clarification 2026-07-27): `null` → "Não informada" (muted) · `ok` → `formatDate` plain ·
`expiring` → date + outline "A vencer" · `expired` → red date + destructive "Vencido". Presentation
only — no DTO/read/form/eligibility change; no new dependency.

## Technical Context

**Testing**: e2e extension (`master-data-resources.spec.ts` or a small new spec) seeding the four
driver states + one vehicle case; existing suites as regression. No Vitest change (no logic — the
state derivation is already unit-tested in shared).

**Everything else**: unchanged (presentation-only; pt-BR; no polling change; ≥3 uses justify the one
shared cell component).

## Constitution Check

- [x] **Simplicity (I)**: one ~30-line shared cell used 3× (≥3 rule at birth); no re-derivation of state in the UI.
- [x] **Scope (II)**: direct issue-#27 fix; alert-engine extension explicitly out of scope.
- [x] **System-of-record (III) / Authz (IV) / Config (V) / Tech constraints**: untouched (read-only presentation).
- [x] **Workflow**: branch `020-…` off `dev`; PR to `dev`; CI gates.

**Result: PASS.**

## Project Structure

```text
apps/web/components/master-data/
├── expiry-cell.tsx                # NEW — ExpiryCell({ date, state }): the four-state presentation
│                                  #   (formatDate + ExpiryState badges; "Não informada" for null).
├── drivers-client.tsx             # EDIT — "_expiry" column cell → <ExpiryCell date={licenseExpiry} …>
├── vehicles-client.tsx            # EDIT — same, documentExpiry
└── trailers-client.tsx            # EDIT — same, documentExpiry

apps/web/messages/pt-BR.json       # EDIT — ExpiryState.notInformed "Não informada"

apps/web/e2e/expiry-visibility.spec.ts  # NEW — four seeded driver states render date/badges/red per
                                   #   spec; one vehicle case for FR-004; lists reachable as fleet_coordinator.

# UNCHANGED: services/DTOs, documentExpiryState (shared), forms, driver detail, eligibility engine.
```

## Complexity Tracking

None.
