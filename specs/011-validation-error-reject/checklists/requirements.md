# Specification Quality Checklist: Validation-Error Reject Action

**Created**: 2026-06-02 · **Feature**: [spec.md](../spec.md)

## Content Quality

- [x] Focused on user value (completes the validate/reject pair so a bad trip can be flagged)
- [x] Mandatory sections completed
- [x] Grounds the "adds nothing durable" claim in concrete existing artifacts (the `notes` field, the `/status` endpoint, the legal edge)

## Requirement Completeness

- [x] No [NEEDS CLARIFICATION] markers
- [x] Requirements testable; success criteria measurable
- [x] Edge cases identified (stale submit; empty-reason via direct API)
- [x] Scope bounded (reject only; auto-validator + server-enforced reason explicitly deferred)
- [x] Dependencies/assumptions identified (extends slice 010 on the same branch)

## Feature Readiness

- [x] FRs have acceptance criteria; SCs cover the outcomes
- [x] No new durable artifact (verified: reuses endpoint/service/permission/`notes`)

## Notes

- Micro-slice folded into PR #13 (the `010-trip-validation-dispatch-fix` branch) because it extends slice 010's not-yet-merged `ValidateAction` on the same Trip Detail surface.
- Reason is client-required; `transitionTripSchema.notes` stays optional server-side by design.
