-- 0014 — THE OWNER CONSOLE: A BROWSER SESSION THAT CARRIES NO KEY, AND THE
--        DECISION AN OWNER TAKES ON A DRAFT.
--
-- ---------------------------------------------------------------------------
-- WHY A SESSION IS A ROW AND NOT A SIGNED COOKIE.
--
-- `INV-04` requires logout and expiry to invalidate the session ON THE SERVER.
-- A self-contained signed cookie cannot be invalidated: revocation of one is a
-- server-side list of the revoked, which is this table with the storage turned
-- inside out. So the session IS the row, the browser holds an opaque random
-- value, and what the browser holds is worth nothing without the row.
--
-- `token_hash` is the SHA-256 of that opaque value and there is no column here
-- that holds the value itself — the same discipline `0013` used for a redacted
-- source. A database file that leaks does not thereby leak live sessions.
--
-- `absolute_expires_at_ms` is a stored instant rather than a duration, and the
-- 60-minute cap of `INV-04` is a CHECK on this table. A deployment may configure
-- a SHORTER lifetime; it cannot configure a longer one, because the constraint
-- that refuses is in the schema rather than in the code that reads a setting.
--
-- `csrf_token` is the second value the session mints. It is delivered in a
-- RESPONSE BODY, is held in the page's memory, and is echoed in a request HEADER
-- on every mutation (`P2-FR-13`). It is not a cookie: a JS-readable cookie is
-- exactly the storage `P2-FR-14` has to be able to say is empty, and a token
-- that has to be readable by script has no business also being a cookie.
--
-- IT IS STORED IN THE CLEAR, AND `token_hash` BESIDE IT IS NOT. That difference
-- is the point rather than an inconsistency. The session token AUTHENTICATES —
-- holding it is being the owner — so the server keeps only what it needs to
-- recognise one. The CSRF token authenticates NOTHING: presenting it without the
-- cookie achieves nothing at all, and its whole job is to be a value a
-- cross-site page cannot obtain. A reload has to be able to get it back, which
-- means the server has to be able to read it, which means hashing it would buy
-- no secrecy and cost the property the token exists for.
--
-- ---------------------------------------------------------------------------
-- WHY REVOCATION IS ITS OWN TABLE.
--
-- Every table this contract has added is INSERT-only, and a session that could
-- be UPDATEd is a session whose history proves nothing. Logout is therefore an
-- INSERT into `owner_session_revocations`, which is also the audit record of the
-- logout. Validity is: the row exists, now is before its absolute expiry, and no
-- revocation names it. Three facts, none of them a mutation.
--
-- ---------------------------------------------------------------------------
-- WHY A TICKET EXISTS AT ALL.
--
-- The owner has to get a session somehow, and `INV-04` forbids the API key
-- reaching the browser. A login form that took the Registry API key would put a
-- service credential into a browser form, which is the thing the invariant is
-- about. So the exchange runs the other way: a machine-to-machine call the OWNER
-- makes from the CLI mints a one-time ticket (`POST /v1/console/tickets`, Bearer,
-- server side), and the browser trades that ticket — in a POST body, never in a
-- URL — for the session cookie.
--
-- A ticket is single-use because `console_ticket_uses.ticket_id` is UNIQUE: the
-- second use collides in the database rather than in a check somebody could
-- forget to write. Its lifetime is capped at five minutes by a CHECK, for the
-- same reason the session's is.
--
-- ---------------------------------------------------------------------------
-- `draft_decisions` — WHAT AN OWNER DECIDED, ABOUT WHICH EXACT REVISION.
--
-- `P2-FR-08` requires an approval to fix the exact revision, the digest, the
-- owner actor and the timestamp; they are four columns. `P2-FR-10` requires a
-- rejection to carry a reason and to preserve the revision and the audit; the
-- reason is a column whose CHECK refuses a rejection without one, and preservation
-- is the INSERT-only trigger the other tables already live under.
--
-- `UNIQUE(draft_id)` makes a lineage's decision TERMINAL and singular. That is
-- the narrow claim: a draft is decided once. A second approve — a double click, a
-- resent form, a retried fetch — collides here and is answered `CONFLICT` rather
-- than recorded twice (`P2-FR-13`). It is not a general state machine and does
-- not pretend to be one; P3 owns what happens to an approved draft afterwards.
--
-- The columns are the same shape `draft_events` uses, deliberately, because the
-- audit an owner reads is the UNION of the two and a union of two different
-- shapes is a shape a reader has to reconcile. `INV-05` asks for structured
-- fields, so the fields are the same fields.

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
CREATE INDEX idx_owner_sessions_agent ON owner_sessions(agent_id,created_at_ms);

CREATE TABLE owner_session_revocations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES owner_sessions(id) ON DELETE RESTRICT,
  reason_code TEXT NOT NULL CHECK(reason_code IN ('logout','superseded')),
  revoked_at_ms INTEGER NOT NULL CHECK(revoked_at_ms>0)
);

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

CREATE TABLE console_ticket_uses(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  ticket_id TEXT NOT NULL UNIQUE REFERENCES console_tickets(id) ON DELETE RESTRICT,
  session_id TEXT NOT NULL REFERENCES owner_sessions(id) ON DELETE RESTRICT,
  used_at_ms INTEGER NOT NULL CHECK(used_at_ms>0)
);

CREATE TABLE draft_decisions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL UNIQUE CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  decision TEXT NOT NULL CHECK(decision IN ('approved','rejected')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  CHECK(decision='approved' OR reason IS NOT NULL)
);
CREATE INDEX idx_draft_decisions_workspace ON draft_decisions(workspace_id,server_at_ms);

-- a session, its revocation, a ticket, its use and a decision are each written
-- once — the rule `captures`, `draft_revisions` and `draft_events` already live
-- under, and the rule that makes every one of these tables a journal in the
-- sense `src/journal.ts` reads out of the schema
CREATE TRIGGER tg_owner_sessions_no_upd BEFORE UPDATE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_owner_sessions_no_del BEFORE DELETE ON owner_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_owner_session_revocations_no_upd BEFORE UPDATE ON owner_session_revocations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_owner_session_revocations_no_del BEFORE DELETE ON owner_session_revocations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_tickets_no_upd BEFORE UPDATE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_tickets_no_del BEFORE DELETE ON console_tickets BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_ticket_uses_no_upd BEFORE UPDATE ON console_ticket_uses BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_console_ticket_uses_no_del BEFORE DELETE ON console_ticket_uses BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_decisions_no_upd BEFORE UPDATE ON draft_decisions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_decisions_no_del BEFORE DELETE ON draft_decisions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
