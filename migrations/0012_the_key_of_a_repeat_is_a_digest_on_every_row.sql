-- 0012 — THE KEY OF A REPEAT IS A DIGEST ON EVERY ROW, WITH NOTHING DECIDING
-- WHICH ROWS. THIS IS THE CONVERSION `0011` WAS WRITTEN FOR AND COULD NOT
-- COMPLETE.
--
-- WHAT WAS LEFT UNDONE, TWICE. Round 10 surveyed every column of every journal
-- and moved `receipt_events.idempotency_key` to a digest: the column is compared
-- and never read, equality survives a hash exactly, and an adopter's string of up
-- to 128 characters had no business sitting in an INSERT-only journal. The
-- writer and the reader were both changed and NO MIGRATION WAS WRITTEN, so a
-- retry that had been answered `200 noop` was answered `412` after the upgrade
-- and the text the round was about was still in the table. `0011` was that
-- repair — and it decided WHICH ROWS TO CONVERT BY THE FORM OF THE VALUE, which
-- is a question no value can answer.
--
-- THE RUN THAT ENDED THAT RULE. A reviewer sent two keys through the base
-- build's own REST surface onto ONE receipt: an `attempted` keyed
-- `collision-pair-key`, and a `failed` keyed with the LITERAL DIGEST OF THAT
-- STRING. Both were accepted, both stored verbatim, both answered 200. `0011`
-- then hashed the first — making it exactly equal to the second — carried the
-- second across as "already a digest", and the rebuild died on
-- `UNIQUE(adoption_receipt_id, idempotency_key)`. The transaction rolls back,
-- `PRAGMA user_version` stays at 10, and no run of any build can ever finish the
-- upgrade. Nothing in that needs an adversary with more than its own API keys,
-- which is the whole of what the V-1 threat model grants one [D-21].
--
-- THE RULE HERE, AND IT IS THE WHOLE RULE. EVERY NON-EMPTY VALUE IS REPLACED BY
-- ITS DIGEST. There is no test of form anywhere — not in this file, not in
-- `src/migration-steps.ts`, which is the one place the mapping is computed. Two
-- different strings have two different digests, whatever either of them looks
-- like, so there is nothing left to collide and nothing left to guess. The
-- registry's own synthesized key (`synth-delivered:<receipt>`) goes through it
-- like any other, and `[12.4]` requires the migrated value to equal what this
-- build's synthesizer writes today, read off a live run rather than off the same
-- expression twice.
--
-- WHAT AN UNCONDITIONAL RULE COSTS, AND WHERE THAT COST IS PAID. Hashing
-- unconditionally is wrong for a database whose keys ARE already digests — it
-- would store `sha256(sha256(k))`, a well-formed value of exactly the right
-- shape that no reader computes, and every repeat on such a database would stop
-- repeating in silence (`[11.3b]`). Exactly one `user_version` can be in that
-- state: 10, the round-10 build's, which hashed on the way in and shipped no
-- migration. That state is not guessed at — IT IS REFUSED. `migrate()`
-- (`src/db.ts`, `UNSUPPORTED_UPGRADE_FROM`) declines to upgrade a database left
-- at 10 and says why. Round 10 was an intermediate development commit of this
-- tree and was never released or deployed, so the supported upgrade path is
-- `PRAGMA user_version` 9 or below — the last state whose every key is the
-- adopter's own string, because no build stopping at `0009` had the writer that
-- hashes. `SPEC.md` and `docs/API.md` carry that boundary in the shipped text,
-- and `[12.3]` runs the refusal against a real round-10 database.
--
-- AND NO INCOMING KEY IS REFUSED FOR ITS SHAPE. A draft of this migration also
-- turned away a caller's `idempotency_key` of the stored form, so that no
-- further row could be ambiguous. It was withdrawn, and the reason is the point
-- of the whole round: a refusal is only needed while something DECIDES BY FORM,
-- and nothing does any more. An adopter that sends `sha256:<64 lowercase hex>`
-- gets the digest OF THAT STRING, which is not the digest of the other key, so
-- the pair that collided is two values here and two values in the live writer
-- alike (`[12.1]`, `[12.1b]`). A rule whose answer depended on what was already
-- in the table would also have been a rule no reader could check against a
-- request. `[12.7]` walks `src/` and requires that no statement naming an
-- idempotency key applies a pattern to it.
--
-- ABSENCE IS NOT HASHED, for the reason `correlationDigest` gives: one shared
-- digest for every row without a value would manufacture matches out of absence.
-- A value that is not a non-empty string is carried across as it is, and that
-- splits in two, exactly:
--
--   NULL — and a row the step failed to map at all, whose subquery yields NULL —
--   is refused by the `NOT NULL` below and rolls the whole migration back,
--   rather than leaving one receipt's key in the clear.
--
--   THE EMPTY STRING IS NOT REFUSED. An empty string is not NULL and SQLite
--   admits it, so a row holding one comes through unchanged. No shipped writer
--   can produce such a row — every one of them refuses a key shorter than one
--   character — so reaching it needs a statement issued against the database
--   file directly, which is outside the V-1 threat model [D-21]. It is written
--   here because `0011` claimed `NOT NULL` would refuse it and that was false,
--   and `[12.6]` runs both halves: the row that survives, and this text.
--
-- HOW THE TABLE IS REBUILT. SQLite cannot rewrite a column in place under an
-- INSERT-only trigger, so the table is rebuilt exactly as `0006`, `0009` and
-- `0011` rebuilt it — the same columns in the same order, the same three UNIQUE
-- constraints, the same partial terminal index and the same two triggers,
-- re-created verbatim after the rename. This is the FOURTH rebuild of this
-- table, and each one is a chance to drop a constraint in silence, so the
-- difference between what `0011` leaves and what this leaves is asserted OBJECT
-- FOR OBJECT — statements, columns, indexes with their columns and their
-- partiality, foreign keys, triggers — by `[12.5]`, and the intended difference
-- is NONE. This migration changes VALUES and no part of the shape.
--
-- WHERE THE NEW VALUES COME FROM. SQLite has no SHA-256, and the two runtimes
-- this registry runs on are reached through one minimal interface that exposes
-- no way to register one. So `src/migration-steps.ts` computes the mapping into
-- `receipt_events_keymap` INSIDE THIS TRANSACTION and immediately before this
-- file, which reads it, and the last statement here drops it: the scratch table
-- is never part of a schema anybody sees, and a step that throws is rolled back
-- with the migration. Every shape this registry has stays in a numbered file
-- like this one, which is what Appendix D embeds verbatim.
--
-- NOTHING ELSE MOVES. No row is added or removed, no other column is touched,
-- and `UNIQUE(adoption_receipt_id, idempotency_key)` still separates two
-- different keys — demonstrated by a refused duplicate in `[11.6]` rather than
-- read off this text. `PRAGMA user_version` = `12`.
--
-- WHAT THIS MIGRATION DOES NOT COVER, NAMED RATHER THAN LEFT TO BE FOUND. It
-- answers for `receipt_events.idempotency_key` AND FOR NOTHING ELSE.
-- `observed_records.call_id` and `runtime_observations.model` /
-- `.window_detail`, narrowed in the same round and created by `0008`, are not
-- repaired here; `[11.12]` runs that boundary so the round which takes those
-- columns starts from a failing probe. `[11.8]` is the guard that generalizes
-- what IS covered: it walks EVERY journal column the shipped code classifies as
-- a digest — the set from `JOURNAL_INTAKE` and not a list in a test — over the
-- legacy databases the upgrade probe builds, and requires every value in every
-- one of them to be a digest.

PRAGMA defer_foreign_keys=ON;
PRAGMA legacy_alter_table=ON;

DROP TRIGGER tg_revents_no_upd;
DROP TRIGGER tg_revents_no_del;

CREATE TABLE receipt_events_p14d(
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

INSERT INTO receipt_events_p14d(id, adoption_receipt_id, event, event_seq, evidence_json,
       failure_report_json, rollback_report_json, server_at_ms, idempotency_key, environment_json, recipient_json)
  SELECT e.id, e.adoption_receipt_id, e.event, e.event_seq, e.evidence_json,
         e.failure_report_json, e.rollback_report_json, e.server_at_ms,
         (SELECT m.idempotency_key FROM receipt_events_keymap m WHERE m.id = e.id),
         e.environment_json, e.recipient_json
    FROM receipt_events e;

DROP TABLE receipt_events;
ALTER TABLE receipt_events_p14d RENAME TO receipt_events;
PRAGMA legacy_alter_table=OFF;

CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');
CREATE TRIGGER tg_revents_no_upd BEFORE UPDATE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del BEFORE DELETE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

DROP TABLE receipt_events_keymap;
