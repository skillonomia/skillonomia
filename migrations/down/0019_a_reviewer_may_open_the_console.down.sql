-- 0019 REVERSED — the exact inverse of
-- `migrations/0019_a_reviewer_may_open_the_console.sql`.
--
-- `0019` widens one `CHECK` on each of two tables and changes nothing else: no
-- column is added or removed, no row is edited, no other object is touched. The
-- reversal is therefore the same rebuild run the other way, narrowing
-- `actor_role` on `console_tickets` and `owner_sessions` back to the two values
-- `0014` admitted.
--
-- WHAT THE REVERSAL REFUSES TO DO, and why refusing is the right answer. A
-- narrower constraint cannot hold a row that a wider one accepted. If a reviewer
-- has opened a console since the migration ran, its ticket and its session are
-- rows this reversal cannot store — and the two answers available are to DELETE
-- them or to STOP. Deleting them would destroy a record of who was admitted to
-- the console and when, which is exactly the kind of evidence this registry does
-- not rewrite. So the copy-back below simply fails on such a row: the `CHECK` on
-- the re-created table refuses it, the migration runner's ROLLBACK unwinds
-- everything, and `PRAGMA user_version` is left exactly where it was found. An
-- operator who genuinely wants the older schema takes the copy made before the
-- upgrade, which is what the documented rollback procedure says in the first
-- place.
--
-- `PRAGMA defer_foreign_keys=ON` for the reason the forward migration uses it:
-- the two children keep pointing at these tables by name across the drop, and
-- their `ON DELETE RESTRICT` is satisfied again once the rows are back.
--
-- `DROP … IF EXISTS` for the triggers and the index, for the reason every
-- reversal in this directory uses it: a reversal may be run against a database
-- that never reached this version, and refusing that is a worse answer than
-- converging.

PRAGMA defer_foreign_keys=ON;

DROP TRIGGER IF EXISTS tg_console_tickets_no_upd;
DROP TRIGGER IF EXISTS tg_console_tickets_no_del;

CREATE TABLE mig0019_down_console_tickets AS SELECT * FROM console_tickets;
DROP TABLE console_tickets;
CREATE TABLE console_tickets(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  ticket_hash TEXT NOT NULL UNIQUE CHECK(length(ticket_hash)=71),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  expires_at_ms INTEGER NOT NULL,
  CHECK(expires_at_ms - created_at_ms BETWEEN 1 AND 300000)
);
INSERT INTO console_tickets(id, workspace_id, agent_id, actor_role, ticket_hash, created_at_ms, expires_at_ms)
  SELECT id, workspace_id, agent_id, actor_role, ticket_hash, created_at_ms, expires_at_ms
    FROM mig0019_down_console_tickets;
DROP TABLE mig0019_down_console_tickets;

CREATE TRIGGER tg_console_tickets_no_upd BEFORE UPDATE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_tickets_no_del BEFORE DELETE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

DROP TRIGGER IF EXISTS tg_owner_sessions_no_upd;
DROP TRIGGER IF EXISTS tg_owner_sessions_no_del;
DROP INDEX IF EXISTS idx_owner_sessions_agent;

CREATE TABLE mig0019_down_owner_sessions AS SELECT * FROM owner_sessions;
DROP TABLE owner_sessions;
CREATE TABLE owner_sessions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=71),
  csrf_token TEXT NOT NULL CHECK(length(csrf_token) BETWEEN 16 AND 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  absolute_expires_at_ms INTEGER NOT NULL,
  CHECK(absolute_expires_at_ms - created_at_ms BETWEEN 1 AND 3600000)
);
INSERT INTO owner_sessions(id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms)
  SELECT id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms
    FROM mig0019_down_owner_sessions;
DROP TABLE mig0019_down_owner_sessions;

CREATE INDEX idx_owner_sessions_agent ON owner_sessions(agent_id,created_at_ms);

CREATE TRIGGER tg_owner_sessions_no_upd BEFORE UPDATE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_owner_sessions_no_del BEFORE DELETE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

PRAGMA user_version=18;
