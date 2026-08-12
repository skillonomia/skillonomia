// Skillonomia P0 — database bootstrap + migration runner.
// Schema versioning uses PRAGMA user_version (no bookkeeping table: the live
// schema must stay byte-identical to Appendix D.1 of the spec, 20 tables exactly).
import { openSqlite, type Db } from "./sqlite.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir } from "./assets.ts";
import { MIGRATION_STEPS } from "./migration-steps.ts";

export type { Db } from "./sqlite.ts";

export function openDb(path: string = ":memory:"): Db {
  const db = openSqlite(path);
  db.exec("PRAGMA foreign_keys=ON;");
  if (path !== ":memory:") db.exec("PRAGMA journal_mode=WAL;");
  return db;
}

/**
 * A connection that CANNOT write — for auditing an existing deployment.
 *
 * `openDb` sets `PRAGMA journal_mode=WAL`, which rewrites the database header.
 * That is correct for a process that is about to serve, and wrong for one that
 * only reads: it made `skillonomia verify-log` fail outright on a snapshot
 * copied with the file mode intact, or on a database whose directory an
 * operator had made read-only — precisely the two situations the subcommand
 * exists for. Worse, on a writable file it MUTATED the artifact under audit
 * before reading it.
 *
 * The refusal comes from SQLite (`SQLITE_OPEN_READONLY`), not from this code
 * being careful, so no statement issued through this handle can write no matter
 * what a caller asks for.
 *
 * There is no migration here either, and there must not be: an audit reports on
 * the schema it finds. A database older than this build is a fact about the
 * deployment, not something a read-only command may quietly change.
 *
 * One caveat that belongs to SQLite rather than to us: opening a WAL database
 * read-only needs a shared-memory file next to it, so the DIRECTORY has to be
 * writable even when the database file is not. A snapshot in a wholly read-only
 * directory has to be copied somewhere writable first — the error says so.
 */
export function openReadOnly(path: string): Db {
  const db = openSqlite(path, { readonly: true });
  // a connection setting, not a write: it changes how THIS handle behaves and
  // touches no page of the file
  db.exec("PRAGMA foreign_keys=ON;");
  return db;
}

/**
 * THE SCHEMA VERSIONS THIS BUILD REFUSES TO UPGRADE, AND WHY THERE IS ONE.
 *
 * `0012` replaces every non-empty `receipt_events.idempotency_key` with the
 * digest of it, UNCONDITIONALLY — no test of the value's form, because the form
 * of a value cannot say which build wrote a row and a rule that guessed at it
 * collided two rows of one receipt and left an upgrade that could never finish
 * (`migrations/0012…`, `[12.1]`).
 *
 * Unconditional is wrong for exactly one state. Round 10's build hashed on the
 * way in and shipped no migration, so a database it left behind already holds
 * digests, and hashing one a second time stores `sha256(sha256(k))` — a
 * well-formed value of exactly the right shape that no reader computes, which
 * would break every repeat on that database in silence (`[11.3b]`). That state
 * is `PRAGMA user_version` = 10, and it cannot be told apart from a database an
 * older build left at 10 with raw keys, because `0010` shipped before the writer
 * that hashes did and nothing in a row records which build wrote it.
 *
 * So the state is WITHDRAWN rather than guessed at. Round 10 was an intermediate
 * development commit of this tree: it was never released, never published and
 * never deployed, so withdrawing it narrows the supported set without taking
 * anything from anybody. The supported upgrade path is `user_version` 9 or below
 * — the last state whose every key is the adopter's own string — and `SPEC.md`,
 * `docs/API.md` and `docs/OPERATIONS.md` say so in the shipped text.
 *
 * THE ONE CASE THIS COSTS SOMETHING, named rather than left to be found: an
 * upgrade from 9 or below that is interrupted after `0010` commits leaves a
 * database at 10 whose keys are still raw, and no inspection can tell it apart
 * from one round 10 wrote — which is the same impossibility this whole round is
 * about. Such a database is refused too, and the message says to restore the
 * copy taken before the upgrade.
 *
 * 11 IS NOT IN THIS SET, deliberately. A process that dies between two
 * migrations of one pass leaves a database at 11 with its keys still raw,
 * because `0011` carries every value across unchanged; that database must be
 * able to finish, and `[12.3b]` requires it to.
 */
export const UNSUPPORTED_UPGRADE_FROM: readonly number[] = [10];

/** The message a refused upgrade carries, naming the state and the way out. */
export function unsupportedUpgradeMessage(version: number): string {
  return (
    `this database reports PRAGMA user_version = ${version}, and this build cannot upgrade it. ` +
    `The build that left a database at ${version} stored receipt_events.idempotency_key as a digest and shipped no ` +
    `migration, so a database at ${version} may hold digests, may hold an older build's raw keys, and may hold ` +
    `both — nothing in a row records which build wrote it. Migration 0012 hashes every key unconditionally, which ` +
    `is the only rule that cannot collide, and on such a database it would hash a digest a second time and break ` +
    `every repeat in silence. That build was an intermediate development commit and was never released or ` +
    `deployed. The supported upgrade path is a database at PRAGMA user_version 9 or below. ` +
    `If this database reached ${version} because an upgrade from 9 or below was interrupted after that migration ` +
    `committed, it is indistinguishable from one that build wrote and this build cannot tell them apart: restore ` +
    `the copy taken before the upgrade and start again.`
  );
}

export function migrate(db: Db): void {
  // resolved at call time, not at import time: a compiled binary finds its
  // assets next to the executable (src/assets.ts), a checkout next to src/
  const MIGRATIONS_DIR = migrationsDir();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  // Refused BEFORE the first transaction opens, so a database this build will
  // not upgrade is left exactly as it was found.
  if (UNSUPPORTED_UPGRADE_FROM.includes(version)) {
    throw new Error(unsupportedUpgradeMessage(version));
  }
  for (const file of files) {
    const n = parseInt(file.slice(0, 4), 10);
    if (n <= version) continue;
    db.exec("BEGIN");
    try {
      // A migration whose SQL needs a value SQLite cannot compute — a SHA-256,
      // for `0012` — has a step in `src/migration-steps.ts`. It runs inside THIS
      // transaction and before the file that consumes it, so a step that throws
      // is rolled back with the migration and never half-applied. It prepares
      // values; every table, index, trigger and constraint stays in the `.sql`
      // file, which is what Appendix D of `SPEC.md` embeds verbatim.
      MIGRATION_STEPS[n]?.(db);
      db.exec(readFileSync(join(MIGRATIONS_DIR, file), "utf8"));
      db.exec(`PRAGMA user_version=${n}`);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
    version = n;
  }
}

export function openMigrated(path: string = ":memory:"): Db {
  const db = openDb(path);
  migrate(db);
  return db;
}
