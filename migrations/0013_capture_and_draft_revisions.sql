-- 0013 — WHERE A CAPTURE BECOMES A DRAFT, AND WHY THAT IS THREE TABLES.
--
-- The V1 Skill Loop begins before a package exists: somebody finishes a piece
-- of work in a session and says "make this a skill". What arrives is TEXT — a
-- workflow somebody wrote down, the content of an agent session, or a native
-- skill file one of the two supported runtimes already reads. None of that is a
-- signed package, and none of it may be treated as one until a person has read
-- what the registry made of it. So the shapes here sit BESIDE `skills` and
-- `skill_versions` and never inside them: a draft is a proposal, a version is a
-- published artifact, and the whole point of the loop is the gap between them.
--
-- ---------------------------------------------------------------------------
-- `captures` — ONE ARRIVAL, ALREADY REDACTED.
--
-- `redacted_source` is the normalised input AFTER redaction, and there is no
-- column anywhere in this migration that holds the input before it. That is the
-- same discipline `0008` used for transcript text and `0010` for evidence: the
-- boundary reduces, and the schema has nowhere to put what the boundary
-- removed. A credential pasted into a workflow reaches `src/redaction.ts` and
-- what continues past it is `⟦REDACTED:…⟧` — the token `src/gates.ts` already
-- defines, so the secret scan that reads a package reads this the same way.
--
-- `source_digest` is the digest OF THE REDACTED SOURCE, for the same reason.
-- It is what makes a recompile provable: the same arrival digests the same, and
-- a draft that claims to descend from an arrival names the row it descends
-- from.
--
-- `outcome` is on the arrival because A REFUSAL IS AN OUTCOME. A capture that
-- was classified as a memory, a rule or a one-off produces no draft, and the
-- row that says so is the evidence that the registry answered rather than lost
-- it. `category` and `skillable` are the classifier's answer, stored as the
-- machine-readable values they are and never as a sentence to be parsed back.
--
-- ---------------------------------------------------------------------------
-- `draft_revisions` — THE IMMUTABLE LINEAGE.
--
-- `draft_id` is the LINEAGE and `id` is the REVISION. Editing a draft appends a
-- row whose `parent_revision_id` names the row it was edited from; nothing
-- rewrites the parent, and the triggers below are why that is a property of the
-- database rather than a promise about the code. `UNIQUE(draft_id, revision)`
-- makes the numbering of a lineage total: two rows cannot both be revision 2.
--
-- `content_digest` is over the CANONICAL content and the compiler version
-- together (`src/draft.ts`), so the same normalised input compiled by the same
-- compiler yields the same digest, and a compiler change is visible as a
-- different digest rather than as a silent difference in the same one.
--
-- `semantic_json` and `security_json` are the two structured previews. They are
-- stored WITH the revision they describe, because a preview recomputed later
-- against a newer compiler is a statement about a different object than the one
-- an owner read and approved.
--
-- ---------------------------------------------------------------------------
-- `draft_events` — THE AUDIT, IN COLUMNS.
--
-- Every field the audit needs is a COLUMN: what happened, who did it, what it
-- was about, which revision, which session it correlates with, when, why, with
-- what result. `provenance_json` carries the structured payload and is never
-- the place a reader has to go to find one of the fields above — a consumer
-- that had to parse a serialised string to learn the event type would be the
-- defect this shape exists to prevent.
--
-- `correlation_ref` is the session or invocation this event belongs to, as the
-- caller declared it and after redaction. It is nullable because a workflow
-- pasted by an owner correlates with no session, and an absent correlation is
-- not an empty one.
--
-- All three tables are INSERT-only. A draft whose history could be edited is a
-- draft whose history proves nothing, and the immutability of a revision is the
-- one property every later phase — assignment, loadout, invocation, outcome —
-- pins its own evidence to.

CREATE TABLE captures(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  captured_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('workflow','session','native_skill')),
  source_format TEXT NOT NULL CHECK(source_format IN ('workflow_text','agent_session','claude_code_skill','codex_skill')),
  source_ref TEXT CHECK(source_ref IS NULL OR length(source_ref) BETWEEN 1 AND 200),
  redacted_source TEXT NOT NULL CHECK(length(redacted_source) BETWEEN 1 AND 200000),
  source_digest TEXT NOT NULL CHECK(length(source_digest)=71),
  category TEXT NOT NULL CHECK(category IN ('reusable_procedure','memory','rule','automation','connector','loadout','one_off','ambiguous')),
  skillable INTEGER NOT NULL CHECK(skillable IN (0,1)),
  reason_code TEXT NOT NULL CHECK(length(reason_code) BETWEEN 1 AND 64),
  outcome TEXT NOT NULL CHECK(outcome IN ('drafted','refused')),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_captures_workspace ON captures(workspace_id,server_at_ms);

CREATE TABLE draft_revisions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT NOT NULL CHECK(length(draft_id)=26),
  revision INTEGER NOT NULL CHECK(revision>=1),
  parent_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  origin TEXT NOT NULL CHECK(origin IN ('capture','edit','recompile')),
  compiler_version TEXT NOT NULL CHECK(length(compiler_version) BETWEEN 1 AND 32),
  content_json TEXT NOT NULL CHECK(length(content_json) BETWEEN 2 AND 200000),
  content_digest TEXT NOT NULL CHECK(length(content_digest)=71),
  semantic_json TEXT NOT NULL CHECK(length(semantic_json) BETWEEN 2 AND 100000),
  security_json TEXT NOT NULL CHECK(length(security_json) BETWEEN 2 AND 100000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  UNIQUE(draft_id, revision)
);
CREATE INDEX idx_draft_revisions_draft ON draft_revisions(draft_id,revision);

CREATE TABLE draft_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  draft_id TEXT CHECK(draft_id IS NULL OR length(draft_id)=26),
  draft_revision_id TEXT REFERENCES draft_revisions(id) ON DELETE RESTRICT,
  capture_id TEXT NOT NULL REFERENCES captures(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('captured','classified','compiled','revised','refused')),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  actor_role TEXT NOT NULL CHECK(actor_role IN ('owner','admin','reviewer','member')),
  source TEXT NOT NULL CHECK(source IN ('registry','owner','agent')),
  correlation_ref TEXT CHECK(correlation_ref IS NULL OR length(correlation_ref) BETWEEN 1 AND 200),
  reason_code TEXT CHECK(reason_code IS NULL OR length(reason_code) BETWEEN 1 AND 64),
  result TEXT NOT NULL CHECK(result IN ('drafted','refused','recorded')),
  content_digest TEXT CHECK(content_digest IS NULL OR length(content_digest)=71),
  provenance_json TEXT NOT NULL CHECK(length(provenance_json) BETWEEN 2 AND 20000),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);
CREATE INDEX idx_draft_events_draft ON draft_events(draft_id,server_at_ms);

-- an arrival, a revision and an audit entry are written once — the rule
-- `transfers`, `receipt_events`, `assignment_events` and `observed_records`
-- already live under
CREATE TRIGGER tg_captures_no_upd BEFORE UPDATE ON captures BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_captures_no_del BEFORE DELETE ON captures BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_revisions_no_upd BEFORE UPDATE ON draft_revisions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_revisions_no_del BEFORE DELETE ON draft_revisions BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_events_no_upd BEFORE UPDATE ON draft_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_draft_events_no_del BEFORE DELETE ON draft_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
