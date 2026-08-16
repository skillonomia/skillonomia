#!/usr/bin/env bash
# GATE: reversible migration round trip — up, down, up.
#
#   v1/tools/gates/reversible-migration.sh
#
# IMPLEMENTED BY P1, the first phase of this contract to change the schema.
# Until then this path exited 3, NOT IMPLEMENTED FOR THIS PHASE; the contract
# written for it at P0 is unchanged and is what the harness below meets.
#
# Contract section 2 requires schema changes to be additive AND reversible, and
# section 9 makes a migration round trip mandatory for a schema-changing phase.
# The base commit ships no down-migration at all — `v1/P0-BASELINE.md` records
# that as a fact about the tree — so P1's own migration ships one beside it, and
# this gate is what proves the pair rather than the promise.
#
# WHAT IT MEASURES, on a throwaway in-memory database and nothing else:
#
#   1. the schema BEFORE the change, built by running every migration up to the
#      one before the head, with a seeded row census beside it;
#   2. the change applied, asserted ADDITIVE — every statement of the previous
#      schema still present after whitespace normalisation, and every
#      pre-existing row still there;
#   3. the change REVERSED by the shipped down-migration, with the schema digest
#      and the census compared against step 1;
#   4. the change re-applied, converging on the digest of step 2.
#
# It prints the four digests it compared. A round trip that reports success
# without showing two equal digests has asserted rather than measured.
#
# EXIT CODES, FIXED FOR EVERY GATE HARNESS
#   0  the gate passed
#   1  the gate failed — a real defect on the surface it measures
#   2  REFUSED — the harness could not reach its subject; never reported as a pass
#   3  NOT IMPLEMENTED FOR THIS PHASE — what it measures does not exist yet
set -uo pipefail
cd "$(dirname "$0")/../../.." || exit 2

command -v node >/dev/null 2>&1 || { echo "REFUSED: node is not on PATH." >&2; exit 2; }
[ -d migrations ] || { echo "REFUSED: no migrations/ directory here." >&2; exit 2; }

echo "gate:  reversible migration round trip (contract sections 2 and 9)"
echo "cwd:   $(pwd)"
echo

node --experimental-strip-types --no-warnings - <<'NODE'
import { readFileSync, readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { openDb, migrate } from "./src/db.ts";
import { MIGRATION_STEPS } from "./src/migration-steps.ts";
import { seedGraph } from "./test/helpers.ts";

const DIR = "migrations";
const files = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
if (files.length === 0) {
  console.error("REFUSED: no migration files found.");
  process.exit(2);
}
const headFile = files[files.length - 1];
const head = parseInt(headFile.slice(0, 4), 10);
const previous = head - 1;
const down = join(DIR, "down", `${headFile.replace(/\.sql$/, "")}.down.sql`);
if (!existsSync(down)) {
  console.error(`REFUSED: the head migration ${headFile} ships no reversal at ${down}.`);
  console.error("A phase that changes the schema owes a reversal, or a documented restore route this gate can run.");
  process.exit(2);
}

const at = (through) => {
  const db = openDb();
  for (const file of files) {
    const n = parseInt(file.slice(0, 4), 10);
    if (n > through) break;
    db.exec("BEGIN");
    MIGRATION_STEPS[n]?.(db);
    db.exec(readFileSync(join(DIR, file), "utf8"));
    db.exec(`PRAGMA user_version=${n}`);
    db.exec("COMMIT");
  }
  return db;
};
const version = (db) => db.prepare("PRAGMA user_version").get().user_version;
const statements = (db) =>
  db
    .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((r) => r.sql.replace(/\s+/g, " ").trim())
    .sort();
const digest = (db) => `sha256:${createHash("sha256").update(statements(db).join("\n"), "utf8").digest("hex")}`;
const census = (db) => {
  const out = {};
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()) {
    out[name] = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
  }
  return out;
};

const fail = [];
const db = at(previous);
seedGraph(db);
const beforeStatements = statements(db);
const beforeDigest = digest(db);
const beforeCensus = census(db);
console.log(`before  user_version=${version(db)}  ${beforeDigest}`);

migrate(db);
const upDigest = digest(db);
console.log(`up      user_version=${version(db)}  ${upDigest}`);
if (version(db) !== head) fail.push(`the upgrade landed at ${version(db)} rather than ${head}`);
const now = statements(db);
const lost = beforeStatements.filter((s) => !now.includes(s));
if (lost.length > 0) {
  fail.push(`the migration is NOT additive: ${lost.length} statement(s) of the previous schema changed or went`);
}
for (const [table, count] of Object.entries(beforeCensus)) {
  const after = census(db)[table];
  if (after !== count) fail.push(`${table} held ${count} rows before the upgrade and ${after} after it`);
}

db.exec(readFileSync(down, "utf8"));
const downDigest = digest(db);
console.log(`down    user_version=${version(db)}  ${downDigest}`);
if (version(db) !== previous) fail.push(`the reversal left user_version at ${version(db)} rather than ${previous}`);
if (downDigest !== beforeDigest) fail.push("the schema after the reversal is NOT the schema before the upgrade");
for (const [table, count] of Object.entries(beforeCensus)) {
  const after = census(db)[table];
  if (after !== count) fail.push(`${table} held ${count} rows before the upgrade and ${after} after the reversal`);
}

migrate(db);
const againDigest = digest(db);
console.log(`up      user_version=${version(db)}  ${againDigest}`);
if (againDigest !== upDigest) fail.push("re-applying the migration did not converge on the same schema");
db.close();

console.log();
if (fail.length > 0) {
  for (const f of fail) console.error(`FAIL  ${f}`);
  process.exit(1);
}
console.log(`PASS  up/down/up: ${previous} -> ${head} -> ${previous} -> ${head}, digests equal at both ends`);
NODE
rc=$?
[ "$rc" -eq 0 ] || echo "FAIL  reversible migration round trip (exit $rc)" >&2
exit "$rc"
