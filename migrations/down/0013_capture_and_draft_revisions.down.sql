-- 0013 REVERSED — the exact inverse of `migrations/0013_capture_and_draft_revisions.sql`.
--
-- WHY THIS FILE EXISTS AND THE TWELVE BEFORE IT HAVE NO COUNTERPART. Until this
-- migration, reversal in this tree was restore-from-copy: no numbered migration
-- shipped a `DOWN` script, and `v1/P0-BASELINE.md` records that as a fact about
-- the base rather than an oversight. The V1 contract requires every schema
-- change to be additive AND reversible, so the change that introduces the
-- capture/draft domain ships its own reversal instead of inheriting an absence.
--
-- WHAT MAKES IT SAFE. `0013` is purely additive: it creates three tables,
-- three indexes and six triggers, and alters nothing that existed before it.
-- Dropping exactly those objects and setting `PRAGMA user_version` back to 12
-- therefore returns the database to the schema it had, object for object —
-- which is what `v1/tools/gates/reversible-migration.sh` asserts by comparing
-- the schema before the upgrade with the schema after the reversal, and then
-- migrating up a second time to show the round trip converges.
--
-- WHAT IT COSTS, STATED RATHER THAN GLOSSED. Reversal DROPS the rows of the
-- three tables: captures, draft revisions and their audit are V1-only data that
-- exists nowhere else, so a reversal after drafts have been created discards
-- them. The runbook in `v1/P1-CAPTURE-DRAFT.md` says to take a copy of the
-- database file first, and the gate runs on a disposable database only. No
-- table that existed at `PRAGMA user_version` 12 is touched by any statement
-- here, so no data of the released base is at risk either way.

DROP TRIGGER IF EXISTS tg_draft_events_no_del;
DROP TRIGGER IF EXISTS tg_draft_events_no_upd;
DROP TRIGGER IF EXISTS tg_draft_revisions_no_del;
DROP TRIGGER IF EXISTS tg_draft_revisions_no_upd;
DROP TRIGGER IF EXISTS tg_captures_no_del;
DROP TRIGGER IF EXISTS tg_captures_no_upd;

DROP INDEX IF EXISTS idx_draft_events_draft;
DROP TABLE IF EXISTS draft_events;

DROP INDEX IF EXISTS idx_draft_revisions_draft;
DROP TABLE IF EXISTS draft_revisions;

DROP INDEX IF EXISTS idx_captures_workspace;
DROP TABLE IF EXISTS captures;

PRAGMA user_version=12;
