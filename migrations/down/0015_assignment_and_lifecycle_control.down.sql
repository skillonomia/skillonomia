-- 0015 REVERSED — the exact inverse of
-- `migrations/0015_assignment_and_lifecycle_control.sql`.
--
-- `0015` adds five tables, five indexes and nine triggers and alters nothing. Dropping exactly those objects and setting
-- `PRAGMA user_version` back to 14 returns the database to the schema it had,
-- object for object — which is what `v1/tools/gates/reversible-migration.sh`
-- asserts by comparing the schema before the upgrade with the schema after the
-- reversal, and then migrating up a second time to show the round trip
-- converges.
--
-- DROPPING `idempotency_request_digests` discards the payload fingerprints,
-- which costs the `409` of `P3-FR-10` on keys that were used before the
-- reversal and nothing else — the replay itself is keyed on
-- (actor, surface, key), lives in a table this reversal does not touch, and is
-- unaffected.
--
-- WHAT IT COSTS, STATED RATHER THAN GLOSSED. Reversal DROPS the rows of the
-- five tables: the per-revision approvals, the assignments, their lifecycle
-- journal, the observations reported against them and the payload
-- fingerprints. These are V1-only data
-- that exist nowhere else. `draft_decisions` is NOT touched, so the first
-- decision an owner took on each lineage survives the reversal — which is the
-- other half of why `0015` writes both rows rather than moving the fact. Take a
-- copy of the database file first; the runbook in
-- `v1/P3-ASSIGNMENT-LIFECYCLE.md` says so, and the gate runs on a disposable
-- database only. No table that existed at `PRAGMA user_version` 14 loses a row.

DROP TRIGGER IF EXISTS tg_idempotency_request_digests_no_upd;
DROP TABLE IF EXISTS idempotency_request_digests;

DROP TRIGGER IF EXISTS tg_assignment_observations_no_del;
DROP TRIGGER IF EXISTS tg_assignment_observations_no_upd;
DROP TRIGGER IF EXISTS tg_skill_assignment_events_no_del;
DROP TRIGGER IF EXISTS tg_skill_assignment_events_no_upd;
DROP TRIGGER IF EXISTS tg_skill_assignments_no_del;
DROP TRIGGER IF EXISTS tg_skill_assignments_no_upd;
DROP TRIGGER IF EXISTS tg_revision_approvals_no_del;
DROP TRIGGER IF EXISTS tg_revision_approvals_no_upd;

DROP INDEX IF EXISTS idx_assignment_observations_assignment;
DROP TABLE IF EXISTS assignment_observations;

DROP INDEX IF EXISTS idx_skill_assignment_events_assignment;
DROP TABLE IF EXISTS skill_assignment_events;

DROP INDEX IF EXISTS idx_skill_assignments_workspace;
DROP INDEX IF EXISTS idx_skill_assignments_agent;
DROP TABLE IF EXISTS skill_assignments;

DROP INDEX IF EXISTS idx_revision_approvals_draft;
DROP TABLE IF EXISTS revision_approvals;

PRAGMA user_version=14;
