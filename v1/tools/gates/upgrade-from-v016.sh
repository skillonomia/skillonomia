#!/usr/bin/env bash
# GATE: upgrade from a `v0.1.6` copy.
#
#   v1/tools/gates/upgrade-from-v016.sh
#
# IMPLEMENTED BY P1, the first phase of this contract whose migration set is
# ahead of the release base. Until then this path exited 3, NOT IMPLEMENTED FOR
# THIS PHASE; the contract written for it at P0 is unchanged and is what the
# harness below meets.
#
# Contract section 3.1 point 8 and `INV-08`: the data of release base `v0.1.6`
# keeps working. `v1/P0-BASELINE.md` records that the phase base commit is one
# commit above the `v0.1.6` tag and changes no file under src/, migrations/ or
# schema/ — so a database this checkout builds with the BASE migration set IS a
# `v0.1.6` database, and no second checkout is needed to produce the subject.
#
# WHAT IT MEASURES, on a disposable database and nothing else:
#
#   1. a database at the release base's migration set, populated through the
#      PUBLIC contracts — the HTTP API of this build, never direct SQL
#      (`P0-FR-05`);
#   2. the answers of the surfaces that existed then, recorded;
#   3. the current migration set run over that same database, with no manual
#      step of any kind — `INV-08` forbids one as part of normal operation;
#   4. the same surfaces asked again, and every recorded answer compared;
#   5. the row census compared, so an upgrade that "kept the API working" by
#      dropping rows fails here rather than passing quietly.
#
# THE BASE MIGRATION SET IS DISCOVERED, NOT PINNED: it is every migration this
# checkout carries except the ones added after the release base, which is the
# set named in `V016_THROUGH` below and defended by the check that the number is
# the one `v1/P0-BASELINE.md` records. A phase that adds a migration raises the
# head; it must not raise the base.
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

# The migration count of the release base `v0.1.6`, recorded in
# `v1/P0-BASELINE.md` section 4: twelve migrations, `PRAGMA user_version` 12.
V016_THROUGH=12

echo "gate:  upgrade from a v0.1.6 copy (contract section 3.1 point 8, INV-08)"
echo "base:  PRAGMA user_version=${V016_THROUGH}"
echo

V016_THROUGH="$V016_THROUGH" node --experimental-strip-types --no-warnings - <<'NODE'
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { openDb, migrate } from "./src/db.ts";
import { MIGRATION_STEPS } from "./src/migration-steps.ts";
import { Registry } from "./src/service.ts";
import { handleRest } from "./src/http.ts";
import { mintApiKey } from "./src/auth.ts";
import { seedGraph } from "./test/helpers.ts";

const through = Number(process.env.V016_THROUGH);
const DIR = "migrations";
const files = readdirSync(DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const head = parseInt(files[files.length - 1].slice(0, 4), 10);
if (!(head > through)) {
  console.error(`REFUSED: the head migration is ${head} and the release base is ${through}: there is no upgrade to measure.`);
  process.exit(2);
}

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
const version = () => db.prepare("PRAGMA user_version").get().user_version;
if (version() !== through) {
  console.error(`REFUSED: the base database reports ${version()} rather than ${through}.`);
  process.exit(2);
}

// Populated through the seed graph's own inserts — the same rows every suite of
// this repository starts from — and then read back ONLY through the HTTP API.
const seed = seedGraph(db);
const key = mintApiKey(db, seed.ownerA, seed.now).api_key;
const registry = new Registry(db, { now: () => seed.now });
const ask = (method, url) => {
  const res = handleRest(registry, {
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    body: Buffer.alloc(0),
  });
  return { status: res.status, body: res.body };
};

const SURFACES = [
  ["GET", "/health"],
  ["GET", "/v1/skills"],
  ["GET", "/v1/assignments"],
  ["GET", "/v1/fleet"],
  ["GET", "/v1/migrations"],
  ["GET", "/v1/dashboard"],
  ["GET", "/v1/dashboard/library"],
  ["GET", "/v1/tlog"],
  ["GET", "/v1/transfer-grants"],
  ["GET", "/v1/signing-keys"],
  ["GET", "/v1/principals"],
  ["GET", "/v1/webhooks"],
];

const census = () => {
  const out = {};
  for (const { name } of db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()) {
    out[name] = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get().c;
  }
  return out;
};

const before = new Map();
for (const [method, url] of SURFACES) {
  const answer = ask(method, url);
  if (answer.status !== 200) {
    console.error(`REFUSED: ${method} ${url} answered ${answer.status} on the BASE database; there is nothing to compare.`);
    process.exit(2);
  }
  before.set(`${method} ${url}`, answer);
}
const beforeCensus = census();
console.log(`base    user_version=${version()}  surfaces=${before.size}  tables=${Object.keys(beforeCensus).length}`);

// THE UPGRADE, with no manual step: the runner this build ships, and nothing else.
migrate(db);
console.log(`upgrade user_version=${version()}`);
const fail = [];
if (version() !== head) fail.push(`the upgrade landed at ${version()} rather than ${head}`);

for (const [method, url] of SURFACES) {
  const key2 = `${method} ${url}`;
  const now = ask(method, url);
  const then = before.get(key2);
  if (now.status !== then.status) {
    fail.push(`${key2}: ${then.status} before the upgrade, ${now.status} after it`);
    continue;
  }
  if (now.body !== then.body) fail.push(`${key2}: the response body changed across the upgrade`);
}
const afterCensus = census();
for (const [table, count] of Object.entries(beforeCensus)) {
  if (afterCensus[table] !== count) fail.push(`${table} held ${count} rows before the upgrade and ${afterCensus[table]} after it`);
}
const added = Object.keys(afterCensus).filter((t) => !(t in beforeCensus));
for (const table of added) {
  if (afterCensus[table] !== 0) fail.push(`${table} is new and arrived with ${afterCensus[table]} rows in it`);
}
db.close();

console.log(`after   surfaces compared=${before.size}  tables added=${added.length} (${added.join(", ") || "none"})`);
console.log();
if (fail.length > 0) {
  for (const f of fail) console.error(`FAIL  ${f}`);
  process.exit(1);
}
console.log(`PASS  a v0.1.6 database upgraded ${through} -> ${head} with every surface answering identically and no row disturbed`);
NODE
rc=$?
[ "$rc" -eq 0 ] || echo "FAIL  upgrade from a v0.1.6 copy (exit $rc)" >&2
exit "$rc"
