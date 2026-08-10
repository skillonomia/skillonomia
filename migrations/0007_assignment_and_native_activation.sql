-- SKILLONOMIA — an assignment is what the owner DECIDED, and the journal is
-- the only place that decision lives.
--
-- WHAT WAS MISSING. §5.4 gave a movement a sender and a typed recipient, and
-- stopped there: the recipient held a request it could take up or ignore, and
-- nothing in the model said what the owner had decided should HAPPEN to that
-- version at that agent. Adoption was still a pull. An owner who hands a skill
-- to an agent is doing something else — a push — and a push has a lifetime:
-- it is made, it waits, it is put into place, it can drift, it can be
-- suspended, it can be taken back.
--
-- ---------------------------------------------------------------------------
-- `assignments` — one push, recorded once.
--
-- One row is one decision: this VERSION of this SKILL is to be deployed at this
-- AGENT, under the §5.4 transfer that carried it and the §6.2 grant that
-- authorized it. The row is INSERT-only, and it holds NO STATE COLUMN. That
-- absence is the design. A deployment state written on a mutable row is a
-- reading of whoever wrote last, and this repository has already paid for one
-- of those: a count taken from `adoption_requests.requester_context_json` moved
-- because an ordinary call rewrote a closed adoption's descriptor. So the state
-- of an assignment is not stored anywhere. It is the last event of its journal.
--
-- `assigned_by_type` and `assigned_by_role` are SNAPSHOTS, for the reason D.1f
-- gives about `granted_by_*`: memberships are mutable, this row is not, and
-- "assigned by an agent holding an administrative role" and "assigned by the
-- human owner in person" are different facts a reader must be able to tell
-- apart from the record.
--
-- ---------------------------------------------------------------------------
-- `assignment_events` — the INSERT-only journal, and the whole state machine.
--
-- The event names ARE the deployment states:
--
--     assigned → queued → activating → active → drifted | failed
--                                            → paused | revoked
--
-- Every one of them is SKILLONOMIA'S INTENT. `active` means "this registry
-- believes it activated this version"; it is NOT a report about the runtime,
-- and nothing in this schema may be read as one. What is observed at a runtime
-- is established only by the §5 arrival marker on a paired call/output record,
-- which lives in transcripts this database does not hold and cannot invent. The
-- two are separate columns everywhere they are shown, and neither is computed
-- from the other.
--
-- `native_relpath` is RELATIVE TO THE ACTIVATION ROOT, and the CHECK enforces
-- it: no leading `/`, no `..`, at most 400 characters. The root itself is
-- CONFIGURATION and is never stored — a journal that recorded an operator's
-- absolute paths would be a list of the places this registry has written, and a
-- database is the wrong place for that. What a reader needs is which native
-- LOCATION a version was projected into, and that is a relative path.
--
-- `managed_copy` is four-valued and none of the four is blank: `written` (a copy
-- was placed), `removed` (a copy was taken away), `absent` (there was none to
-- take away), `retained` (a copy exists and this step did NOT remove it, which
-- is the honest answer when the runtime, or the configuration, does not let the
-- registry reach it). A fifth answer — that removing a copy makes an agent
-- forget instructions it has already read — is not in the vocabulary because it
-- is not true.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE assignments(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  recipient_kind TEXT NOT NULL CHECK(recipient_kind IN ('local_agent','remote_fleet')),
  transfer_id TEXT NOT NULL UNIQUE REFERENCES transfers(id) ON DELETE RESTRICT,
  assigned_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  assigned_by_type TEXT NOT NULL CHECK(assigned_by_type IN ('human','agent','service')),
  assigned_by_role TEXT NOT NULL CHECK(assigned_by_role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_assignments_agent ON assignments(agent_id,skill_id);

CREATE TABLE assignment_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  assignment_id TEXT NOT NULL REFERENCES assignments(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('assigned','queued','activating','active','drifted','failed','paused','revoked')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  reason TEXT CHECK(reason IS NULL OR length(reason) BETWEEN 1 AND 200),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_type TEXT NOT NULL CHECK(actor_type IN ('human','agent','service')),
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer','member')),
  grant_id TEXT REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  grant_action TEXT CHECK(grant_action IS NULL OR grant_action IN ('receive','assign','activate','revoke','report_outcome')),
  activation_target TEXT CHECK(activation_target IS NULL OR activation_target IN ('claude_code_personal','claude_code_project','claude_code_plugin','codex')),
  native_relpath TEXT CHECK(native_relpath IS NULL OR (length(native_relpath) BETWEEN 1 AND 400 AND substr(native_relpath,1,1)<>'/' AND instr(native_relpath,'..')=0)),
  managed_copy TEXT CHECK(managed_copy IS NULL OR managed_copy IN ('written','removed','absent','retained')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  UNIQUE(assignment_id,event_seq),
  UNIQUE(assignment_id,idempotency_key)
);

-- a decision, once recorded, is not edited or withdrawn — the rule `transfers`
-- and `receipt_events` live under, for the reason this file gives above
CREATE TRIGGER tg_assignments_no_upd BEFORE UPDATE ON assignments BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_assignments_no_del BEFORE DELETE ON assignments BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_aevents_no_upd BEFORE UPDATE ON assignment_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_aevents_no_del BEFORE DELETE ON assignment_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
