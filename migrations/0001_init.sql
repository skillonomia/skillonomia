-- SKILLONOMIA V1 — NORMATIVE SQLite DDL
-- 20 tables. Triggers: 6 INSERT-only + 3 tenancy + 1 approval-consistency.
PRAGMA foreign_keys=ON;

CREATE TABLE workspaces(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

CREATE TABLE agents(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 120),
  type TEXT NOT NULL CHECK(type IN ('human','agent','service')),
  tool_profile TEXT,
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled','merged')),
  merged_into_agent_id TEXT REFERENCES agents(id) ON DELETE RESTRICT,
  passport_ref TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,name)
);

CREATE TABLE workspace_memberships(
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('owner','admin','reviewer','member')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  PRIMARY KEY(agent_id,workspace_id)
);

CREATE TABLE api_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  key_hash TEXT NOT NULL CHECK(length(key_hash)=64),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
);
CREATE INDEX idx_api_keys_agent ON api_keys(agent_id);

CREATE TABLE signing_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kid TEXT NOT NULL UNIQUE CHECK(kid NOT GLOB '*[^a-z0-9-]*' AND length(kid) BETWEEN 1 AND 64),
  public_key_ed25519 TEXT NOT NULL CHECK(length(public_key_ed25519)=43),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  revoked_at_ms INTEGER
);

CREATE TABLE skills(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  slug TEXT NOT NULL CHECK(slug NOT GLOB '*[^a-z0-9-]*' AND length(slug) BETWEEN 3 AND 64),
  owner_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  access_policy TEXT NOT NULL DEFAULT 'private' CHECK(access_policy IN ('private','invite','workspace','public')),
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(workspace_id,slug)
);

CREATE TABLE skill_access_grants(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE CASCADE,
  grantee_workspace_id TEXT REFERENCES workspaces(id) ON DELETE CASCADE,
  grantee_agent_id TEXT REFERENCES agents(id) ON DELETE CASCADE,
  granted_by_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  CHECK((grantee_workspace_id IS NULL) <> (grantee_agent_id IS NULL))
);
CREATE INDEX idx_grants_skill ON skill_access_grants(skill_id);

CREATE TABLE skill_versions(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_id TEXT NOT NULL REFERENCES skills(id) ON DELETE RESTRICT,
  semantic_version TEXT NOT NULL CHECK(length(semantic_version) BETWEEN 5 AND 32),
  author_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  manifest_json TEXT NOT NULL,
  manifest_hash TEXT NOT NULL CHECK(length(manifest_hash)=64),
  content_hash TEXT NOT NULL CHECK(length(content_hash)=64),
  package_blob_ref TEXT NOT NULL,
  signature_jws TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'draft' CHECK(state IN ('draft','linted','reviewed','verified','published','deprecated','superseded','revoked')),
  supersedes_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  superseded_by_version_id TEXT REFERENCES skill_versions(id) ON DELETE RESTRICT,
  revocation_reason TEXT,
  deprecation_at_ms INTEGER,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(skill_id,semantic_version)
);
CREATE INDEX idx_versions_skill_state ON skill_versions(skill_id,state);

CREATE TABLE lint_reports(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE CASCADE,
  gate TEXT NOT NULL CHECK(gate IN ('schema','secrets','pinning','urls','shell','injection','staleness','compat')),
  result TEXT NOT NULL CHECK(result IN ('pass','fail','warn')),
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_lint_version ON lint_reports(skill_version_id);

CREATE TABLE reviews(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  reviewer_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  verdict TEXT NOT NULL CHECK(verdict IN ('approve','reject','conditional')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_reviews_version ON reviews(skill_version_id);

CREATE TABLE attestations(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  attester_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(length(kind) BETWEEN 1 AND 40),
  payload_json TEXT,
  signature_jws TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_attest_version ON attestations(skill_version_id);

CREATE TABLE adoption_requests(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requester_context_json TEXT,
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','pushed','dead_letter')),
  dead_letter_reason TEXT CHECK(dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts','stale_lease','endpoint_dead')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_req_due ON adoption_requests(state,next_attempt_at_ms);

CREATE TABLE adoption_receipts(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_request_id TEXT NOT NULL UNIQUE REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

CREATE TABLE receipt_events(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  evidence_json TEXT,
  failure_report_json TEXT,
  rollback_report_json TEXT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  UNIQUE(adoption_receipt_id,idempotency_key),
  UNIQUE(adoption_receipt_id,event_seq),
  UNIQUE(adoption_receipt_id,event)
);
CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');

CREATE TABLE approvals(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adoption_request_id TEXT REFERENCES adoption_requests(id) ON DELETE RESTRICT,
  approver_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  scope TEXT NOT NULL CHECK(scope IN ('publish','adopt_high_risk')),
  decision TEXT NOT NULL CHECK(decision IN ('approved','denied')),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  -- per-adoption approval MUST bind the exact adoption_request; publish approval binds the version only
  CHECK((scope='adopt_high_risk' AND adoption_request_id IS NOT NULL)
     OR (scope='publish' AND adoption_request_id IS NULL)),
  UNIQUE(adoption_request_id,scope)
);

CREATE TABLE ratings(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  rater_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
  note TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(skill_version_id,rater_agent_id)
);

CREATE TABLE transparency_log(
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_kind TEXT NOT NULL CHECK(length(event_kind) BETWEEN 1 AND 60),
  subject_id TEXT NOT NULL,
  payload_hash TEXT NOT NULL CHECK(length(payload_hash)=64),
  prev_hash TEXT NOT NULL CHECK(length(prev_hash)=64),
  this_hash TEXT NOT NULL CHECK(length(this_hash)=64),
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0)
);

CREATE TABLE activity_log(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE RESTRICT,
  actor_agent_id TEXT REFERENCES agents(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  subject_id TEXT,
  details_json TEXT,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);
CREATE INDEX idx_activity_ws ON activity_log(workspace_id,created_at_ms);

CREATE TABLE webhooks(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  url TEXT NOT NULL CHECK(url LIKE 'https://%' OR url LIKE 'http://localhost%' OR url LIKE 'http://127.0.0.1%'),
  secret_hash TEXT NOT NULL CHECK(length(secret_hash)=64),
  status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','failing','dead')),
  failure_count INTEGER NOT NULL DEFAULT 0,
  last_error TEXT,
  updated_at_ms INTEGER NOT NULL CHECK(updated_at_ms>0)
);

CREATE TABLE idempotency_keys(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  actor_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
  surface TEXT NOT NULL,
  key TEXT NOT NULL,
  response_json TEXT NOT NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0),
  UNIQUE(actor_agent_id,surface,key)
);

-- ============ INSERT-only enforcement ============
CREATE TRIGGER tg_receipts_no_upd BEFORE UPDATE ON adoption_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_receipts_no_del BEFORE DELETE ON adoption_receipts BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_upd  BEFORE UPDATE ON receipt_events   BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del  BEFORE DELETE ON receipt_events   BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_tlog_no_upd     BEFORE UPDATE ON transparency_log BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_tlog_no_del     BEFORE DELETE ON transparency_log BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

-- ============ Tenancy consistency ============
CREATE TRIGGER tg_skill_owner_ws BEFORE INSERT ON skills
BEGIN
  SELECT CASE WHEN (SELECT workspace_id FROM agents WHERE id=NEW.owner_agent_id) <> NEW.workspace_id
    THEN RAISE(ABORT,'TENANCY_OWNER_NOT_IN_WS') END;
END;

CREATE TRIGGER tg_version_author_ws BEFORE INSERT ON skill_versions
BEGIN
  SELECT CASE WHEN (SELECT workspace_id FROM agents WHERE id=NEW.author_agent_id)
       <> (SELECT workspace_id FROM skills WHERE id=NEW.skill_id)
    THEN RAISE(ABORT,'TENANCY_AUTHOR_NOT_IN_WS') END;
END;

CREATE TRIGGER tg_receipt_tenancy BEFORE INSERT ON adoption_receipts
BEGIN
  SELECT CASE WHEN (SELECT adopter_agent_id FROM adoption_requests WHERE id=NEW.adoption_request_id) <> NEW.adopter_agent_id
    THEN RAISE(ABORT,'TENANCY_ADOPTER_MISMATCH') END;
  SELECT CASE WHEN (SELECT skill_version_id FROM adoption_requests WHERE id=NEW.adoption_request_id) <> NEW.skill_version_id
    THEN RAISE(ABORT,'TENANCY_VERSION_MISMATCH') END;
  SELECT CASE WHEN
      (SELECT s.workspace_id FROM skills s JOIN skill_versions v ON v.skill_id=s.id WHERE v.id=NEW.skill_version_id)
      <> (SELECT workspace_id FROM agents WHERE id=NEW.adopter_agent_id)
    AND (SELECT state FROM skill_versions WHERE id=NEW.skill_version_id) <> 'published'
    THEN RAISE(ABORT,'TENANCY_CROSS_WS_REQUIRES_PUBLISHED') END;
END;

-- Per-adoption approval must reference the SAME version as its adoption_request
-- (blocks security-invalid approval: skill_version_id=V2 with a request belonging to V1).
CREATE TRIGGER tg_approval_version_match BEFORE INSERT ON approvals
WHEN NEW.scope='adopt_high_risk'
BEGIN
  SELECT CASE WHEN (SELECT skill_version_id FROM adoption_requests WHERE id=NEW.adoption_request_id)
       <> NEW.skill_version_id
    THEN RAISE(ABORT,'APPROVAL_VERSION_MISMATCH') END;
END;
