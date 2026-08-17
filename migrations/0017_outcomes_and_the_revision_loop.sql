-- 0017 — THE NORMALISED OUTCOME, AND THE LOOP THAT COMES BACK FROM IT.
--
-- `0016` ended at `invoked`: a runtime read an exact revision and called it.
-- Whether calling it HELPED is a different fact with a different source, and
-- this migration is where that fact lives. Five INSERT-only tables are added and
-- nothing existing is edited.
--
-- ---------------------------------------------------------------------------
-- `session_closures` — A SESSION THAT ENDED.
--
-- `P5-FR-04`: a session that finishes with no outcome receipt yields
-- `nothing_reported`, never a success. Something has to say a session FINISHED,
-- and `agent_sessions` is INSERT-only, so the closure is its own row rather than
-- a column somebody would have to update. Closing is an ADAPTER act for the
-- reason opening one is (`INV-02`): it produces observed facts, so `source` has
-- no `owner` member here either.
--
-- ---------------------------------------------------------------------------
-- `session_outcomes` — THE FOUR VALUES, AND WHAT EACH ONE IS ALLOWED TO REST ON.
--
-- `P5-FR-01` fixes the vocabulary at exactly four members and the CHECK is that
-- list. The interesting rules are the other three CHECKs, because each one makes
-- a requirement unfalsifiable BY THE DATABASE rather than by the discipline of
-- every future writer:
--
--   `P5-FR-02`  `worked` is refused unless it either names the `invoked` receipt
--               it rests on, or is an explicit owner confirmation carrying the
--               source the owner saw it in. There is no third way to write it,
--               and no way at all to reach it from `proposed` or `loaded`: those
--               are stages of `0016` and are not outcomes.
--   `P5-FR-03`  every row carries `reason_code` and `reason`, and `failed`
--               carries provenance in `payload_json` beside them.
--   `P5-FR-04`  `nothing_reported` is writable ONLY by the closure path, and the
--               closure path can write nothing else.
--   `P5-FR-05`  `rolled_back` must name the rollback action it records and the
--               revision that action selected. It is a NEW ROW: the outcome it
--               follows is not touched, which is what "without rewriting the
--               outcome that came before it" means in storage.
--
-- `source` gains an `owner` member that no other observed table has, and it is
-- fenced: `source='owner'` implies `evidence_class='owner_confirmation'` and the
-- converse, so an owner credential cannot file a row that reads as runtime
-- evidence, and a runtime cannot file one that reads as an owner's word.
-- `assignment_observations` is NOT written from here — the observed STAGE of an
-- entry stays exactly what `0016`'s receipts made it, and an owner confirmation
-- never becomes a stage.
--
-- `UNIQUE(loadout_entry_id, outcome_ref)` is `P5-FR-06`: the reporter's own
-- identifier for the outcome is the replay key, so redelivering one receipt hits
-- the same row instead of writing a second.
--
-- ---------------------------------------------------------------------------
-- `outcome_conflicts` — A SECOND, DIFFERENT CLAIM UNDER ONE KEY.
--
-- `P5-FR-07`: a conflicting receipt does not overwrite its predecessor. The
-- predecessor stands in `session_outcomes`, the contradiction is recorded here
-- with the whole of what was claimed, and the outcome view reports it. A
-- conflict is therefore a structured state carrying its own evidence rather than
-- a lost write or a silently-preferred one.
--
-- ---------------------------------------------------------------------------
-- `revision_sources` — WHERE A NEW REVISION CAME FROM, AND WHAT IT PROMISED.
--
-- `P5-FR-08`: a revision created from a failure or a piece of feedback carries
-- its parent revision and the receipt it came from. Both are columns and both
-- are foreign keys, so a lineage claim that names nothing is not writable.
--
-- `improvement_goal` is stored HERE, at creation, because `P5-FR-12` requires a
-- binary goal stated IN ADVANCE. A goal a comparison could supply afterwards is
-- a goal chosen once the answer is known.
--
-- ---------------------------------------------------------------------------
-- `revision_comparisons` — THE OLD ONE, THE NEW ONE, AND WHETHER IT HELPED.
--
-- `P5-FR-11` names the four things a comparison must show and they are four
-- columns: the exact old and new revisions and the two outcomes behind them.
-- `comparable` and `verdict` are computed by the service from those rows and
-- stored, never supplied by a caller.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE session_closures(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  closed_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  entries_without_outcome INTEGER NOT NULL CHECK(entries_without_outcome>=0),
  closed_at_ms INTEGER NOT NULL CHECK(closed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);

CREATE TABLE session_outcomes(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  outcome TEXT NOT NULL CHECK(outcome IN ('worked','failed','rolled_back','nothing_reported')),
  evidence_class TEXT NOT NULL CHECK(evidence_class IN ('runtime_receipt','owner_confirmation','session_closed','rollback_confirmation')),
  outcome_ref TEXT NOT NULL CHECK(length(outcome_ref) BETWEEN 1 AND 200),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  reason TEXT NOT NULL CHECK(length(reason) BETWEEN 1 AND 2000),
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime','owner')),
  confirmation_source TEXT CHECK(confirmation_source IS NULL OR length(confirmation_source) BETWEEN 1 AND 200),
  runtime_session_ref TEXT CHECK(runtime_session_ref IS NULL OR length(runtime_session_ref) BETWEEN 1 AND 200),
  invocation_ref TEXT CHECK(invocation_ref IS NULL OR length(invocation_ref) BETWEEN 1 AND 200),
  invocation_receipt_id TEXT REFERENCES runtime_receipts(id) ON DELETE RESTRICT,
  rollback_to_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  rollback_action_event_id TEXT REFERENCES skill_assignment_events(id) ON DELETE RESTRICT,
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  outcome_digest TEXT NOT NULL CHECK(length(outcome_digest)=71),
  payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 20000),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(loadout_entry_id,outcome_ref),
  CHECK(outcome<>'worked' OR (evidence_class='runtime_receipt' AND invocation_receipt_id IS NOT NULL) OR evidence_class='owner_confirmation'),
  CHECK(outcome<>'rolled_back' OR (rollback_to_revision_id IS NOT NULL AND rollback_action_event_id IS NOT NULL)),
  CHECK((outcome='nothing_reported')=(evidence_class='session_closed')),
  CHECK((source='owner')=(evidence_class='owner_confirmation')),
  CHECK(evidence_class<>'owner_confirmation' OR confirmation_source IS NOT NULL)
);
CREATE INDEX idx_session_outcomes_session ON session_outcomes(session_id,observed_at_ms);
CREATE INDEX idx_session_outcomes_entry ON session_outcomes(loadout_entry_id,observed_at_ms);
CREATE INDEX idx_session_outcomes_revision ON session_outcomes(draft_revision_id,observed_at_ms);

CREATE TABLE outcome_conflicts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  outcome_ref TEXT NOT NULL CHECK(length(outcome_ref) BETWEEN 1 AND 200),
  existing_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  existing_outcome TEXT NOT NULL CHECK(existing_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  claimed_outcome TEXT NOT NULL CHECK(claimed_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  claimed_payload_json TEXT NOT NULL CHECK(length(claimed_payload_json) BETWEEN 2 AND 20000),
  conflict_digest TEXT NOT NULL CHECK(length(conflict_digest)=71),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime','owner')),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_outcome_conflicts_entry ON outcome_conflicts(loadout_entry_id,server_at_ms);

CREATE TABLE revision_sources(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL UNIQUE REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  parent_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('failure','feedback')),
  source_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  source_session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  source_receipt_id TEXT REFERENCES runtime_receipts(id) ON DELETE RESTRICT,
  observation TEXT NOT NULL CHECK(length(observation) BETWEEN 1 AND 2000),
  improvement_goal TEXT NOT NULL CHECK(length(improvement_goal) BETWEEN 1 AND 2000),
  goal_kind TEXT NOT NULL CHECK(goal_kind IN ('failure_to_worked','declared_binary')),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_revision_sources_draft ON revision_sources(draft_id,created_at_ms);

CREATE TABLE revision_comparisons(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  revision_source_id TEXT NOT NULL REFERENCES revision_sources(id) ON DELETE RESTRICT,
  baseline_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  candidate_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  baseline_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  candidate_outcome_id TEXT NOT NULL REFERENCES session_outcomes(id) ON DELETE RESTRICT,
  baseline_outcome TEXT NOT NULL CHECK(baseline_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  candidate_outcome TEXT NOT NULL CHECK(candidate_outcome IN ('worked','failed','rolled_back','nothing_reported')),
  comparable INTEGER NOT NULL CHECK(comparable IN (0,1)),
  scenario_json TEXT NOT NULL CHECK(length(scenario_json) BETWEEN 2 AND 8000),
  improvement_goal TEXT NOT NULL CHECK(length(improvement_goal) BETWEEN 1 AND 2000),
  goal_kind TEXT NOT NULL CHECK(goal_kind IN ('failure_to_worked','declared_binary')),
  verdict TEXT NOT NULL CHECK(verdict IN ('improved','not_improved','not_comparable')),
  verdict_reason_code TEXT NOT NULL CHECK(length(verdict_reason_code) BETWEEN 1 AND 64),
  verdict_reason TEXT NOT NULL CHECK(length(verdict_reason) BETWEEN 1 AND 2000),
  created_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_revision_comparisons_draft ON revision_comparisons(draft_id,created_at_ms);

-- `INV-06` in storage: an outcome, a conflict, a lineage row and a comparison
-- are all statements about a moment, and a statement about a moment that can be
-- edited later is not evidence. Every table of this migration is INSERT-only,
-- for the reason every journal in this tree is.
CREATE TRIGGER tg_session_closures_no_upd BEFORE UPDATE ON session_closures BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_closures_no_del BEFORE DELETE ON session_closures BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_outcomes_no_upd BEFORE UPDATE ON session_outcomes BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_outcomes_no_del BEFORE DELETE ON session_outcomes BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_outcome_conflicts_no_upd BEFORE UPDATE ON outcome_conflicts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_outcome_conflicts_no_del BEFORE DELETE ON outcome_conflicts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revision_sources_no_upd BEFORE UPDATE ON revision_sources BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revision_sources_no_del BEFORE DELETE ON revision_sources BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revision_comparisons_no_upd BEFORE UPDATE ON revision_comparisons BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revision_comparisons_no_del BEFORE DELETE ON revision_comparisons BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
