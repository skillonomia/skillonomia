-- 0019 — A REVIEWER MAY OPEN THE CONSOLE, AND OPENING IT WIDENS NOTHING ELSE.
--
-- WHAT WAS WRONG. v1.0.0's console was an OWNER console and said so in the
-- schema: `console_tickets.actor_role` and `owner_sessions.actor_role` both
-- carry `CHECK(actor_role IN ('owner','admin'))`. A reviewer is the actor whose
-- whole job is to record a verdict on a version, and the only surface that
-- recorded one was the machine-to-machine API. So the reviewer's normal path
-- ran through a Bearer key and a hand-written JSON body, and the console — the
-- surface a human is supposed to use — was closed to the one human role that
-- exists to make a judgement.
--
-- WHAT IS TRUE INSTEAD (SPEC.md section 6.4). The console admits three roles:
-- `owner`, `admin` and `reviewer`. A ticket may be minted for a reviewer and a
-- session may be opened as one, so `actor_role` on both tables admits the third
-- value. That is the whole of this migration.
--
-- WHAT THIS DELIBERATELY DOES NOT WIDEN, and the reason each is left alone:
--
--   `draft_decisions.actor_role` keeps `CHECK(actor_role IN ('owner','admin'))`.
--   An owner decision about a draft is not a reviewer's to make, and leaving the
--   column narrow means the database refuses one even if a route ever forgets
--   to. The same is true of `0015`'s assignment tables. A reviewer admitted to a
--   SESSION is not a reviewer admitted to every row the session can name, and
--   the columns that would have to change for that are exactly the ones that do
--   not change here.
--
--   The resource ACL is untouched. Which versions a reviewer may see and which
--   calls it may make are decided by the service layer against the same
--   `AuthContext` a Bearer key produces; this migration changes what may be
--   STORED in two columns and nothing about what may be READ.
--
-- WHY THIS IS A REBUILD AND NOT AN `ALTER`. SQLite cannot relax a `CHECK` in
-- place, so a wider constraint means the table is written again. The form below
-- is chosen so that no foreign key is ever left pointing at a name that has
-- moved: each table is copied into a scratch table, DROPPED, RE-CREATED UNDER
-- ITS OWN NAME, and refilled. `ALTER TABLE … RENAME` is deliberately not used —
-- with `PRAGMA foreign_keys=ON`, which this deployment always runs with, a
-- rename rewrites the `REFERENCES` clause of every table pointing at the one
-- being renamed, and `console_ticket_uses` and `owner_session_revocations` would
-- silently come to reference a scratch name. Creating the replacement under the
-- original name leaves those two children exactly as `0014` wrote them.
--
-- `PRAGMA defer_foreign_keys=ON` holds the children's `ON DELETE RESTRICT`
-- open across the drop: the rows are re-inserted into the same table name
-- before the migration's transaction commits, so the references resolve and the
-- constraint is satisfied at COMMIT rather than waived. A database whose
-- children do NOT resolve leaves this migration by ROLLBACK.
--
-- NO ROW IS LOST AND NO ROW IS EDITED. Every column is copied across by name.
-- The four INSERT-only triggers and the one index that `0014` attached to these
-- two tables are dropped with them and re-created here with the same text
-- `0014` uses, so the live schema keeps saying what `0014` said about them.
--
-- `PRAGMA user_version` = `19`.

PRAGMA defer_foreign_keys=ON;

-- ==================== 1. console_tickets ====================

CREATE TABLE mig0019_console_tickets AS SELECT * FROM console_tickets;
DROP TABLE console_tickets;
CREATE TABLE console_tickets(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer')),
  ticket_hash TEXT NOT NULL UNIQUE CHECK(length(ticket_hash)=71),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  expires_at_ms INTEGER NOT NULL,
  CHECK(expires_at_ms - created_at_ms BETWEEN 1 AND 300000)
);
INSERT INTO console_tickets(id, workspace_id, agent_id, actor_role, ticket_hash, created_at_ms, expires_at_ms)
  SELECT id, workspace_id, agent_id, actor_role, ticket_hash, created_at_ms, expires_at_ms
    FROM mig0019_console_tickets;
DROP TABLE mig0019_console_tickets;

CREATE TRIGGER tg_console_tickets_no_upd BEFORE UPDATE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_tickets_no_del BEFORE DELETE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

-- ==================== 2. owner_sessions ====================

CREATE TABLE mig0019_owner_sessions AS SELECT * FROM owner_sessions;
DROP TABLE owner_sessions;
CREATE TABLE owner_sessions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer')),
  token_hash TEXT NOT NULL UNIQUE CHECK(length(token_hash)=71),
  csrf_token TEXT NOT NULL CHECK(length(csrf_token) BETWEEN 16 AND 128),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  absolute_expires_at_ms INTEGER NOT NULL,
  CHECK(absolute_expires_at_ms - created_at_ms BETWEEN 1 AND 3600000)
);
INSERT INTO owner_sessions(id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms)
  SELECT id, workspace_id, agent_id, actor_role, token_hash, csrf_token, created_at_ms, absolute_expires_at_ms
    FROM mig0019_owner_sessions;
DROP TABLE mig0019_owner_sessions;

CREATE INDEX idx_owner_sessions_agent ON owner_sessions(agent_id,created_at_ms);

CREATE TRIGGER tg_owner_sessions_no_upd BEFORE UPDATE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_owner_sessions_no_del BEFORE DELETE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
