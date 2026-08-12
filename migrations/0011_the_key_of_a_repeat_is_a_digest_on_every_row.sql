-- 0011 — THE KEY OF A REPEAT IS A DIGEST ON EVERY ROW, INCLUDING THE ONES AN
-- OLDER BUILD WROTE.
--
-- WHAT WAS LEFT UNDONE. Round 10 surveyed every column of every journal and
-- moved `receipt_events.idempotency_key` to a digest: the column is compared and
-- never read, equality survives a hash exactly, and an adopter's string of up to
-- 128 characters had no business sitting in an INSERT-only journal. The writer
-- and the reader were both changed and NO MIGRATION WAS WRITTEN. A row an older
-- build wrote still held the adopter's string word for word, and the reader now
-- hashes before it looks — so a retry that had been answered `200 noop` was
-- answered `412` after the upgrade, and the text the round was about was still
-- in the table. A reviewer drove it through the shipped REST surface with the
-- key `legacy retry key with spaces`.
--
-- This is not an attack and needs no adversary: it is an UPGRADE OF A SUPPORTED
-- DATABASE, which is a thing this repository ships and had never once tested.
-- `test/p14-r11-probes.test.ts` is the standing probe for that class, and the
-- rule it carries is the owner's: every round that changes the schema or the way
-- a value is stored builds a database from the migrations that came before it,
-- fills it through the standard surfaces, migrates it with the shipped runner,
-- and requires the standard scenario to answer exactly as it answered before.
--
-- HOW THE TABLE IS REBUILT. SQLite cannot rewrite a column in place under an
-- INSERT-only trigger, so the table is rebuilt exactly as `0006` and `0009`
-- rebuilt it — the same columns in the same order, the same three UNIQUE
-- constraints, the same partial terminal index and the same two triggers,
-- re-created verbatim after the rename. This is the THIRD rebuild of this table,
-- and each one is a chance to drop a constraint in silence, so the difference
-- between what `0009` + `0010` leave and what this leaves is asserted OBJECT FOR
-- OBJECT — statements, columns, indexes with their columns and their partiality,
-- foreign keys, triggers — by `[11.7]`, and the intended difference is NONE.
-- This migration changes VALUES and no part of the shape.
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
-- WHICH ROWS ARE HASHED — the rule is in ONE function (`src/migration-steps.ts`)
-- and this is what it does, not a second statement of it that could drift.
--
--   A VALUE ALREADY OF THE STORED FORM IS CARRIED ACROSS UNCHANGED. `sha256:`
--   and 64 lowercase hex digits — `EVIDENCE_DIGEST`, the constant every reader
--   of a digest in this repository uses. Round 10's writer shipped before this
--   migration existed, so EVERY database raised on it already holds digests;
--   hashing those again would store `sha256(sha256(k))`, which is well-formed,
--   of exactly the right shape, and not what the reader computes. Every repeat
--   on every database created since round 10 would stop repeating, quietly,
--   with nothing in any log. `[11.3]` requires those values to come through
--   byte for byte and `[11.3b]` runs the double hash to show what it costs.
--
--   EVERYTHING ELSE IS HASHED, the registry's own synthesized key included
--   (`synth-delivered:<receipt>`), so the column holds one kind of value and a
--   reader is never asked which build wrote a row. `[11.5]` requires the
--   migrated value to equal what this build's synthesizer writes today, read off
--   a live run rather than off the same expression twice.
--
--   AND THE COST OF DECIDING BY FORM, WHICH IS NOT HIDDEN. An adopter's own key
--   that IS, letter for letter, `sha256:<64 lowercase hex>` cannot be
--   distinguished from the digest of a key: nothing in the row records which
--   build wrote it, and no further inspection of a value can supply what the
--   value does not contain. Such a key is left as it stands, so the replay of
--   THAT ONE KEY stops matching after the upgrade — one adopter, one key, a
--   `412` where it expected a `200 noop`, no row lost and no value of another
--   form introduced. The alternative loses every repeat on every database
--   created since round 10. The narrow failure is chosen over the wide one
--   deliberately, and `[11.11]` runs it so that it is a recorded decision.
--
--   ABSENCE IS NOT HASHED, for the reason `correlationDigest` gives: one shared
--   digest for every row without a value would manufacture matches out of
--   absence. It is unreachable in this column, which has been `NOT NULL` since
--   D.1, and the rule is written down rather than assumed — a value that is not
--   a non-empty string is carried across as it is, and the `NOT NULL` below
--   refuses it. The same rule catches a row the step failed to map at all: the
--   subquery yields NULL, the column refuses it and the whole migration rolls
--   back, rather than one receipt's key surviving in the clear.
--
-- NOTHING ELSE MOVES. No row is added or removed, no other column is touched,
-- and `UNIQUE(adoption_receipt_id, idempotency_key)` still separates two
-- different keys — two different strings have two different digests, and the
-- constraint is demonstrated by a refused duplicate in `[11.6]` rather than read
-- off this text. `PRAGMA user_version` = `11`.
--
-- WHAT THIS MIGRATION DOES NOT COVER, NAMED RATHER THAN LEFT TO BE FOUND. Round
-- 10 narrowed more than one column, and a narrowing that ships without a
-- migration leaves old values behind wherever it lands. This file answers for
-- `receipt_events.idempotency_key` AND FOR NOTHING ELSE. `observed_records`
-- (`call_id`, converted in the same round) and `runtime_observations` (`model`
-- and `window_detail`, narrowed in the same round) were created by `0008`, so a
-- database older than that holds no row of either; a database written BETWEEN
-- `0008` and the round-10 build does hold the reporter's strings there, and this
-- migration does not repair them. `[11.12]` runs that boundary rather than
-- describing it, so the next round starts from a failing probe and not from
-- somebody's memory of this paragraph.
--
-- `[11.8]` is the guard that generalizes what IS covered: it walks EVERY journal
-- column the shipped code classifies as a digest — the set from `JOURNAL_INTAKE`
-- and not a list in a test — over the legacy databases the upgrade probe builds,
-- and requires every value in every one of them to be a digest.

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
         (SELECT m.idempotency_key FROM receipt_events_keymap m WHERE m.id = e.id),
         e.environment_json, e.recipient_json
    FROM receipt_events e;

DROP TABLE receipt_events;
ALTER TABLE receipt_events_p14c RENAME TO receipt_events;
PRAGMA legacy_alter_table=OFF;

CREATE UNIQUE INDEX uq_receipt_terminal ON receipt_events(adoption_receipt_id) WHERE event IN ('adopted','failed');
CREATE TRIGGER tg_revents_no_upd BEFORE UPDATE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;
CREATE TRIGGER tg_revents_no_del BEFORE DELETE ON receipt_events BEGIN SELECT RAISE(ABORT,'INSERT_ONLY'); END;

DROP TABLE receipt_events_keymap;
