-- 0016 — THE IMMUTABLE SESSION LOADOUT, AND THE RECEIPTS THAT ARE THE ONLY WAY
--        A STAGE PAST `proposed` IS EVER WRITTEN.
--
-- ---------------------------------------------------------------------------
-- `agent_sessions` — one runtime session of one agent.
--
-- A session is opened by the ADAPTER, never by an owner command, and the column
-- that records who opened it has no `owner` member for the same reason
-- `assignment_observations.source` has none (`INV-02`): a session is a fact
-- about a runtime, and the loadout it carries produces observed state
-- (`proposed`) the moment it is built (`P4-FR-09`). If an owner surface could
-- open a session, an owner command would produce observed state, which is the
-- one thing the whole desired/observed split exists to forbid.
--
-- `runtime_kind` has exactly the two members V1 supports. A third runtime is a
-- row here and a row in the adapter table in `src/runtime-adapter.ts`, which is
-- the shape contract section 8.10 asks for — two thin adapters, not a plugin
-- system.
--
-- ---------------------------------------------------------------------------
-- `session_loadouts` / `session_loadout_entries` — THE SNAPSHOT.
--
-- `P4-FR-02` names ten things the snapshot must carry, and every one of them is
-- a COLUMN rather than a member of a JSON blob: loadout id (`id`), session id,
-- agent id, runtime kind and version, adapter version, and per entry the
-- assignment id, the exact skill (`draft_id`) and revision (`draft_revision_id`,
-- `revision`) ids and the content digest. `created_at_ms` is the created
-- timestamp. `loadout_digest` is over the whole snapshot, so a reader can check
-- that what it holds is what was built without walking the rows.
--
-- `P4-FR-03` — after creation the snapshot does not change — is the pair of
-- INSERT-only triggers at the foot of this file, so immutability is a property
-- of the storage and not of the discipline of every future writer. There is no
-- UPDATE path to these tables in this process or any other.
--
-- `UNIQUE(session_id)` on the loadout: one session has exactly one loadout, and
-- a second `POST` that tried to rebuild one would fail in the database before it
-- failed in the service.
--
-- `UNIQUE(loadout_id, assignment_id)` and `UNIQUE(loadout_id, skill_name)`: an
-- assignment appears once, and two lineages cannot claim one native directory —
-- the second is a materialization-safety rule (`P4-FR-14`) enforced where the
-- name is decided rather than where the file is opened.
--
-- ---------------------------------------------------------------------------
-- `runtime_receipts` — the structured confirmation, `INV-05`.
--
-- `P4-FR-10`: `invoked` appears only on a receipt correlating SESSION, REVISION
-- and INVOCATION. All three are columns and none of them is nullable for an
-- `invoked` receipt — the CHECK below refuses a receipt that claims an
-- invocation without naming one, because a correlation you cannot name is a
-- correlation nobody checked.
--
-- `content_digest` is here as well as on the entry it points at, and the service
-- refuses a receipt whose digest is not the entry's. `P4-FR-19` is the reason:
-- a receipt that proves a skill NAME proves that some file with that name was
-- read, and a name is exactly what an attacker or an accident controls. The
-- digest is what makes the claim about an EXACT REVISION.
--
-- `source` again has no `owner` member (`P4-FR-13`): there is no value an owner
-- command could write into this table, on top of the fact that no owner-reachable
-- route reaches it.
--
-- WHY THE RECEIPT IS ITS OWN TABLE AND NOT A PROVENANCE BLOB ON THE
-- OBSERVATION. `assignment_observations` is the answer to "what is the state of
-- this assignment"; a receipt is the EVIDENCE that produced one of those
-- answers, it has its own identity and its own digest, and P5 has to be able to
-- read the receipts of a session without re-parsing observations. An observation
-- names its receipt in `provenance_json.receipt_id`; the receipt names nothing
-- about the observation, so the direction of the dependency matches the
-- direction of the proof.
PRAGMA defer_foreign_keys=ON;

CREATE TABLE agent_sessions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('codex','claude_code')),
  runtime_version TEXT NOT NULL CHECK(length(runtime_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 64),
  opened_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  opened_by_source TEXT NOT NULL CHECK(opened_by_source IN ('backend','adapter','runtime')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_agent_sessions_agent ON agent_sessions(agent_id,server_at_ms);

CREATE TABLE session_loadouts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL UNIQUE REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  runtime_kind TEXT NOT NULL CHECK(runtime_kind IN ('codex','claude_code')),
  runtime_version TEXT NOT NULL CHECK(length(runtime_version) BETWEEN 1 AND 64),
  adapter_version TEXT NOT NULL CHECK(length(adapter_version) BETWEEN 1 AND 64),
  entry_count INTEGER NOT NULL CHECK(entry_count>=0),
  loadout_digest TEXT NOT NULL CHECK(length(loadout_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_session_loadouts_agent ON session_loadouts(agent_id,created_at_ms);

CREATE TABLE session_loadout_entries(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  position INTEGER NOT NULL CHECK(position>=1),
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  revision INTEGER NOT NULL CHECK(revision>=1),
  skill_name TEXT NOT NULL CHECK(length(skill_name) BETWEEN 1 AND 64),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(loadout_id,assignment_id),
  UNIQUE(loadout_id,position),
  UNIQUE(loadout_id,skill_name)
);
CREATE INDEX idx_session_loadout_entries_loadout ON session_loadout_entries(loadout_id,position);

CREATE TABLE runtime_receipts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  session_id TEXT NOT NULL REFERENCES agent_sessions(id) ON DELETE RESTRICT,
  loadout_id TEXT NOT NULL REFERENCES session_loadouts(id) ON DELETE RESTRICT,
  loadout_entry_id TEXT NOT NULL REFERENCES session_loadout_entries(id) ON DELETE RESTRICT,
  assignment_id TEXT NOT NULL REFERENCES skill_assignments(id) ON DELETE RESTRICT,
  draft_revision_id TEXT NOT NULL REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  stage TEXT NOT NULL CHECK(stage IN ('loaded','invoked')),
  runtime_session_ref TEXT NOT NULL CHECK(length(runtime_session_ref) BETWEEN 1 AND 200),
  invocation_ref TEXT CHECK(invocation_ref IS NULL OR length(invocation_ref) BETWEEN 1 AND 200),
  reported_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source TEXT NOT NULL CHECK(source IN ('backend','adapter','runtime')),
  receipt_digest TEXT NOT NULL CHECK(length(receipt_digest)=71),
  payload_json TEXT NOT NULL CHECK(length(payload_json) BETWEEN 2 AND 20000),
  observed_at_ms INTEGER NOT NULL CHECK(observed_at_ms>0),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  CHECK(stage<>'invoked' OR invocation_ref IS NOT NULL)
);
CREATE INDEX idx_runtime_receipts_session ON runtime_receipts(session_id,observed_at_ms);
CREATE INDEX idx_runtime_receipts_entry ON runtime_receipts(loadout_entry_id,stage);

-- `P4-FR-03`: a snapshot that cannot be updated is a snapshot nobody has to be
-- trusted not to update. The receipts are under the same rule for the reason
-- every journal in this tree is.
CREATE TRIGGER tg_agent_sessions_no_upd BEFORE UPDATE ON agent_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_agent_sessions_no_del BEFORE DELETE ON agent_sessions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_loadouts_no_upd BEFORE UPDATE ON session_loadouts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_loadouts_no_del BEFORE DELETE ON session_loadouts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_loadout_entries_no_upd BEFORE UPDATE ON session_loadout_entries BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_session_loadout_entries_no_del BEFORE DELETE ON session_loadout_entries BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_runtime_receipts_no_upd BEFORE UPDATE ON runtime_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_runtime_receipts_no_del BEFORE DELETE ON runtime_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
