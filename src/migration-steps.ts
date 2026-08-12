// THE PART OF A MIGRATION SQLITE CANNOT EXPRESS.
//
// WHY THIS FILE EXISTS. `0011` has to replace a stored string with the SHA-256
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
import { EVIDENCE_DIGEST } from "./outcome.ts";

/**
 * `0011` — the key of a repeat, on the rows an older build wrote.
 *
 * Round 10 replaced the adopter's `idempotency_key` with `correlationDigest` of
 * it, on both sides of the one comparison the column serves, and shipped no
 * migration. This computes the value each existing row should hold; the SQL file
 * is what moves them.
 *
 * WHAT IS HASHED AND WHAT IS NOT — the whole of the rule, in one place.
 *
 *   A value ALREADY OF THE STORED FORM (`sha256:` and 64 lowercase hex digits,
 *   `EVIDENCE_DIGEST`, the same constant every reader of a digest uses) is
 *   carried across UNCHANGED. Any database raised on the round-10 build already
 *   holds those, and hashing them again would give `sha256(sha256(k))` — a
 *   well-formed value of the right shape and the wrong one, which would break
 *   every repeat on every such database silently. Anything else is hashed.
 *
 *   THE COST OF DECIDING BY FORM, which is real and is not hidden. An adopter's
 *   own key that IS, letter for letter, `sha256:<64 lowercase hex>` cannot be
 *   told from the digest of a key by any inspection of the value — nothing in
 *   the row records which build wrote it — so it is left as it stands, and the
 *   replay of that ONE key stops matching after the upgrade. The alternative
 *   loses every repeat on every database created since round 10, so this is the
 *   narrow failure chosen over the wide one, and `[11.11]` runs it.
 *
 *   ABSENCE IS NOT HASHED, for the reason `correlationDigest` gives: a digest of
 *   nothing would give every row without a value ONE SHARED value and
 *   manufacture matches out of absence. It is unreachable in this column —
 *   `idempotency_key` has been `NOT NULL` since D.1 — and it is written down
 *   rather than relied upon: a value that is not a non-empty string is carried
 *   across as it is, and the destination column's own `NOT NULL` then refuses
 *   it. A row this step somehow failed to map is refused by the same rule, so a
 *   mapping that missed a row aborts the migration instead of quietly leaving
 *   that row's key in the clear.
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
    const mapped =
      typeof stored === "string" && stored.length > 0
        ? EVIDENCE_DIGEST.test(stored)
          ? stored
          : correlationDigest(stored)
        : stored;
    insert.run(row.id, mapped as never);
  }
}

/**
 * The steps, by the migration number that consumes them. A migration with no
 * entry here is SQL and nothing else, which is all of them but one.
 */
export const MIGRATION_STEPS: Readonly<Record<number, (db: Db) => void>> = {
  11: keysOfRepeatsBecomeDigests,
};
