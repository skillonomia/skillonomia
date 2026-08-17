-- 0016 REVERSED — the exact inverse of
-- `migrations/0016_session_loadout_and_runtime_receipts.sql`.
--
-- `0016` adds four tables, five indexes and eight triggers and alters nothing.
-- Dropping exactly those objects and setting `PRAGMA user_version` back to 15
-- returns the database to the schema it had, object for object — which is what
-- `v1/tools/gates/reversible-migration.sh` asserts, before migrating up a second
-- time to show the round trip converges.
--
-- WHAT IT COSTS, STATED RATHER THAN GLOSSED. Reversal DROPS the rows of the four
-- tables: the runtime sessions, their immutable loadouts and entries, and the
-- runtime receipts. These are the evidence a stage past `proposed` was ever
-- confirmed, and they exist nowhere else.
--
-- WHAT IT DOES NOT COST, WHICH IS THE POINT `P4-FR-08` MAKES ABOUT THE OTHER
-- DIRECTION. Nothing canonical is in these tables. The skills, the revisions,
-- the approvals, the assignments and their lifecycle journal are `0013`, `0014`
-- and `0015` data and this reversal does not touch a row of them. A deployment
-- that reverses `0016` loses its record of what a runtime confirmed; it loses no
-- capability, no assignment and no history. The derived native FILES are not in
-- the database at all — they are session-scoped directories under the adapter's
-- materialization base, and deleting those is `skillonomia adapter cleanup`,
-- which likewise destroys nothing canonical.
--
-- `assignment_observations` is `0015`'s table and survives. An observation whose
-- provenance names a receipt id that no longer resolves is the honest residue of
-- a reversal: the observation was true when it was written, and this migration
-- does not rewrite history to make the dangling reference tidy.
-- Take a copy of the database file first.

DROP TRIGGER IF EXISTS tg_runtime_receipts_no_del;
DROP TRIGGER IF EXISTS tg_runtime_receipts_no_upd;
DROP TRIGGER IF EXISTS tg_session_loadout_entries_no_del;
DROP TRIGGER IF EXISTS tg_session_loadout_entries_no_upd;
DROP TRIGGER IF EXISTS tg_session_loadouts_no_del;
DROP TRIGGER IF EXISTS tg_session_loadouts_no_upd;
DROP TRIGGER IF EXISTS tg_agent_sessions_no_del;
DROP TRIGGER IF EXISTS tg_agent_sessions_no_upd;

DROP INDEX IF EXISTS idx_runtime_receipts_entry;
DROP INDEX IF EXISTS idx_runtime_receipts_session;
DROP TABLE IF EXISTS runtime_receipts;

DROP INDEX IF EXISTS idx_session_loadout_entries_loadout;
DROP TABLE IF EXISTS session_loadout_entries;

DROP INDEX IF EXISTS idx_session_loadouts_agent;
DROP TABLE IF EXISTS session_loadouts;

DROP INDEX IF EXISTS idx_agent_sessions_agent;
DROP TABLE IF EXISTS agent_sessions;

PRAGMA user_version=15;
