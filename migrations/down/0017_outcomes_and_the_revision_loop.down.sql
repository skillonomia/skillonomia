-- 0017 REVERSED — the exact inverse of
-- `migrations/0017_outcomes_and_the_revision_loop.sql`.
--
-- `0017` adds five tables, six indexes and ten triggers and alters nothing.
-- Dropping exactly those objects and setting `PRAGMA user_version` back to 16
-- returns the database to the schema it had, object for object — which is what
-- `v1/tools/gates/reversible-migration.sh` asserts before migrating up a second
-- time to show the round trip converges.
--
-- WHAT IT COSTS, STATED RATHER THAN GLOSSED. Reversal DROPS the rows of the five
-- tables: the session closures, the normalised outcomes, the recorded conflicts,
-- the lineage of every revision created from a failure or a remark, and the
-- comparisons drawn between revisions. These are the record of what a skill DID,
-- and they exist nowhere else.
--
-- WHAT IT DOES NOT COST. The revisions themselves are `0013` rows and survive: a
-- revision created from a failure is still a revision, still approved, still
-- assignable. What reversal loses is the STATEMENT that it descends from a
-- particular failure — the lineage claim, not the lineage's content. The
-- sessions, loadouts and runtime receipts of `0016` are untouched, so the chain
-- through `invoked` survives a reversal of this migration in full.
--
-- Take a copy of the database file first.

DROP TRIGGER IF EXISTS tg_revision_comparisons_no_del;
DROP TRIGGER IF EXISTS tg_revision_comparisons_no_upd;
DROP TRIGGER IF EXISTS tg_revision_sources_no_del;
DROP TRIGGER IF EXISTS tg_revision_sources_no_upd;
DROP TRIGGER IF EXISTS tg_outcome_conflicts_no_del;
DROP TRIGGER IF EXISTS tg_outcome_conflicts_no_upd;
DROP TRIGGER IF EXISTS tg_session_outcomes_no_del;
DROP TRIGGER IF EXISTS tg_session_outcomes_no_upd;
DROP TRIGGER IF EXISTS tg_session_closures_no_del;
DROP TRIGGER IF EXISTS tg_session_closures_no_upd;

DROP INDEX IF EXISTS idx_revision_comparisons_draft;
DROP TABLE IF EXISTS revision_comparisons;

DROP INDEX IF EXISTS idx_revision_sources_draft;
DROP TABLE IF EXISTS revision_sources;

DROP INDEX IF EXISTS idx_outcome_conflicts_entry;
DROP TABLE IF EXISTS outcome_conflicts;

DROP INDEX IF EXISTS idx_session_outcomes_revision;
DROP INDEX IF EXISTS idx_session_outcomes_entry;
DROP INDEX IF EXISTS idx_session_outcomes_session;
DROP TABLE IF EXISTS session_outcomes;

DROP TABLE IF EXISTS session_closures;

PRAGMA user_version=16;
