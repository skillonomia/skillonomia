-- 0014 REVERSED — the exact inverse of
-- `migrations/0014_owner_console_sessions_and_decisions.sql`.
--
-- `0014` is purely additive: five tables, two indexes and ten triggers, and it
-- alters nothing that existed before it. Dropping exactly those objects and
-- setting `PRAGMA user_version` back to 13 returns the database to the schema it
-- had, object for object — which is what
-- `v1/tools/gates/reversible-migration.sh` asserts by comparing the schema
-- before the upgrade with the schema after the reversal, and then migrating up a
-- second time to show the round trip converges.
--
-- WHAT IT COSTS, STATED RATHER THAN GLOSSED. Reversal DROPS the rows of the five
-- tables. Live browser sessions and outstanding tickets are process-lifetime
-- state and their loss is a re-login; the decisions are not, and a reversal after
-- an owner has approved or rejected a draft discards those decisions while
-- leaving the captures, the revisions and the `draft_events` audit of `0013`
-- untouched. Take a copy of the database file first — the runbook in
-- `v1/P2-OWNER-CONSOLE.md` says so, and the gate runs on a disposable database
-- only. No table that existed at `PRAGMA user_version` 13 is touched by any
-- statement here.

DROP TRIGGER IF EXISTS tg_draft_decisions_no_del;
DROP TRIGGER IF EXISTS tg_draft_decisions_no_upd;
DROP TRIGGER IF EXISTS tg_console_ticket_uses_no_del;
DROP TRIGGER IF EXISTS tg_console_ticket_uses_no_upd;
DROP TRIGGER IF EXISTS tg_console_tickets_no_del;
DROP TRIGGER IF EXISTS tg_console_tickets_no_upd;
DROP TRIGGER IF EXISTS tg_owner_session_revocations_no_del;
DROP TRIGGER IF EXISTS tg_owner_session_revocations_no_upd;
DROP TRIGGER IF EXISTS tg_owner_sessions_no_del;
DROP TRIGGER IF EXISTS tg_owner_sessions_no_upd;

DROP INDEX IF EXISTS idx_draft_decisions_workspace;
DROP TABLE IF EXISTS draft_decisions;

DROP TABLE IF EXISTS console_ticket_uses;
DROP TABLE IF EXISTS console_tickets;
DROP TABLE IF EXISTS owner_session_revocations;

DROP INDEX IF EXISTS idx_owner_sessions_agent;
DROP TABLE IF EXISTS owner_sessions;

PRAGMA user_version=13;
