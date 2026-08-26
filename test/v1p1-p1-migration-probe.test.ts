// P1 — THE `0019` REBUILD, RUN AGAINST A FILLED DATABASE RATHER THAN DESCRIBED.
//
// WHY THIS FILE EXISTS.
//
//   P1 was not expected to introduce a migration, so the phase's frozen gate
//   list carried no migration gate. Then `0019` arrived, and it is not a
//   column addition: SQLite cannot relax a `CHECK` in place, so widening
//   `actor_role` means `console_tickets` and `owner_sessions` are WRITTEN
//   AGAIN — copied to a scratch table, DROPPED, re-created, refilled, with two
//   children holding `ON DELETE RESTRICT` against them across the drop. That is
//   the most dangerous single operation the phase performs, and P0 required a
//   row-loss / reopen / rollback / rerun probe for exactly this class of
//   change. This file is that probe for `0019`, and it is deliberately built
//   the way P0's is: a database at the version BEFORE the change, filled
//   through the SHIPPED surfaces, migrated with the SHIPPED runner, and then
//   asked the same questions afterwards.
//
// THE ASSERTION THIS FILE EXISTS FOR, AND WHY IT IS THE VALUABLE ONE.
//
//   `0019` deliberately does not use `ALTER TABLE … RENAME`. With
//   `PRAGMA foreign_keys=ON` — which this deployment always runs with — a
//   rename REWRITES the `REFERENCES` clause of every table that points at the
//   table being renamed. Rename `console_tickets` out of the way to make room
//   for a wider replacement and `console_ticket_uses` silently comes to
//   reference a scratch name that is about to be dropped: no error, no warning,
//   a foreign key pointing at nothing. The migration's author measured that
//   before choosing the copy → drop → re-create-under-the-original-name form,
//   and until now that measurement lived only in a report.
//
//   `[P1.M4]` makes it a standing test, and makes it TWO-SIDED in the P0
//   discrimination style, because an assertion that would be green either way
//   proves nothing. The counterfactual — the rename form — is run against the
//   same real schema and SHOWN to repoint the child; the shipped form is run
//   against the same database and shown not to. Anyone who later "simplifies"
//   `0019` into a rename gets a red test rather than silent corruption.
//
//   The comparison is over the WHOLE foreign-key graph, read back out of SQLite
//   with `PRAGMA foreign_key_list` rather than out of a list typed here, so a
//   table repointed anywhere in the schema fails this file — not only the two
//   children someone thought to name.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { openDb, openMigrated, openReadOnly, migrate } from "../src/db.ts";
import { migrationsDir } from "../src/assets.ts";
import { MIGRATION_STEPS } from "../src/migration-steps.ts";
import type { Db } from "../src/sqlite.ts";
import { mintConsoleTicket, openConsoleSession, revokeConsoleSession } from "../src/console-session.ts";
import { p4Fixture, publishedVersion, reviewedVersion, type P4Fixture } from "./p4-helpers.ts";
import { NOW } from "./p2-helpers.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_DIR = migrationsDir();
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

/** The migration under probe, found by its NAME rather than by its number.
 *  A number typed here would still be a number after someone renumbered the
 *  file, and this probe would then be measuring a different migration while
 *  staying green. */
const PROBE_FILE = MIGRATION_FILES.find((f) => f.endsWith("_a_reviewer_may_open_the_console.sql"));
if (PROBE_FILE === undefined) {
  throw new Error("the migration this file probes is not on disk under the name it was written with");
}
const TARGET_VERSION = parseInt(PROBE_FILE.slice(0, 4), 10);

/** The version the rebuild starts FROM: the highest migration below it. Derived
 *  for the reason above — a literal goes stale the moment the tree moves. */
const PRIOR_VERSION = Math.max(
  ...MIGRATION_FILES.map((f) => parseInt(f.slice(0, 4), 10)).filter((n) => n < TARGET_VERSION),
);

/** The two tables `0019` rebuilds. Named because the gate names them; every
 *  OTHER table this probe checks is derived from the schema, not from here. */
const REBUILT = ["console_tickets", "owner_sessions"] as const;

/** Where the P1 gate manifest expects this run's evidence. Written once, at the
 *  end, from the lines the probes recorded: a log assembled per-line by a run
 *  that then fails halfway is a log that claims more than the run proved. */
const EVIDENCE_LOG = join(REPO_ROOT, "evidence", "P1", "migration-0019-probe.log");
const probeLines: string[] = [];
function record(line: string): void {
  probeLines.push(line);
  console.log(line);
}

/**
 * A database stopped at an EARLIER schema version.
 *
 * The runner's loop is repeated here rather than parameterised in `src/db.ts`,
 * for the reason `test/v1p1-p0-probes.test.ts` gives and this file inherits: a
 * registry migrates forward to the build it IS, and a "stop at N" option on the
 * shipped runner would be a supported way to run a new binary against an old
 * schema. `[P1.M5]` compares what this produces against what the shipped runner
 * produces when it is not stopped, which is what keeps the duplicate honest.
 */
function databaseAtVersion(through: number, path?: string): Db {
  const db = openDb(path);
  for (const file of MIGRATION_FILES) {
    const n = parseInt(file.slice(0, 4), 10);
    if (n > through) break;
    db.exec("BEGIN");
    MIGRATION_STEPS[n]?.(db);
    db.exec(readFileSync(join(MIGRATION_DIR, file), "utf8"));
    db.exec(`PRAGMA user_version=${n}`);
    db.exec("COMMIT");
  }
  return db;
}

function userVersion(db: Db): number {
  return (db.prepare("PRAGMA user_version").get() as { user_version: number }).user_version;
}

function tableNames(db: Db): string[] {
  return (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
}

/** Every user table, and how many rows it holds. The whole census, not a
 *  sample: a rebuild that lost the rows of the one table nobody sampled is the
 *  defect this exists to make impossible. */
function census(db: Db): Record<string, number> {
  const out: Record<string, number> = {};
  for (const t of tableNames(db)) {
    out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${JSON.stringify(t)}`).get() as { c: number }).c;
  }
  return out;
}

/** The schema, object for object, normalised the way `sqlite_master` stores it. */
function schemaOf(db: Db): string[] {
  return (
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all() as Array<{ type: string; name: string; sql: string | null }>
  ).map((o) => `${o.type} ${o.name} ${o.sql === null ? "" : o.sql.replace(/\s+/g, " ").trim()}`);
}

/**
 * EVERY FOREIGN KEY IN THE SCHEMA, as SQLite itself resolves it.
 *
 * Read with `PRAGMA foreign_key_list` and not by grepping `sqlite_master`,
 * because what matters is the edge the ENGINE will enforce — the text is only
 * the engine's record of it, and a quoted or re-cased name reads differently
 * while meaning the same thing. `ON DELETE` travels with the edge, so a rebuild
 * that kept the target and dropped `RESTRICT` fails here too.
 */
function fkEdges(db: Db): string[] {
  const out: string[] = [];
  for (const t of tableNames(db)) {
    const rows = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all() as Array<{
      table: string;
      from: string;
      to: string | null;
      on_update: string;
      on_delete: string;
    }>;
    for (const r of rows) {
      out.push(`${t}.${r.from} -> ${r.table}.${r.to ?? "(rowid pk)"} ON UPDATE ${r.on_update} ON DELETE ${r.on_delete}`);
    }
  }
  return out.sort();
}

/** The tables holding a foreign key into `parent`, as the engine sees it. */
function childrenOf(db: Db, parent: string): string[] {
  const out: string[] = [];
  for (const t of tableNames(db)) {
    const rows = db.prepare(`PRAGMA foreign_key_list(${JSON.stringify(t)})`).all() as Array<{ table: string }>;
    if (rows.some((r) => r.table === parent)) out.push(t);
  }
  return out.sort();
}

/** Every row of a table, ordered and serialised, so "the rows are the same" is
 *  a comparison of CONTENT and not only of a count. A rebuild that refilled the
 *  right number of rows from the wrong columns passes a count and fails this. */
function rowsOf(db: Db, table: string): string[] {
  return (db.prepare(`SELECT * FROM ${JSON.stringify(table)}`).all() as Array<Record<string, unknown>>)
    .map((r) =>
      JSON.stringify(
        Object.keys(r)
          .sort()
          .map((k) => [k, r[k]]),
      ),
    )
    .sort();
}

interface Snapshot {
  uv: number;
  rows: Record<string, number>;
  schema: string[];
  fks: string[];
  rebuilt: Record<string, string[]>;
}

function snapshot(db: Db): Snapshot {
  const rebuilt: Record<string, string[]> = {};
  for (const t of REBUILT) rebuilt[t] = rowsOf(db, t);
  return { uv: userVersion(db), rows: census(db), schema: schemaOf(db), fks: fkEdges(db), rebuilt };
}

/**
 * A database at the version before the rebuild, WITH CONSOLE ROWS IN IT.
 *
 * Filled through the shipped surfaces — `p4Fixture` drives the same `Registry`
 * a deployment serves, and the console rows are written by `mintConsoleTicket`,
 * `openConsoleSession` and `revokeConsoleSession`, which are the functions the
 * routes call — rather than by hand-written INSERTs, because a hand-written row
 * is a row shaped the way the probe's author believed the product writes them.
 *
 * The content is chosen so that every table `0019` touches or points at is
 * NON-EMPTY: both rebuilt tables, and both children. A rebuild probed over
 * empty tables proves that nothing was lost from nothing.
 */
function consoleDeployment(db: Db): P4Fixture {
  const fx = p4Fixture({ db });

  // two roles the PRIOR schema admits, so the fixture is legal at that version
  for (const [auth, ttl] of [
    [fx.owner, 30 * 60 * 1000],
    [fx.admin, 15 * 60 * 1000],
  ] as const) {
    const ticket = mintConsoleTicket(db, auth, NOW);
    openConsoleSession(db, ticket.ticket, NOW, ttl);
  }
  // …a third session that is then revoked, so `owner_session_revocations` — the
  // other child holding RESTRICT across the drop — has a row too
  const doomed = mintConsoleTicket(db, fx.owner, NOW);
  const revoked = openConsoleSession(db, doomed.ticket, NOW);
  revokeConsoleSession(db, revoked.session_id, NOW + 1, "logout");

  // …and ordinary registry content, so the census is a census of a registry and
  // not of two console tables standing alone
  publishedVersion(fx, "p1-mig-published");
  reviewedVersion(fx, "p1-mig-reviewed");
  return fx;
}

let scratch: string;

test("[P1.M0] the migration under probe, the version it starts from, and the reversal it ships", () => {
  scratch = mkdtempSync(join(tmpdir(), "skln-p1mig-"));
  assert.equal(
    MIGRATION_FILES.filter((f) => f.endsWith("_a_reviewer_may_open_the_console.sql")).length,
    1,
    "exactly one migration widens the console's actor role; the set on disk says otherwise",
  );
  const downs = readdirSync(join(MIGRATION_DIR, "down"));
  const down = downs.find((f) => f.startsWith(`${String(TARGET_VERSION).padStart(4, "0")}_`) && f.endsWith(".down.sql"));
  assert.ok(down, `${TARGET_VERSION} ships no reversal, and the convention has been unbroken since 0013`);
  record(`[P1.M0] probing ${PROBE_FILE}: schema ${PRIOR_VERSION} -> ${TARGET_VERSION}`);
  record(`[P1.M0] reversal on disk: down/${down}`);
});

// ===========================================================================
// G-P1-19.1 — zero row loss across the rebuild
// ===========================================================================

test("[P1.M1] the rebuild loses NO row — every table counted before and after, and both rebuilt tables compared row for row", () => {
  const path = join(scratch, "p1-rowloss.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  assert.equal(userVersion(build), PRIOR_VERSION, "the fixture must start at the version before the rebuild");
  consoleDeployment(build);
  const before = snapshot(build);
  build.close();

  const db = openDb(path);
  migrate(db);
  assert.equal(userVersion(db), TARGET_VERSION);
  const after = snapshot(db);

  // THE WHOLE CENSUS, so a table added, dropped or emptied fails here — not a
  // loop over the few tables someone remembered to name.
  assert.deepEqual(after.rows, before.rows, "the rebuild changed a row count");

  // …and the two tables that were actually written again are compared by
  // CONTENT, which is the stronger question a count cannot answer.
  for (const t of REBUILT) {
    assert.deepEqual(after.rebuilt[t], before.rebuilt[t], `${t} came back from the rebuild with different rows`);
  }

  // Non-vacuity, stated as an assertion rather than trusted: every table the
  // rebuild touches or is pointed at BY must have held rows, or the three
  // deepEquals above compared nothing with nothing.
  const mustBeFilled = new Set<string>(REBUILT);
  for (const parent of REBUILT) for (const child of childrenOf(db, parent)) mustBeFilled.add(child);
  for (const t of [...mustBeFilled].sort()) {
    assert.ok((before.rows[t] ?? 0) > 0, `${t} was empty before the rebuild — this probe would prove nothing about it`);
  }
  const counts = [...mustBeFilled].sort().map((t) => `${t}=${before.rows[t]}`);
  db.close();

  const total = Object.values(before.rows).reduce((a, b) => a + b, 0);
  record(`[P1.M1] ${Object.keys(before.rows).length} tables, ${total} rows, unchanged across ${TARGET_VERSION}`);
  record(`[P1.M1] rebuilt and referencing tables, all non-empty and row-identical: ${counts.join(", ")}`);
});

// ===========================================================================
// G-P1-19.2 — it reopens through the normal open path
// ===========================================================================

test("[P1.M2] the rebuilt database REOPENS through the normal open path, twice", () => {
  const path = join(scratch, "p1-reopen.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  consoleDeployment(build);
  build.close();

  const first = openMigrated(path);
  assert.equal(userVersion(first), TARGET_VERSION);
  first.close();

  // The normal path, twice: a schema that only opens once is a schema whose
  // migration left something the second open trips over.
  const second = openMigrated(path);
  assert.equal(userVersion(second), TARGET_VERSION);

  // …and the widening the rebuild exists for actually took, so this file is
  // probing a migration that DID something. The third role is storable now, and
  // the prior schema is on record above as one that could not hold it.
  const fx = p4Fixture({ db: second });
  const ticket = mintConsoleTicket(second, fx.reviewer, NOW);
  const session = openConsoleSession(second, ticket.ticket, NOW);
  assert.equal(session.actor_role, "reviewer");
  second.close();
  record(`[P1.M2] reopened twice through openMigrated, and a reviewer session opens on the reopened database`);
});

// ===========================================================================
// G-P1-19.3 — foreign_key_check and integrity_check are clean afterwards
// ===========================================================================

test("[P1.M3] `foreign_key_check` and `integrity_check` are clean after the rebuild", () => {
  const path = join(scratch, "p1-integrity.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  consoleDeployment(build);
  build.close();

  const db = openMigrated(path);
  assert.deepEqual(
    db.prepare("PRAGMA foreign_key_check").all() as unknown[],
    [],
    "the rebuilt database has a dangling reference — a child holds a value no parent row has",
  );
  assert.deepEqual(
    (db.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check),
    ["ok"],
  );
  db.close();
  record(`[P1.M3] foreign_key_check clean, integrity_check ok`);
  // What these two pragmas do NOT answer is the subject of `[P1.M4]`, and that
  // is not a remark — it is measured there.
});

// ===========================================================================
// G-P1-19.4 — NO CHILD WAS SILENTLY REPOINTED. The assertion this file is for.
// ===========================================================================

/** Every child of every rebuilt table still names its ORIGINAL parent — in the
 *  edge SQLite resolves and in the text SQLite kept — and no scratch name
 *  survives anywhere in the schema. Written once because it is asserted against
 *  two databases, and returned so the caller can say which children it saw. */
function assertNothingRepointed(db: Db, priorEdges: string[]): string[] {
  // EVERY EDGE IN THE SCHEMA, unchanged. `0019` widens two CHECKs and touches no
  // foreign key, so the graph the engine enforces afterwards is the graph it
  // enforced before — target table, target column and `ON DELETE` alike. A
  // table repointed ANYWHERE fails here, not only the two someone named.
  assert.deepEqual(
    fkEdges(db),
    priorEdges,
    "a foreign key changed across the rebuild — some table now points somewhere else",
  );

  const children: string[] = [];
  for (const parent of REBUILT) {
    const kids = childrenOf(db, parent);
    assert.ok(kids.length > 0, `${parent} has no child in this schema — the repointing assertion would be vacuous`);
    for (const child of kids) {
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name=?").get(child) as { sql: string }).sql;
      // the text SQLite kept, as well as the edge it resolved: a rename rewrites
      // exactly this clause, and it is what a human reads when they open the
      // schema
      assert.match(
        sql.replace(/"/g, ""),
        new RegExp(`REFERENCES\\s+${parent}\\s*\\(`),
        `${child} no longer names ${parent} in its REFERENCES clause`,
      );
      children.push(`${child} -> ${parent}`);
    }
  }

  // …and NOTHING anywhere in the schema mentions a scratch table. The migration
  // creates `mig0019_*` and drops it; a name that outlived the migration, in a
  // REFERENCES clause or as a table, is the corruption this probe is about.
  for (const line of schemaOf(db)) {
    assert.equal(/mig\d{4}/i.test(line), false, `a scratch table name survived the migration: ${line}`);
  }
  // …stated once more over the object list itself, so a leftover scratch TABLE
  // holding a copy of the rows fails even if no clause names it.
  assert.deepEqual(tableNames(db).filter((t) => /^mig\d{4}/i.test(t)), [], "the migration left a scratch table behind");
  return children;
}

test("[P1.M4] no child is repointed — the whole foreign-key graph survives, and the rename form is SHOWN to break it", () => {
  // ------------------------------------------------- the EMPTY database FIRST
  //
  // THE CASE THAT MATTERS MOST IS THE EMPTY ONE, and it is the one a probe
  // written only around a filled fixture would miss — so it is asserted first,
  // before anything that could fail earlier for a louder reason.
  //
  // A repointed child whose table HOLDS ROWS trips `ON DELETE RESTRICT` at
  // COMMIT and the migration dies — unpleasant, but loud, and no data is lost.
  // A repointed child whose table is EMPTY has no row to violate anything: the
  // migration commits, `foreign_key_check` is clean, `integrity_check` says
  // `ok`, and the schema is silently wrong from that moment on. Every
  // deployment upgrading without having opened the console yet is in exactly
  // that state, which makes the silent case the COMMON one rather than the
  // exotic one. The counterfactual at the bottom of this test measures all
  // three of those claims rather than asserting them.
  const freshBefore = (() => {
    const f = databaseAtVersion(PRIOR_VERSION);
    p4Fixture({ db: f });
    const s = { fks: fkEdges(f), empty: REBUILT.every((t) => census(f)[t] === 0) };
    f.close();
    return s;
  })();
  assert.equal(freshBefore.empty, true, "the fresh fixture already holds console rows — it is not the empty case");

  const fresh = databaseAtVersion(PRIOR_VERSION);
  p4Fixture({ db: fresh });
  migrate(fresh);
  assert.equal(userVersion(fresh), TARGET_VERSION);
  assertNothingRepointed(fresh, freshBefore.fks);
  fresh.close();

  // ------------------------------------------------- and on a FILLED database
  const path = join(scratch, "p1-references.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  consoleDeployment(build);
  const before = { fks: fkEdges(build), schema: schemaOf(build) };
  build.close();

  const db = openDb(path);
  migrate(db);
  assert.equal(userVersion(db), TARGET_VERSION);
  const children = assertNothingRepointed(db, before.fks);
  db.close();

  // ------------------------------------------------------- the counterfactual
  //
  // AND NOW THE HALF THAT MAKES ALL OF THE ABOVE MEAN SOMETHING. Every
  // assertion so far would also be green against a `0019` that never ran at
  // all. What has to be shown is that the form `0019` REJECTED does break them
  // — that the rule is load-bearing and not a description of a thing that could
  // not have gone wrong.
  //
  // So the rejected form is BUILT FROM THE SHIPPED FILE and run: the copy/drop
  // pair each table is rebuilt through is replaced by the rename that is the
  // obvious "simplification" of this migration, and the one a later reader will
  // reach for. Deriving it from the shipped text rather than typing it out is
  // what keeps the counterfactual about THIS migration: if `0019` is rewritten
  // into a shape the substitution no longer finds, this fails rather than
  // quietly comparing the shipped form against a stale imitation.
  const counterfactual = (() => {
    const prefix = `mig${String(TARGET_VERSION).padStart(4, "0")}_`;
    let sql = readFileSync(join(MIGRATION_DIR, PROBE_FILE), "utf8");
    for (const t of REBUILT) {
      const shipped = `CREATE TABLE ${prefix}${t} AS SELECT * FROM ${t};\nDROP TABLE ${t};`;
      assert.ok(
        sql.includes(shipped),
        `${PROBE_FILE} no longer rebuilds ${t} by copy-and-drop, so the counterfactual below is not its alternative`,
      );
      sql = sql.replace(shipped, `ALTER TABLE ${t} RENAME TO ${prefix}${t};`);
    }
    return sql;
  })();

  const broken = databaseAtVersion(PRIOR_VERSION);
  p4Fixture({ db: broken });
  broken.exec("BEGIN");
  broken.exec(counterfactual);
  broken.exec(`PRAGMA user_version=${TARGET_VERSION}`);
  // IT COMMITS. That is the finding, not an aside: nothing in SQLite objects.
  broken.exec("COMMIT");

  // …and the two checks an operator would reach for to confirm the upgrade are
  // BLIND to what just happened. This is measured rather than asserted in prose,
  // because it is the whole reason `[P1.M3]` is not sufficient on its own.
  assert.deepEqual(broken.prepare("PRAGMA foreign_key_check").all() as unknown[], []);
  assert.deepEqual(
    (broken.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map(
      (r) => r.integrity_check,
    ),
    ["ok"],
  );

  // …while the child now references a table that DOES NOT EXIST.
  const scratchName = `mig${String(TARGET_VERSION).padStart(4, "0")}_console_tickets`;
  assert.deepEqual(
    childrenOf(broken, scratchName),
    ["console_ticket_uses"],
    "the rename form did not repoint console_ticket_uses; this runtime's SQLite does not rewrite REFERENCES " +
      "on rename, so the assertions above no longer discriminate and must be rewritten rather than trusted",
  );
  const brokenSql = (
    broken.prepare("SELECT sql FROM sqlite_master WHERE name='console_ticket_uses'").get() as { sql: string }
  ).sql;
  assert.match(brokenSql.replace(/"/g, ""), new RegExp(`REFERENCES\\s+${scratchName}\\s*\\(`));
  assert.equal(
    tableNames(broken).includes(scratchName),
    false,
    "the counterfactual's scratch table still exists, so the reference it left behind resolves after all",
  );
  // and the assertion this test is built on is the one that catches it
  assert.notDeepEqual(fkEdges(broken), freshBefore.fks, "the foreign-key comparison did not notice the repointing");
  broken.close();

  record(`[P1.M4] ${before.fks.length} foreign keys, every one unchanged across the rebuild`);
  record(`[P1.M4] children still naming their original parent: ${children.join(", ")}`);
  record(`[P1.M4] asserted on a FILLED database and on a FRESH one whose console tables are empty`);
  record(
    `[P1.MD] counterfactual: the same migration written with ALTER TABLE ... RENAME COMMITS on an empty database, ` +
      `foreign_key_check clean and integrity_check ok, while console_ticket_uses is left REFERENCING ` +
      `${scratchName}, a table that no longer exists. The shipped copy/drop/re-create form leaves it naming ` +
      `console_tickets. The foreign-key-graph comparison is what tells the two apart.`,
  );
});

// ===========================================================================
// G-P1-19.5 — re-running the runner is a noop
// ===========================================================================

test("[P1.M5] re-running the shipped runner is a NOOP, and the stepped build equals the shipped one", () => {
  const path = join(scratch, "p1-idempotent.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  consoleDeployment(build);
  build.close();

  const db = openDb(path);
  migrate(db);
  const afterFirst = snapshot(db);
  migrate(db);
  const afterSecond = snapshot(db);
  db.close();
  assert.deepEqual(afterSecond, afterFirst, "a second run of the migration runner changed something");
  assert.equal(afterFirst.uv, TARGET_VERSION);

  // …and the stepped loop this file repeats produces the same schema the
  // shipped runner does when it is not stopped short. Without this the
  // duplicate could drift and every probe built on it would be measuring a
  // schema no deployment has.
  const stepped = databaseAtVersion(TARGET_VERSION);
  const shipped = openMigrated();
  assert.deepEqual(schemaOf(stepped), schemaOf(shipped), "the stepped build and the shipped runner disagree");
  assert.equal(userVersion(stepped), userVersion(shipped));
  stepped.close();
  shipped.close();
  record(`[P1.M5] second run changed nothing; stepped build at ${TARGET_VERSION} is the shipped runner's schema`);
});

// ===========================================================================
// G-P1-19.6 — the reversal restores the prior shape, and converges
// ===========================================================================

test("[P1.M6] the reversal restores the PRIOR object shape, is convergent, and refuses rather than deleting evidence", () => {
  const path = join(scratch, "p1-reversal.db");
  const build = databaseAtVersion(PRIOR_VERSION, path);
  consoleDeployment(build);
  const before = { schema: schemaOf(build), rows: census(build), fks: fkEdges(build) };
  build.close();

  const downName = readdirSync(join(MIGRATION_DIR, "down")).find(
    (f) => f.startsWith(`${String(TARGET_VERSION).padStart(4, "0")}_`) && f.endsWith(".down.sql"),
  );
  assert.ok(downName);
  const downSql = readFileSync(join(MIGRATION_DIR, "down", downName), "utf8");

  const db = openMigrated(path);
  assert.equal(userVersion(db), TARGET_VERSION);

  // one transaction per reversal, exactly as the runner applies them forwards
  const walkBack = (): void => {
    db.exec("BEGIN");
    try {
      db.exec(downSql);
      db.exec("COMMIT");
    } catch (e) {
      db.exec("ROLLBACK");
      throw e;
    }
  };

  walkBack();
  assert.equal(userVersion(db), PRIOR_VERSION);
  assert.deepEqual(schemaOf(db), before.schema, "the reversal did not restore the prior schema object for object");
  assert.deepEqual(census(db), before.rows, "the reversal changed a row count — it must write no data either");
  assert.deepEqual(fkEdges(db), before.fks, "the reversal moved a foreign key");

  // CONVERGENT: a reversal may be run against a database that never reached this
  // version, and refusing that is a worse answer than converging. Running it
  // twice is how that is asked.
  walkBack();
  assert.equal(userVersion(db), PRIOR_VERSION);
  assert.deepEqual(schemaOf(db), before.schema, "a second reversal walk changed the schema");
  assert.deepEqual(census(db), before.rows, "a second reversal walk changed a row count");

  // …AND THE ONE THING IT MUST NOT DO. A narrower CHECK cannot hold a row a
  // wider one accepted. Once a reviewer has opened a console, the reversal's
  // two available answers are to DELETE that record or to STOP — and deleting
  // who was admitted to the console and when is exactly the evidence this
  // registry does not rewrite. So it must fail, and failing must leave the
  // database where it was found.
  migrate(db);
  assert.equal(userVersion(db), TARGET_VERSION);
  const fx = p4Fixture({ db });
  const ticket = mintConsoleTicket(db, fx.reviewer, NOW);
  const reviewerSession = openConsoleSession(db, ticket.ticket, NOW);
  const withReviewer = snapshot(db);
  assert.throws(walkBack, /CHECK|constraint/i, "the reversal accepted a reviewer row a narrower CHECK cannot hold");
  assert.deepEqual(snapshot(db), withReviewer, "a refused reversal left the database changed");
  assert.equal(
    (
      db.prepare("SELECT actor_role FROM owner_sessions WHERE id=?").get(reviewerSession.session_id) as {
        actor_role: string;
      }
    ).actor_role,
    "reviewer",
    "the refused reversal destroyed the record it refused to narrow",
  );
  db.close();
  record(`[P1.M6] reversal restores schema ${PRIOR_VERSION} object for object, and a second walk changes nothing`);
  record(`[P1.M6] with a reviewer session present the reversal REFUSES and rolls back, leaving the row intact`);
});

// ===========================================================================
// G-P1-19.7 — the rollback target survives
// ===========================================================================

test("[P1.M7] the migration runs on a COPY, and the pre-migration original stays openable", () => {
  const original = join(scratch, "p1-original.db");
  const build = databaseAtVersion(PRIOR_VERSION, original);
  consoleDeployment(build);
  const before = census(build);
  build.close();

  const copy = join(scratch, "p1-copy.db");
  copyFileSync(original, copy);
  const upgraded = openMigrated(copy);
  assert.equal(userVersion(upgraded), TARGET_VERSION);
  upgraded.close();

  // THE ROLLBACK TARGET SURVIVES. This is the half the documented rollback
  // procedure depends on: the copy taken before the migration must still be a
  // database the previous build can serve. `openReadOnly` does not migrate,
  // deliberately, so it opens the original as the older build would find it.
  const rollbackTarget = openReadOnly(original);
  assert.equal(
    userVersion(rollbackTarget),
    PRIOR_VERSION,
    "the original was migrated in place — it is not a rollback target",
  );
  assert.deepEqual(census(rollbackTarget), before, "the rollback target lost rows while the copy was migrated");
  const roles = (
    rollbackTarget.prepare("SELECT actor_role FROM owner_sessions ORDER BY id").all() as Array<{ actor_role: string }>
  ).map((r) => r.actor_role);
  assert.ok(roles.length >= 3, "the rollback target lost its console sessions");
  assert.deepEqual(
    [...new Set(roles)].sort(),
    ["admin", "owner"],
    "the rollback target holds a role the version it is at does not admit",
  );
  rollbackTarget.close();
  record(
    `[P1.M7] copy migrated to ${TARGET_VERSION}; original still at ${PRIOR_VERSION}, openable read-only, ` +
      `${roles.length} console sessions intact`,
  );
});

test("[P1.MZ] the probe log is written where the gate manifest expects it", () => {
  mkdirSync(dirname(EVIDENCE_LOG), { recursive: true });
  const body = probeLines.join("\n") + "\n";
  writeFileSync(EVIDENCE_LOG, body, "utf8");
  const written = readFileSync(EVIDENCE_LOG, "utf8");
  // the discrimination result must be IN the artifact, not only on the terminal
  assert.ok(written.includes("[P1.MD]"), "the counterfactual result is missing from the probe log");
  for (const tag of ["[P1.M0]", "[P1.M1]", "[P1.M2]", "[P1.M3]", "[P1.M4]", "[P1.M5]", "[P1.M6]", "[P1.M7]"]) {
    assert.ok(written.includes(tag), `the probe log is missing ${tag}`);
  }
  assert.equal(written.includes("\u0000"), false, "the probe log carries a NUL byte");
  rmSync(scratch, { recursive: true, force: true });
});
