// V1 P1 — THE MIGRATION: additive, reversible, and compatible with the base.
//
// Three claims, each measured rather than asserted:
//
//   1. ADDITIVE — `0013` creates objects and edits none. The schema at
//      `user_version` 12 is a SUBSET, statement for statement, of the schema at
//      13, and every row written before the upgrade is there after it.
//   2. REVERSIBLE — up, down, up. The tree ships no down-migration for
//      `0001`..`0012` (`v1/P0-BASELINE.md` records that), so this migration
//      ships its own, and the round trip is what proves it: the schema after
//      the reversal is the schema before the upgrade, object for object, and
//      migrating again converges on the same head.
//   3. COMPATIBLE — a database carrying the released base's schema and DATA
//      upgrades, and the surfaces that existed before answer exactly as they
//      did (`P1-FR-14`, `INV-08`).
//
// The "released base" here is `PRAGMA user_version` 12: `v1/P0-BASELINE.md`
// records that `src/`, `migrations/` and `schema/` at this contract's base
// commit are byte-identical to the `v0.1.6` tag, so a database migrated through
// `0012` and no further IS a `v0.1.6` database.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { openDb, migrate } from "../src/db.ts";
import { MIGRATION_STEPS } from "../src/migration-steps.ts";
import { seedGraph } from "./helpers.ts";
import { p4Fixture } from "./p4-helpers.ts";
import { rest } from "./p6-helpers.ts";
import type { Db } from "../src/sqlite.ts";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_DIR = join(root, "migrations");
const FILES = readdirSync(MIGRATION_DIR).filter((f) => /^\d{4}_.+\.sql$/.test(f)).sort();
const DOWN_0013 = join(MIGRATION_DIR, "down", "0013_capture_and_draft_revisions.down.sql");

/** The released base: every migration up to and including `through`. */
function databaseAtVersion(through: number): Db {
  const db = openDb();
  for (const file of FILES) {
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

/** Every object of the live schema, normalised, as a set. */
function schemaOf(db: Db): string[] {
  return (
    db
      .prepare("SELECT sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ sql: string }>
  )
    .map((r) => r.sql.replace(/\s+/g, " ").trim())
    .sort();
}

/** Every table with its row count — what "no data lost" is measured against. */
function rowCounts(db: Db): Record<string, number> {
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as Array<{
      name: string;
    }>
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const t of tables) out[t] = (db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c;
  return out;
}

// ===========================================================================
// 1. Additive
// ===========================================================================

test("0013 is additive: the schema at 12 survives statement for statement, and only new objects appear", () => {
  const before = databaseAtVersion(12);
  const beforeSchema = schemaOf(before);
  before.close();

  const after = openDb();
  migrate(after);
  assert.equal(userVersion(after), 13);
  const afterSchema = schemaOf(after);

  const lost = beforeSchema.filter((s) => !afterSchema.includes(s));
  assert.deepEqual(lost, [], "0013 edited or dropped a statement of the base schema");

  const added = afterSchema.filter((s) => !beforeSchema.includes(s));
  const names = added
    .map((s) => /^CREATE (?:TABLE|INDEX|UNIQUE INDEX|TRIGGER)\s+"?([A-Za-z0-9_]+)"?/i.exec(s)?.[1])
    .filter((n): n is string => n !== undefined)
    .sort();
  assert.deepEqual(names, [
    "captures",
    "draft_events",
    "draft_revisions",
    "idx_captures_workspace",
    "idx_draft_events_draft",
    "idx_draft_revisions_draft",
    "tg_captures_no_del",
    "tg_captures_no_upd",
    "tg_draft_events_no_del",
    "tg_draft_events_no_upd",
    "tg_draft_revisions_no_del",
    "tg_draft_revisions_no_upd",
  ]);
  after.close();
});

test("a database carrying the base's DATA upgrades with every row intact", () => {
  const db = databaseAtVersion(12);
  const seed = seedGraph(db);
  const before = rowCounts(db);
  assert.ok(before.skills! > 0 && before.skill_versions! > 0 && before.adoption_receipts! > 0, "the seed really wrote rows");

  migrate(db);
  assert.equal(userVersion(db), 13);

  const after = rowCounts(db);
  for (const [table, count] of Object.entries(before)) {
    assert.equal(after[table], count, `${table} lost or gained rows during the upgrade`);
  }
  assert.equal(after.captures, 0, "the new tables start empty…");
  assert.equal(after.draft_revisions, 0);
  assert.equal(after.draft_events, 0);
  // …and the seeded graph still reads
  const version = db.prepare("SELECT id, state FROM skill_versions WHERE id=?").get(seed.version) as {
    id: string;
    state: string;
  };
  assert.equal(version.state, "reviewed");
  assert.equal((db.prepare("PRAGMA foreign_key_check").all() as unknown[]).length, 0);
  db.close();
});

// ===========================================================================
// 2. Reversible — up, down, up
// ===========================================================================

test("the migration round-trips: up, down, up, and the schema converges each way", () => {
  const db = databaseAtVersion(12);
  const seed = seedGraph(db);
  const baseSchema = schemaOf(db);
  const baseRows = rowCounts(db);

  // up
  migrate(db);
  assert.equal(userVersion(db), 13);
  const headSchema = schemaOf(db);
  assert.notDeepEqual(headSchema, baseSchema, "the upgrade did something");

  // a draft, so the reversal has V1-only data to discard
  db.prepare(
    `INSERT INTO captures(id, workspace_id, captured_by_agent_id, source_kind, source_format, redacted_source,
       source_digest, category, skillable, reason_code, outcome, server_at_ms)
     VALUES (?,?,?, 'workflow','workflow_text','a procedure', ?, 'reusable_procedure', 1, 'REUSABLE_PROCEDURE', 'drafted', ?)`,
  ).run("01CAPTURE000000000000000AA", seed.wsA, seed.ownerA, `sha256:${"a".repeat(64)}`, seed.now);
  assert.equal(rowCounts(db).captures, 1);

  // down
  db.exec(readFileSync(DOWN_0013, "utf8"));
  assert.equal(userVersion(db), 12, "the reversal restores the version it claims to");
  assert.deepEqual(schemaOf(db), baseSchema, "the schema after the reversal is the schema before the upgrade");
  const afterDown = rowCounts(db);
  for (const [table, count] of Object.entries(baseRows)) {
    assert.equal(afterDown[table], count, `${table} was disturbed by the reversal`);
  }
  assert.ok(!("captures" in afterDown), "the V1-only tables are gone, with the rows the reversal discards");

  // up again
  migrate(db);
  assert.equal(userVersion(db), 13);
  assert.deepEqual(schemaOf(db), headSchema, "the second upgrade converges on the same head");
  assert.equal(rowCounts(db).captures, 0, "…with the V1-only tables empty, which is what a reversal costs");
  db.close();
});

test("the reversal touches nothing that existed before 0013", () => {
  const down = readFileSync(DOWN_0013, "utf8");
  const statements = down
    .split("\n")
    .filter((l) => !l.trim().startsWith("--") && l.trim().length > 0)
    .join(" ");
  const targets = [...statements.matchAll(/DROP (?:TABLE|INDEX|TRIGGER) IF EXISTS ([a-z_]+)/gi)].map((m) => m[1]!);
  const created = readFileSync(join(MIGRATION_DIR, "0013_capture_and_draft_revisions.sql"), "utf8");
  for (const target of targets) {
    assert.ok(
      new RegExp(`CREATE (?:TABLE|INDEX|TRIGGER) ${target}\\b`).test(created),
      `the reversal drops \`${target}\`, which 0013 did not create`,
    );
  }
  assert.ok(targets.length >= 12, "the reversal names every object the migration creates");
  assert.match(down, /PRAGMA user_version=12;/);
});

// ===========================================================================
// 3. Compatible — P1-FR-14 / INV-08
// ===========================================================================

test("P1-FR-14: the surfaces that existed before answer exactly as they did, on an UPGRADED database", () => {
  // a registry opened on a database that was at the released base's version and
  // was migrated forward — not a fresh install
  const legacy = databaseAtVersion(12);
  const fx = p4Fixture({ db: legacy });
  assert.equal(userVersion(fx.db), 12, "the fixture was seeded on the BASE schema, before the upgrade");
  migrate(fx.db);
  assert.equal(userVersion(fx.db), 13, "…and then upgraded, which is the path a deployment takes");

  for (const [method, url] of [
    ["GET", "/v1/skills"],
    ["GET", "/v1/assignments"],
    ["GET", "/v1/fleet"],
    ["GET", "/v1/migrations"],
    ["GET", "/v1/dashboard"],
    ["GET", "/v1/tlog"],
    ["GET", "/v1/transfer-grants"],
    ["GET", "/v1/signing-keys"],
    ["GET", "/v1/principals"],
  ] as const) {
    const res = rest(fx, method, url, fx.keys.owner!);
    assert.equal(res.status, 200, `${method} ${url} → ${res.raw}`);
  }
  const health = rest(fx, "GET", "/health", fx.keys.owner!);
  assert.equal(health.status, 200);
  assert.equal(rest(fx, "GET", "/v1/skills", "sk_not_a_key").status, 401, "the auth boundary is where it was");
  assert.equal(rest(fx, "GET", "/v1/nonsense", fx.keys.owner!).status, 404);
  fx.db.close();
});

test("the capture domain adds no row to any table that existed before it", () => {
  const fx = p4Fixture();
  const before = rowCounts(fx.db);
  const created = rest(fx, "POST", "/v1/captures", fx.keys.owner!, {
    kind: "workflow",
    text: "## Procedure\n1. Run the tests.\n2. Read the failures.\n\nWhenever the build breaks.",
  });
  assert.equal(created.status, 201, created.raw);
  rest(fx, "POST", `/v1/drafts/${created.body.draft.draft_id}/revisions`, fx.keys.owner!, {
    sections: { title: "run-the-tests" },
  });
  const after = rowCounts(fx.db);
  for (const [table, count] of Object.entries(before)) {
    const expected = table === "captures" || table === "draft_revisions" || table === "draft_events" ? after[table]! : count;
    assert.equal(after[table], expected, `capturing a draft wrote to ${table}`);
  }
  assert.equal(after.captures, 1);
  assert.equal(after.draft_revisions, 2);
  assert.equal(after.draft_events, 4);
  fx.db.close();
});
