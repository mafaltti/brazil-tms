-- Custom SQL migration file, put your code below! --

-- slice 015 (FR-006): collapse the validation statuses into 'received'. The active TS machine dropped
-- `validation_error` and `validated`; resolve any pre-existing trip rows still holding those (now
-- dormant) values to `received` so nothing is stranded or unrenderable. The pgEnum keeps all 18
-- physical members, so these literals are still valid here. `trip_events` history is IMMUTABLE and is
-- left intact (its status_before/status_after rows may still reference the dormant values).
-- Idempotent: a re-run matches nothing after the first apply.

UPDATE "trips" SET "current_status" = 'received'
  WHERE "current_status" IN ('validated', 'validation_error');

UPDATE "trips" SET "disputed_from_status" = 'received'
  WHERE "disputed_from_status" IN ('validated', 'validation_error');

-- `status_mappings.internal_status` is a config target also pinned to the 16-value machine; resolve any
-- pre-collapse mapping that pointed at a now-dormant value (the customer's validated-equivalent label
-- now maps to `received`, the dispatchable status). The upsert path already rejects dormant targets.
UPDATE "status_mappings" SET "internal_status" = 'received'
  WHERE "internal_status" IN ('validated', 'validation_error');
