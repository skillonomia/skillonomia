-- SKILLONOMIA — the recipient of a PULL belongs to the receipt event too.
--
-- WHAT WAS WRONG. §5.4 put the recipient of a PUSH on the `transferred` event,
-- on the INSERT-only row, in the transaction that recorded the push. It left
-- the other half of the movement alone: a chain the recipient opens for itself
-- (`skill.request_adoption`) has no `transferred` event and never had one, so
-- the migration counter read its recipient from `adoption_receipts.
-- adopter_agent_id` — the receipt SHELL. The shell is INSERT-only, so nothing
-- was rewritable; but the shell is not `receipt_events`, and §5.3's own rule for
-- this counter is "Every count MUST be computed from `receipt_events`". A rule
-- that holds for half the chains is a rule the next reader will apply to the
-- other half. The registry published a figure beside the sentence that says
-- where figures come from, and for pull chains the sentence was false.
--
-- It also cost the number its provenance in the ordinary case: the `source`
-- phrase named the receipt shell whenever ANY counted recipient came from it,
-- which on a single-owner deployment is nearly every migration — so the honest
-- attribution [I-3] forced was, in practice, a permanent footnote saying the
-- count was not obtained from the journal it is specified to be obtained from.
--
-- WHAT CHANGES, AND WHY IT IS THE SAME CHANGE `0004` MADE. `0004` moved the
-- declared environment off a mutable request column and onto the event that
-- describes the handover, because a count taken from current state is a reading
-- of whoever wrote last. The move here is the same in shape and for the
-- adjacent reason: the RECIPIENT — the other half of the (version, recipient)
-- key this counter counts — moves onto the journal, so the whole key is read
-- from one INSERT-only place and the specified sentence becomes literally true.
--
-- `requested` is the pull twin of `transferred`. It says: this chain was opened
-- by the agent named on it, asking for this version for itself. Like
-- `transferred` it is written by the REGISTRY, in the same transaction as the
-- request and the receipt shell, and it is refused to the receipt's own adopter
-- through surface 8 — otherwise an adopter could name its own recipient on a row
-- the counter reads, which is the whole reason §5.4 keeps `transferred` out of
-- the adopter's hands. It opens a chain and asserts nothing beyond itself: what
-- may follow it is exactly what may follow an empty chain or a `transferred`.
--
-- HISTORY IS NOT REWRITTEN, AND THAT IS FAIL-CLOSED. Rows written before this
-- migration carry no `requested` event, and none is invented for them: a chain
-- that names no recipient ON THE JOURNAL contributes NOTHING to the count and is
-- reported as `recipients_unattributed`, exactly as a `transferred` event with
-- an unreadable payload already was. That is the same fail-closed posture `0004`
-- took for the declared environment — "history that was never recorded cannot be
-- inferred, only recounted on a fresh instance" — and it is why this migration
-- back-fills nothing. A back-fill would be the registry writing, today, an event
-- asserting what it did not observe then.
--
-- Additive to the schema in every sense that matters: one more member of one
-- CHECK enum. No column is added, no constraint is relaxed, no index or trigger
-- changes meaning, no row is touched. SQLite cannot alter a CHECK in place, so
-- the table is rebuilt exactly as `0006` rebuilt it — same columns, same order,
-- same uniqueness, same partial terminal index, same two INSERT-only triggers,
-- recreated verbatim after the rename.
PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

DROP TRIGGER tg_revents_no_upd;
DROP TRIGGER tg_revents_no_del;

CREATE TABLE receipt_events_p14b(
  id TEXT PRIMARY KEY CHECK(length(id)=26),
  adoption_receipt_id TEXT NOT NULL REFERENCES adoption_receipts(id) ON DELETE RESTRICT,
  event TEXT NOT NULL CHECK(event IN ('delivered','attempted','adopted','failed','rolled_back','transferred','requested')),
  event_seq INTEGER NOT NULL CHECK(event_seq>=1),
  evidence_json TEXT,
  failure_report_json TEXT,
  rollback_report_json TEXT,
  server_at_ms INTEGER NOT NULL CHECK(server_at_ms>0),
  idempotency_key TEXT NOT NULL,
  environment_json TEXT,
  recipient_json TEXT,
  UNIQUE(adoption_receipt_id,idempotency_key),
  UNIQUE(adoption_receipt_id,event_seq),
  UNIQUE(adoption_receipt_id,event)
);

INSERT INTO receipt_events_p14b(id, adoption_receipt_id, event, event_seq, evidence_json,
       failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, recipient_json)
  SELECT id, adoption_receipt_id, event, event_seq, evidence_json,
         failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, recipient_json
    FROM receipt_events;

DROP TABLE receipt_events;
ALTER TABLE receipt_events_p14b RENAME TO receipt_events;
PRAGMA legacy_alter_table=OFF;

CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');
CREATE TRIGGER tg_revents_no_upd BEFORE UPDATE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del BEFORE DELETE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
