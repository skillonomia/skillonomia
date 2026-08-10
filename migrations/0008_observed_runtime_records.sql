-- SKILLONOMIA — an OBSERVATION is what somebody reported seeing, and it is not
-- the same kind of thing as a decision this registry made.
--
-- WHAT WAS MISSING. D.1g gave a deployment a journal of INTENT: assigned,
-- queued, activating, active. Every one of those is Skillonomia's own belief.
-- Nothing in the schema could hold the other column — what was OBSERVED at a
-- runtime — so `observed_arrival` was computed over an empty set and was
-- `unknown` for every deployment, forever. These two tables are where the
-- records that could change that live.
--
-- ---------------------------------------------------------------------------
-- `runtime_observations` — one report, with the boundary it was taken over.
--
-- One row is one act of looking: this AGENT, on this RUNTIME, over THIS
-- SELECTION WINDOW. The window is a column and not a note, because [I-3] is the
-- rule this whole work exists under — a number without its method is what made
-- 385 and 386 both true, and 33 and 79 both true, in one canonical note.
--
-- THREE COLUMNS ARE NULLABLE AND EACH NULL MEANS `unknown`, NEVER A DEFAULT:
-- `model` is not "no model", `session_active` is not "not running", and
-- `last_activity_ms` is not "never active". A reporter that did not look does
-- not thereby establish an absence [I-1].
--
-- `reported_by_type` and `reported_by_role` are SNAPSHOTS, for the reason D.1f
-- gives about `granted_by_*`: memberships are mutable and this row is not, and a
-- report filed by an agent holding an administrative role is a different fact
-- from one filed by the human owner in person [I-5].
--
-- ---------------------------------------------------------------------------
-- `observed_records` — the records, REDUCED TO MARKERS.
--
-- THE TEXT OF A RECORD IS NOT STORED, AND THERE IS NO COLUMN THAT COULD HOLD
-- IT. A transcript line is arbitrary content — a key, a customer's name, an
-- operator's home directory — and none of it is needed to answer the only
-- question §6 asks of a record: which skill VERSION does its marker name. So
-- the reduction happens at the boundary and what reaches this table is a
-- marker, a role, the id that binds a call to its output, and a time. That is
-- [I-7] enforced by the absence of a place to put the violation.
--
-- `call_id` IS NULLABLE AND A NULL ONE CAN NEVER FORM A PAIR. [M-5] counts a
-- version as invoked only on a PAIRED call/output record bound by one id; a
-- record whose runtime gave no id is kept, because it is evidence of something,
-- and it can never on its own produce a `yes`.
--
-- `result` is three-valued with no blank member, and `unknown` is the default in
-- the strong sense: a task that ended is a task that ended. `success` is written
-- only where an evaluation contract said what success was [M-6].
--
-- Both tables are INSERT-only. An observation that could be edited afterwards
-- would be a record of what somebody currently believes rather than of what was
-- reported, and the whole point of the second column is that it is not editable
-- by the party that holds the first.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE runtime_observations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('claude_code','codex')),
  model TEXT CHECK(model IS NULL OR length(model) BETWEEN 1 AND 200),
  session_active INTEGER CHECK(session_active IS NULL OR session_active IN (0,1)),
  last_activity_ms INTEGER CHECK(last_activity_ms IS NULL OR last_activity_ms>0),
  selection_window TEXT NOT NULL CHECK(selection_window IN ('live_session','period','all_time')),
  window_detail TEXT NOT NULL CHECK(length(window_detail) BETWEEN 1 AND 500),
  proposal_inventory_complete INTEGER NOT NULL CHECK(proposal_inventory_complete IN (0,1)),
  records_read INTEGER NOT NULL CHECK(records_read>=0),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  reported_by_type TEXT NOT NULL CHECK(reported_by_type IN ('human','agent','service')),
  reported_by_role TEXT NOT NULL CHECK(reported_by_role IN ('owner','admin','reviewer','member')),
  grant_id TEXT REFERENCES transfer_grants(id) ON DELETE RESTRICT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL
);
CREATE INDEX idx_runtime_observations_agent ON runtime_observations(agent_id,server_at_ms);

CREATE TABLE observed_records(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  observation_id TEXT NOT NULL REFERENCES runtime_observations(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime TEXT NOT NULL CHECK(runtime IN ('claude_code','codex')),
  role TEXT NOT NULL CHECK(role IN ('proposal','call','output')),
  call_id TEXT CHECK(call_id IS NULL OR length(call_id) BETWEEN 1 AND 200),
  at_ms INTEGER CHECK(at_ms IS NULL OR at_ms>0),
  marker TEXT NOT NULL CHECK(marker GLOB 'SKLN1-[0-9A-HJKMNP-TV-Z]*' AND length(marker)=22),
  result TEXT NOT NULL CHECK(result IN ('success','failure','unknown')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_observed_records_agent ON observed_records(agent_id,marker);

-- a report, once filed, is not edited or withdrawn — the rule `transfers`,
-- `receipt_events` and `assignment_events` live under
CREATE TRIGGER tg_runtime_obs_no_upd BEFORE UPDATE ON runtime_observations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_runtime_obs_no_del BEFORE DELETE ON runtime_observations BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_obs_records_no_upd BEFORE UPDATE ON observed_records BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_obs_records_no_del BEFORE DELETE ON observed_records BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
