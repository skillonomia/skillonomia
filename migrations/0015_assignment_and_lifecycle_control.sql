-- 0015 — ASSIGNMENT AND LIFECYCLE CONTROL: WHAT THE OWNER WANTS, WHAT WAS SEEN,
--        AND THE TWO ARE NEVER THE SAME COLUMN.
--
-- ---------------------------------------------------------------------------
-- WHY THE APPROVAL OF A REVISION IS ITS OWN TABLE.
--
-- `0014` gave a LINEAGE one decision — `draft_decisions.draft_id` is UNIQUE —
-- and that is a true and useful fact: the first thing an owner decided about a
-- capture. It is not the fact `P3-FR-05` and `INV-06` need. A rollback selects
-- a PREVIOUSLY APPROVED REVISION, which presupposes that a lineage can carry
-- more than one, and a lineage that can carry exactly one has nothing to roll
-- back to.
--
-- So approval becomes a fact about a REVISION, recorded here, one row per
-- revision (`UNIQUE(draft_revision_id)`). `draft_decisions` is not altered, not
-- rebuilt and not deprecated — the contract requires every schema change to be
-- additive, and rebuilding a populated table to widen a UNIQUE is neither
-- additive nor reversible. The first approval of a lineage writes BOTH rows,
-- so `0014`'s table keeps meaning exactly what it meant; every later approval
-- writes only this one. `src/draft-decision.ts` reads the union and is the only
-- place that knows there are two tables (`INV-01`).
--
-- ---------------------------------------------------------------------------
-- `skill_assignments` — one owner decision to put a capability at an agent.
--
-- The row holds NO STATE COLUMN, for the reason `0007` states about its own
-- assignments: a state written on a mutable row is a reading of whoever wrote
-- last. The state of an assignment is the last event of its journal.
--
-- It holds no revision either. WHICH revision is desired is a decision that
-- CHANGES — that is what revision selection and rollback are — so it lives on
-- the event, and the current desired revision is the one the head event names.
--
-- `entity_version` is not a column here for the same reason. The optimistic
-- concurrency token of an assignment is its `event_seq`: a monotone integer the
-- journal already produces, which no writer can move backwards and which two
-- concurrent owners cannot both extend. `If-Match`-style preconditions compare
-- against it (`P3-FR-11`).
--
-- ---------------------------------------------------------------------------
-- `skill_assignment_events` — the DESIRED state machine, INSERT-only.
--
-- The event names ARE the desired states:
--
--     assigned → active ⇄ paused → revoked           (revoked is terminal)
--        └────────────── revision_selected ──────────────┘
--
-- Every one of them is the OWNER'S INTENT and nothing else. Not one of these
-- names may be read as a report about a runtime: `active` means "the owner
-- wants this revision loaded from the next session onward", never "it is
-- loaded". What was actually seen lives in `assignment_observations` below, in
-- different columns, written by a different code path, from evidence
-- (`INV-02`).
--
-- `revision_selected` is an event and not a state: it changes the desired
-- revision and leaves the lifecycle state where it was. `effective_from` is on
-- every row and its only value is `next_session` — `INV-07` says an owner
-- command applies to the NEXT session and never rewrites the loadout of a
-- running one, and a column whose vocabulary has one member is how that is said
-- in the schema rather than in a comment.
--
-- `event_seq` is dense from 1 and UNIQUE per assignment, so it is both the
-- ordering and the version token.
--
-- ---------------------------------------------------------------------------
-- `assignment_observations` — what somebody REPORTED SEEING.
--
-- `INV-02`: this table is written only from structured backend, adapter or
-- runtime evidence, and `source` has no `owner` member — an owner command
-- cannot produce a row here, because there is no value it could put in that
-- column. `INV-03`: an `unknown` observation carries `reason_code`, `reason`,
-- `source` and `observed_at_ms`, and the CHECK below refuses one that does not.
--
-- The absence of a row is itself an answer, and it is `unknown` with the reason
-- code `NO_OBSERVATION` — computed on the way out by `src/assignment-lifecycle.ts`
-- rather than stored, because a stored "nothing has been seen" would have to be
-- written by somebody and the only honest writer of it is the reader.
--
-- ---------------------------------------------------------------------------
-- `idempotency_keys.request_digest` — the one ALTER, and why.
--
-- `P3-FR-09` and `P3-FR-10` split what the released column could not: the same
-- key with the same payload replays, the same key with a DIFFERENT payload is a
-- `409`. Telling those apart needs the payload, and the released table stores
-- only the key and the response. The column is nullable, so every row a
-- released build wrote keeps its meaning — NULL is "recorded before payloads
-- were fingerprinted", never "the payload was empty" — and only a row that
-- carries a digest can produce a conflict. `ALTER TABLE ... ADD COLUMN` is the
-- shape `0002`, `0003`, `0004`, `0005` and `0010` of this tree already use.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE revision_approvals(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL UNIQUE REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_revision_approvals_draft ON revision_approvals(draft_id,revision);

CREATE TABLE skill_assignments(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_by_role TEXT NOT NULL CHECK(created_by_role IN ('owner','admin')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_skill_assignments_agent ON skill_assignments(agent_id,draft_id);
CREATE INDEX idx_skill_assignments_workspace ON skill_assignments(workspace_id,server_at_ms);

CREATE TABLE skill_assignment_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  event TEXT NOT NULL CHECK(event IN ('assigned','activated','paused','revoked','revision_selected')),
  desired_state TEXT NOT NULL CHECK(desired_state IN ('assigned','active','paused','revoked')),
  desired_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  effective_from TEXT NOT NULL CHECK(effective_from IN ('next_session')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin')),
  source TEXT NOT NULL CHECK(source IN ('owner')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 2000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(assignment_id,event_seq)
);
CREATE INDEX idx_skill_assignment_events_assignment ON skill_assignment_events(assignment_id,event_seq);

CREATE TABLE assignment_observations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  observed_status TEXT NOT NULL CHECK(observed_status IN ('proposed','loaded','invoked','unknown')),
  draft_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  session_ref TEXT CHECK(session_ref IS NULL OR length(session_ref) BETWEEN 1 AND 200),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_assignment_observations_assignment ON assignment_observations(assignment_id,observed_at_ms);

-- `P3-FR-10`: the fingerprint of the payload a key was first used with.
ALTER TABLE idempotency_keys ADD COLUMN request_digest TEXT;

-- an approval, an assignment, a lifecycle event and an observation are each
-- written once — the rule `captures`, `draft_revisions`, `draft_events`,
-- `assignment_events` and `draft_decisions` already live under
CREATE TRIGGER tg_revision_approvals_no_upd BEFORE UPDATE ON revision_approvals BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revision_approvals_no_del BEFORE DELETE ON revision_approvals BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_skill_assignments_no_upd BEFORE UPDATE ON skill_assignments BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_skill_assignments_no_del BEFORE DELETE ON skill_assignments BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_skill_assignment_events_no_upd BEFORE UPDATE ON skill_assignment_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_skill_assignment_events_no_del BEFORE DELETE ON skill_assignment_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_assignment_observations_no_upd BEFORE UPDATE ON assignment_observations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_assignment_observations_no_del BEFORE DELETE ON assignment_observations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
