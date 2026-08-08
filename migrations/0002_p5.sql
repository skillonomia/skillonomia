-- SKILLONOMIA P5 migration — the SOLE authorized exception to the P0 schema
-- freeze. It adds what §5.2 needs to be storable: the `approval_pending` hold
-- and the `approval_denied` reason, which break the approval↔request circular
-- dependency, plus the endpoint snapshot and the secret indirection.
--
-- migrations/0001_init.sql stays byte-identical to Appendix D.1 and is not
-- touched. Everything below is additive to the DATA MODEL: no column is
-- dropped, no row is lost, and every pre-existing constraint is carried over
-- verbatim.
--
-- SQLite cannot alter a CHECK constraint, so `adoption_requests` is rebuilt in
-- place. `defer_foreign_keys` postpones FK enforcement to COMMIT (the children
-- resolve again after the rename), and `legacy_alter_table` keeps the rename
-- from re-parsing tg_receipt_tenancy while the old table is momentarily absent.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

CREATE TABLE adoption_requests_p5(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  skill_version_id TEXT NOT NULL REFERENCES skill_versions(id) ON DELETE RESTRICT,
  adopter_agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE RESTRICT,
  requester_context_json TEXT,
  -- §5.2: `approval_pending` added; a request awaiting a §7.3 human approval
  -- is not claimable and cannot be adopted.
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','leased','pushed','dead_letter','approval_pending')),
  -- §5.2 adds `approval_denied` (a decision) and `endpoint_missing` (no
  -- endpoint was selectable for this adopter).
  dead_letter_reason TEXT CHECK(dead_letter_reason IS NULL OR dead_letter_reason IN ('max_attempts','stale_lease','endpoint_dead','approval_denied','endpoint_missing')),
  lease_owner TEXT,
  lease_expires_at_ms INTEGER,
  attempt_count INTEGER NOT NULL DEFAULT 0 CHECK(attempt_count BETWEEN 0 AND 5),
  next_attempt_at_ms INTEGER NOT NULL DEFAULT 0,
  -- §5.2: the ONE endpoint selected for this request, snapshotted at creation
  webhook_id TEXT REFERENCES webhooks(id) ON DELETE SET NULL,
  created_at_ms INTEGER NOT NULL CHECK(created_at_ms>0)
);

INSERT INTO adoption_requests_p5(id, skill_version_id, adopter_agent_id, requester_context_json,
       state, dead_letter_reason, lease_owner, lease_expires_at_ms, attempt_count,
       next_attempt_at_ms, webhook_id, created_at_ms)
  SELECT id, skill_version_id, adopter_agent_id, requester_context_json,
         state, dead_letter_reason, lease_owner, lease_expires_at_ms, attempt_count,
         next_attempt_at_ms, NULL, created_at_ms
    FROM adoption_requests;

DROP TABLE adoption_requests;
ALTER TABLE adoption_requests_p5 RENAME TO adoption_requests;
PRAGMA legacy_alter_table=OFF;

-- identical to D.1's index on the rebuilt table
CREATE INDEX idx_req_due ON adoption_requests(state,next_attempt_at_ms);

-- §5.2: the plaintext webhook secret is NEVER stored in SQLite and is shown
-- exactly once, at registration. `secret_hash` (D.1) remains a verifier only;
-- the worker resolves the signing secret through this deployment-local ref.
ALTER TABLE webhooks ADD COLUMN secret_ref TEXT;
