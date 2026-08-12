// THE PART OF A MIGRATION SQLITE CANNOT EXPRESS.
//
// WHY THIS FILE EXISTS. `0012` has to replace a stored string with the SHA-256
// of it, row by row. SQLite has no hash function, and this repository opens its
// databases through `node:sqlite` and `bun:sqlite` behind one minimal interface
// (`src/sqlite.ts`) that deliberately exposes `exec`, `prepare` and `close` and
// nothing else — so there is no user-defined function to register either, and
// registering one on two runtimes would be two answers to one question.
//
// WHAT A STEP IS ALLOWED TO BE. A COMPUTATION, not a schema change. Every table,
// index, trigger and constraint of this registry is stated in a numbered `.sql`
// file and nowhere else, because Appendix D of `SPEC.md` embeds those files
// verbatim and a shape declared in TypeScript would be a shape the specification
// does not contain. A step prepares VALUES its migration then consumes.
//
// WHEN IT RUNS. Inside the transaction of the migration that consumes it, and
// immediately BEFORE that migration's SQL — the file needs the values while it
// rebuilds, and a table with INSERT-only triggers cannot be corrected afterwards
// without dropping the triggers a second time. If the step throws, the runner's
// `ROLLBACK` unwinds both halves: there is no state in which the scratch table
// exists and the migration did not run.
import type { Db } from "./sqlite.ts";
import { correlationDigest } from "./journal.ts";

/**
 * `0012` — the key of a repeat, on the rows an older build wrote.
 *
 * Round 10 replaced the adopter's `idempotency_key` with `correlationDigest` of
 * it, on both sides of the one comparison the column serves, and shipped no
 * migration. This computes the value each existing row should hold; the SQL file
 * is what moves them.
 *
 * WHAT IS HASHED: EVERY NON-EMPTY VALUE, WITH NOTHING DECIDING WHICH.
 *
 *   `0011` carried a value across when it LOOKED like a digest already —
 *   `sha256:` and 64 lowercase hex — and hashed everything else. The intent was
 *   to protect a database raised on the round-10 build, whose keys are digests
 *   and would otherwise be hashed a second time.
 *
 *   THAT RULE WAS UNSOUND AND IS GONE. Nothing in a row records which build
 *   wrote it, so the form of a value cannot answer the question the rule asked,
 *   and an adopter may send a key that IS of that form. A reviewer sent exactly
 *   two through the base build's own REST surface, onto one receipt: a key `K`,
 *   and the literal string `correlationDigest(K)`. Both were stored verbatim,
 *   both were accepted. The rule then hashed the first — making it equal to the
 *   second — carried the second across, and the rebuild died on
 *   `UNIQUE(adoption_receipt_id, idempotency_key)`. The transaction rolls back,
 *   `PRAGMA user_version` stays where it was, and the upgrade can never be
 *   completed by any run of any build. `[12.1]` is that run.
 *
 *   One unconditional rule has no such state: two different strings have two
 *   different digests, whatever either of them looks like. `K` becomes the
 *   digest of `K`; a key that IS a digest becomes the digest of THAT STRING,
 *   which is a different value again. There is nothing left to guess, so nothing
 *   asks — and `[12.7]` walks `src/` to require that nothing does. The one state
 *   an unconditional rule is wrong for is not guessed at either: it is REFUSED,
 *   by `UNSUPPORTED_UPGRADE_FROM` in `src/db.ts`.
 *
 * ABSENCE IS NOT HASHED, for the reason `correlationDigest` gives: a digest of
 * nothing would give every row without a value ONE SHARED value and manufacture
 * matches out of absence. A value that is not a non-empty string is carried
 * across as it is, and this is what that means, exactly:
 *
 *   - NULL, and a row this step somehow failed to map at all, are refused by the
 *     destination column's `NOT NULL` and abort the whole migration, rather than
 *     leaving one receipt's key in the clear;
 *   - THE EMPTY STRING IS NOT REFUSED. An empty string is not NULL and SQLite
 *     admits it, so a row holding one comes through unchanged. No shipped writer
 *     can produce such a row — every one of them refuses a key shorter than one
 *     character — so reaching this needs a statement issued against the database
 *     file directly, which is outside the V-1 threat model [D-21]. It is written
 *     down because the previous version of this comment claimed `NOT NULL` would
 *     refuse it, and that was false.
 */
function keysOfRepeatsBecomeDigests(db: Db): void {
  // The scratch table is this step's working area and the SQL file drops it in
  // the same transaction, so it is never part of the schema a reader sees.
  db.exec("CREATE TABLE receipt_events_keymap(id TEXT PRIMARY KEY, idempotency_key TEXT)");
  const rows = db.prepare("SELECT id, idempotency_key AS key FROM receipt_events").all() as Array<{
    id: string;
    key: unknown;
  }>;
  const insert = db.prepare("INSERT INTO receipt_events_keymap(id, idempotency_key) VALUES (?,?)");
  for (const row of rows) {
    const stored = row.key;
    const mapped = typeof stored === "string" && stored.length > 0 ? correlationDigest(stored) : stored;
    insert.run(row.id, mapped as never);
  }
}

/**
 * The steps, by the migration number that consumes them. A migration with no
 * entry here is SQL and nothing else, which is all of them but one.
 */
export const MIGRATION_STEPS: Readonly<Record<number, (db: Db) => void>> = {
  12: keysOfRepeatsBecomeDigests,
};
