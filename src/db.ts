// Skillonomia P0 — database bootstrap + migration runner.
// Schema versioning uses PRAGMA user_version (no bookkeeping table: the live
// schema must stay byte-identical to Appendix D.1 of the spec, 20 tables exactly).
import { openSqlite, type Db } from "./sqlite.ts";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { migrationsDir } from "./assets.ts";

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

export function migrate(db: Db): void {
  // resolved at call time, not at import time: a compiled binary finds its
  // assets next to the executable (src/assets.ts), a checkout next to src/
  const MIGRATIONS_DIR = migrationsDir();
  const files = readdirSync(MIGRATIONS_DIR)
    .filter((f) => /^\d{4}_.+\.sql$/.test(f))
    .sort();
  const row = db.prepare("PRAGMA user_version").get() as { user_version: number };
  let version = row.user_version;
  for (const file of files) {
    const n = parseInt(file.slice(0, 4), 10);
    if (n <= version) continue;
    db.exec("BEGIN");
    try {
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
