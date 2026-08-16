#!/usr/bin/env node
// P0 baseline migration/schema check on a DISPOSABLE database.
//
//   node --experimental-strip-types --no-warnings v1/tools/p0-db-check.ts
//
// WHY THIS EXISTS. Contract §9 requires a migration/schema gate on a disposable
// database for every phase, and P0 has to define the command rather than invent
// one later. The repository has `npm run dump-schema`, which PRINTS a schema —
// useful for a human diff, but it asserts nothing and exits 0 whatever it finds.
// This harness executes the claims instead.
//
// TWO RULES IT KEEPS.
//
//   1. It writes NO DDL of its own. Every schema statement comes from
//      `migrations/` through the repository's own runner in `src/db.ts`. A
//      harness with its own copy of the schema tests the copy.
//
//   2. It never opens a database it did not create. The working directory comes
//      from `mkdtemp` and is removed on exit, so there is no path by which this
//      touches a deployment's data.
import { mkdtempSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import { openDb, openMigrated, migrate, UNSUPPORTED_UPGRADE_FROM, unsupportedUpgradeMessage } from "../../src/db.ts";
import type { Db } from "../../src/db.ts";

const REPO = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

let failures = 0;
const say = (s: string) => console.log(s);
const check = (name: string, ok: boolean, detail = "") => {
  say(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
  if (!ok) failures++;
};

const workdir = mkdtempSync(join(tmpdir(), "skillonomia-p0-db-"));
say(`disposable database directory: ${workdir}`);
say("(created by mkdtemp, removed at the end of this run; no deployment database is opened)");

const schemaOf = (db: Db): string =>
  (db.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name").all() as Array<{
    type: string;
    name: string;
    sql: string | null;
  }>)
    .map((r) => `${r.type} ${r.name}\n${r.sql ?? ""}`)
    .join("\n---\n");
const uv = (db: Db): number => (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
const digest = (s: string): string => createHash("sha256").update(s).digest("hex");

// --- 1. fresh install ---------------------------------------------------------
const fresh = openMigrated(join(workdir, "fresh.db"));
const freshSchema = schemaOf(fresh);
const freshVersion = uv(fresh);
const files = readdirSync(join(REPO, "migrations"))
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const highest = Math.max(...files.map((f) => parseInt(f.slice(0, 4), 10)));
say(`migration files on disk: ${files.length} (${files[0]} … ${files[files.length - 1]})`);
check("a fresh install reaches the highest migration number on disk", freshVersion === highest, `user_version=${freshVersion}, highest file=${highest}`);

const counts: Record<string, number> = {};
for (const t of ["table", "index", "trigger", "view"]) {
  counts[t] = (fresh.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type=? AND name NOT LIKE 'sqlite_%'").get(t) as { n: number }).n;
}
say(`live objects after a fresh migrate: ${JSON.stringify(counts)}`);
check("the fresh schema is not empty", (counts.table ?? 0) > 0, `${counts.table} tables`);
say(`fresh schema sha256: ${digest(freshSchema)}`);

// --- 2. the runner is deterministic -------------------------------------------
const second = openMigrated(join(workdir, "fresh2.db"));
check("a second fresh migrate produces a byte-identical schema", digest(schemaOf(second)) === digest(freshSchema));
check("a second fresh migrate reaches the same user_version", uv(second) === freshVersion);

// --- 3. re-running migrate() changes nothing ----------------------------------
migrate(fresh);
check("migrate() on an already-migrated database is idempotent (schema)", digest(schemaOf(fresh)) === digest(freshSchema));
check("migrate() on an already-migrated database is idempotent (user_version)", uv(fresh) === freshVersion);

// --- 4. the upgrade path from the documented floor ----------------------------
// `src/db.ts` documents `user_version` 9 or below as the supported upgrade
// floor. An "older deployment" is built by applying only files up to 9, then
// handed to migrate() with one requirement: converge on the fresh-install schema.
const STOP_AT = 9;
const old = openDb(join(workdir, `upgrade-from-${STOP_AT}.db`));
for (const file of files) {
  const n = parseInt(file.slice(0, 4), 10);
  if (n > STOP_AT) continue;
  old.exec("BEGIN");
  old.exec(readFileSync(join(REPO, "migrations", file), "utf8"));
  old.exec(`PRAGMA user_version=${n}`);
  old.exec("COMMIT");
}
check(`a simulated older deployment sits at user_version ${STOP_AT}`, uv(old) === STOP_AT, `got ${uv(old)}`);
migrate(old);
check("an upgrade from the documented floor reaches the current version", uv(old) === freshVersion, `got ${uv(old)}`);
check("the upgraded schema equals the fresh-install schema exactly", digest(schemaOf(old)) === digest(freshSchema));

// --- 5. the documented refusal is real ----------------------------------------
// Driven by the module's own exported list, so this cannot quietly pass on a
// version the build never refused. ONLY the documented state is exercised: a
// synthetic database at any other version fails for unrelated reasons — a
// migration step needs tables an empty file has not got — and counting that as
// "refused" would be a false claim about a guard that never ran.
for (const bad of UNSUPPORTED_UPGRADE_FROM) {
  const d = openDb(join(workdir, `refuse-${bad}.db`));
  d.exec(`PRAGMA user_version=${bad}`);
  let threw: Error | null = null;
  try {
    migrate(d);
  } catch (e) {
    threw = e as Error;
  }
  check(`migrate() refuses an unsupported upgrade from user_version ${bad}`, threw !== null);
  check(
    "the refusal is the documented one, not an incidental error",
    threw !== null && threw.message === unsupportedUpgradeMessage(bad),
    threw ? `got: ${String(threw.message).slice(0, 70)}…` : "nothing was thrown",
  );
  check(`the refused database is left at user_version ${bad}`, uv(d) === bad, `got ${uv(d)}`);
}
say(`(UNSUPPORTED_UPGRADE_FROM = [${UNSUPPORTED_UPGRADE_FROM.join(", ")}] — read from src/db.ts, not restated here)`);

rmSync(workdir, { recursive: true, force: true });
say(`disposable database directory removed: ${workdir}`);
say(`\nchecks_failed=${failures}`);
process.exitCode = failures === 0 ? 0 : 1;
