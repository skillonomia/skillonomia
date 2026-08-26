-- 0018 REVERSED — the exact inverse of
-- `migrations/0018_a_revocation_and_a_replacement_are_two_facts.sql`.
--
-- `0018` adds three indexes and two triggers and alters nothing: no table is
-- created or rebuilt, no column is added or changed, and no row is written. Its
-- three scratch tables are created, read and dropped inside the migration's own
-- transaction, so there is nothing of them left to drop here — an object that
-- never survived the migration cannot be part of its reversal.
--
-- Dropping exactly those five objects and setting `PRAGMA user_version` back to
-- 17 restores the schema `0017` leaves, object for object. That is the whole of
-- the reversal, and it is total: because `0018` writes no data, going back
-- loses nothing that going forward gained. What the reversal does give up is
-- the ENFORCEMENT — a v1.0.0 build reading the reverted database can once again
-- write a version whose reason and state disagree — which is why the documented
-- rollback procedure makes its target a copy taken BEFORE the migration rather
-- than a database walked backwards through it.
--
-- `DROP … IF EXISTS` throughout, for the reason every reversal in this
-- directory uses it: a reversal may be run against a database that never
-- reached this version, and refusing that is a worse answer than converging.

DROP TRIGGER IF EXISTS tg_version_disposition_upd;
DROP TRIGGER IF EXISTS tg_version_disposition_ins;

DROP INDEX IF EXISTS idx_versions_disposition;
DROP INDEX IF EXISTS uq_versions_supersedes;
DROP INDEX IF EXISTS uq_versions_superseded_by;

PRAGMA user_version=17;
