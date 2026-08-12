-- 0011 — A REBUILD THAT WAS WRITTEN TO CONVERT A COLUMN, AND CONVERTS NOTHING.
-- ITS RULE WAS WITHDRAWN BY `0012`, AND THIS FILE RECORDS THAT RATHER THAN
-- PRETENDING IT NEVER HELD ONE.
--
-- WHAT IT HELD. Round 10 moved `receipt_events.idempotency_key` to a digest in
-- the writer and in the reader and shipped no migration, so a row an older build
-- wrote still held the adopter's string word for word while the reader hashed
-- before it looked: a retry that had been answered `200 noop` was answered `412`
-- after the upgrade. This file was that repair, and it decided WHICH ROWS TO
-- CONVERT BY THE FORM OF THE VALUE — a string of `sha256:` and 64 lowercase hex
-- was taken to be a digest already and carried across, everything else was
-- hashed — so that a database raised on the round-10 build would not have its
-- digests hashed a second time.
--
-- WHY THAT COULD NOT STAND. Nothing in a row records which build wrote it, so
-- the form of a value cannot answer the question the rule asked. A reviewer sent
-- two keys through the base build's own REST surface onto ONE receipt: a key
-- `K`, and the literal string that is the digest of `K`. Both were accepted and
-- both were stored verbatim. This rule then hashed the first — making it equal
-- to the second — carried the second across, and the rebuild below died on
-- `UNIQUE(adoption_receipt_id, idempotency_key)`. The transaction rolls back,
-- `PRAGMA user_version` stays at 10, and the upgrade can never be completed by
-- any run of any build. Everything in that sentence is inside the V-1 threat
-- model [D-21]: an agent controls its own requests through the standard API and
-- nothing else. `test/p14-r12-probes.test.ts` `[12.1]` is that run.
--
-- WHAT REPLACED IT. `0012` hashes EVERY non-empty key with no test of form —
-- two different strings have two different digests, whatever either of them
-- looks like — and the state the form check was protecting is withdrawn from the
-- supported set instead of guessed at: `migrate()` REFUSES a database left at
-- `PRAGMA user_version` = 10, which is the one state whose values may already be
-- digests. Round 10 was an intermediate development commit of this tree and was
-- never released or deployed. The supported upgrade path is `user_version` 9 or
-- below, and `SPEC.md` and `docs/API.md` say so in the shipped text.
--
-- WHY THIS FILE STILL EXISTS AND STILL REBUILDS. A migration number is consumed
-- once. A process that dies between two migrations of one pass leaves a database
-- at exactly this version, and that database must be able to finish — so `0011`
-- is not renumbered, not removed and not emptied. What it is, now, is the third
-- rebuild of `receipt_events`, carrying every row AND EVERY VALUE across
-- unchanged: the same columns in the same order, the same three UNIQUE
-- constraints, the same partial terminal index and the same two triggers,
-- re-created verbatim after the rename, exactly as `0006` and `0009` did it.
-- `[11.7]` compares the definition it leaves against the definition `0009` +
-- `0010` leave, object for object, and `[12.5]` does the same across `0012`.
--
-- THE STANDING RULE THIS ROUND ESTABLISHED IS UNCHANGED, and it is the owner's:
-- every round that changes the schema or the way a value is stored builds a
-- database from the migrations that came before it, fills it through the
-- standard surfaces, migrates it with the shipped runner, and requires the
-- standard scenario to answer exactly as it answered before.
-- `test/p14-r11-probes.test.ts` is the standing probe for that class.
--
-- WHAT THIS MIGRATION DOES NOT COVER, NAMED RATHER THAN LEFT TO BE FOUND. Round
-- 10 narrowed more than one column, and a narrowing that ships without a
-- migration leaves old values behind wherever it lands. `observed_records`
-- (`call_id`, converted in the same round) and `runtime_observations` (`model`
-- and `window_detail`, narrowed in the same round) were created by `0008`, so a
-- database older than that holds no row of either; a database written BETWEEN
-- `0008` and the round-10 build does hold the reporter's strings there, and
-- neither this migration nor `0012` repairs them. `[11.12]` runs that boundary
-- rather than describing it, so the next round starts from a failing probe and
-- not from somebody's memory of this paragraph.
--
-- NOTHING ELSE MOVES. No row is added or removed, no value is changed, no column
-- is touched and no constraint is relaxed. `PRAGMA user_version` = `11`.

PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

DROP TRIGGER tg_revents_no_upd;
DROP TRIGGER tg_revents_no_del;

CREATE TABLE receipt_events_p14c(
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

INSERT INTO receipt_events_p14c(id, adoption_receipt_id, event, event_seq, evidence_json,
       failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, recipient_json)
  SELECT e.id, e.adoption_receipt_id, e.event, e.event_seq, e.evidence_json,
         e.failure_report_json, e.rollback_report_json, e.server_at_ms,
         e.idempotency_key,
         e.environment_json, e.recipient_json
    FROM receipt_events e;

DROP TABLE receipt_events;
ALTER TABLE receipt_events_p14c RENAME TO receipt_events;
PRAGMA legacy_alter_table=OFF;

CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');
CREATE TRIGGER tg_revents_no_upd BEFORE UPDATE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del BEFORE DELETE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
