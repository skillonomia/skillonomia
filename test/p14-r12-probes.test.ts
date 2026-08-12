// ROUND 12 — THE RULE THAT DECIDED BY FORM, REMOVED RATHER THAN REPAIRED.
//
// WHAT ROUND 11 LEFT, AND WHY IT COULD NOT BE PATCHED.
//
//   `0011` converted `receipt_events.idempotency_key` to a digest on the rows an
//   older build wrote, and it decided WHICH rows to convert BY THE FORM OF THE
//   VALUE: a string of the shape `sha256:<64 lowercase hex>` was taken to be a
//   digest already and carried across; everything else was hashed. Nothing in a
//   row records which build wrote it, so that rule is a guess, and a reviewer
//   drove the guess into a wall through the shipped surfaces of the base build:
//   one receipt, two events, the first keyed `collision-pair-key` and the second
//   keyed with the LITERAL DIGEST OF THE FIRST. Both were accepted. `0011` then
//   hashed the first — making it equal to the second — and carried the second
//   across, and the two rows collided on
//   `UNIQUE(adoption_receipt_id, idempotency_key)`. The migration aborts, the
//   transaction rolls back, `PRAGMA user_version` stays at 10, AND THE UPGRADE
//   CAN NEVER COMPLETE. Everything in that sentence is inside the V-1 threat
//   model [D-21]: an agent controls its own requests through the standard API
//   and nothing else.
//
//   There is no third value to inspect. The form of a key cannot say which build
//   wrote the row, because the row does not contain that fact. So the rule goes,
//   not the guess inside it.
//
// WHAT THIS ROUND DOES, IN THREE MOVES.
//
//   1. `0012` HASHES EVERY NON-EMPTY KEY, with no test of form anywhere. No
//      test, no ambiguity, no collision: two different strings have two
//      different digests, whatever either of them looks like.
//
//   2. AN UPGRADE FROM `user_version` 10 IS REFUSED, by name and with its
//      reason. Round 10's build hashed on the way in and shipped no migration,
//      so a database left at 10 may hold digests, may hold the older build's raw
//      keys, and may hold both — and hashing a digest a second time gives a
//      well-formed value no reader computes. Round 10 was an intermediate
//      development commit of this tree and was never released or deployed; the
//      supported upgrade path is `user_version` 9 or below, and that is written
//      into the shipped documents rather than left to be discovered.
//
//   3. A KEY OF THE STORED FORM IS REFUSED ON THE WAY IN, on every surface that
//      accepts one, so that no row this registry writes from here on can be
//      ambiguous about which it is. It is refused as the key of a NEW record:
//      the one thing it may still do is repeat a record that already exists,
//      which creates nothing and is what an adopter of the base build is owed.
//
// THE PROBES BELOW WERE WRITTEN FROM THAT REQUIREMENT AND COMMITTED RED [D-16].
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { fileURLToPath } from "node:url";

import { openDb, openMigrated, migrate, UNSUPPORTED_UPGRADE_FROM } from "../src/db.ts";
import { migrationsDir } from "../src/assets.ts";
import type { Db } from "../src/sqlite.ts";
import { correlationDigest, surveyJournalIntake } from "../src/journal.ts";
import { MIGRATION_STEPS } from "../src/migration-steps.ts";
import { STORED_KEY_FORM } from "../src/idempotency.ts";
import { EVIDENCE_DIGEST } from "../src/outcome.ts";
import { MCP_TOOLS } from "../src/mcp.ts";
import { mintApiKey } from "../src/auth.ts";
import { ulid } from "../src/ulid.ts";
import { seedGraph, insertReceiptEvent } from "./helpers.ts";
import { p4Fixture, reviewedVersion, rest, mcp, adoptThroughSurfaces, NOW, type P4Fixture } from "./p6-helpers.ts";

const REPO_ROOT = fileURLToPath(new URL("../", import.meta.url));
const MIGRATION_DIR = migrationsDir();
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const LATEST = MIGRATION_FILES.length === 0 ? 0 : parseInt(MIGRATION_FILES[MIGRATION_FILES.length - 1]!.slice(0, 4), 10);

/**
 * A database as the build that shipped migration `through` left it.
 *
 * The loop of `migrate` without its refusal and without its stop, for the same
 * reason `[11.x]` gives: the shipped runner migrates forward to the build it is,
 * and a parameter that let it stop short would be a way to run a new binary
 * against an old schema.
 */
function databaseAtVersion(through: number): Db {
  const db = openDb();
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

function keys(db: Db): string[] {
  return (db.prepare("SELECT idempotency_key AS k FROM receipt_events ORDER BY id").all() as Array<{ k: string }>).map(
    (r) => r.k,
  );
}

function nextSeq(db: Db, receiptId: string): number {
  const row = db
    .prepare("SELECT COALESCE(MAX(event_seq),0) AS m FROM receipt_events WHERE adoption_receipt_id=?")
    .get(receiptId) as { m: number };
  return row.m + 1;
}

/**
 * THE COMPLETE DEFINITION of `receipt_events` — every statement, every column,
 * every index with its columns and its uniqueness, every foreign key, every
 * trigger — read from the database and not from the file that was meant to
 * build it.
 */
function receiptEventsDefinition(db: Db): unknown {
  const objects = db
    .prepare(
      `SELECT type, name, sql FROM sqlite_master
        WHERE tbl_name='receipt_events' AND name NOT LIKE 'sqlite_stat%'
        ORDER BY type, name`,
    )
    .all() as Array<{ type: string; name: string; sql: string | null }>;
  const indexes = (db.prepare("PRAGMA index_list(receipt_events)").all() as Array<Record<string, unknown>>)
    .map((i) => ({
      name: String(i.name),
      unique: Number(i.unique),
      origin: String(i.origin),
      partial: Number(i.partial),
      columns: (db.prepare(`PRAGMA index_info(${JSON.stringify(String(i.name))})`).all() as Array<Record<string, unknown>>)
        .map((c) => ({ seqno: Number(c.seqno), cid: Number(c.cid), name: c.name === null ? null : String(c.name) })),
    }))
    .sort((a, b) => (a.name < b.name ? -1 : 1));
  return {
    objects: objects.map((o) => ({ type: o.type, name: o.name, sql: o.sql === null ? null : o.sql.replace(/\s+/g, " ").trim() })),
    columns: db.prepare("PRAGMA table_info(receipt_events)").all(),
    indexes,
    foreignKeys: db.prepare("PRAGMA foreign_key_list(receipt_events)").all(),
  };
}

/**
 * REST over a database that has ALREADY been migrated, with the API key of the
 * legacy receipt's own adopter.
 *
 * A legacy database is filled the way the older build filled it — the statement
 * `6303814` issued, which put the adopter's string into the column verbatim —
 * and this build's surfaces are driven only AFTER the upgrade. That order is not
 * decoration: a row THIS build writes into a database it has not yet migrated is
 * a row no deployment can hold, because `migrate()` runs before the first
 * request is served, and a probe that manufactured one would be measuring its
 * own scaffolding.
 */
function anotherReceipt(db: Db, seed: ReturnType<typeof seedGraph>, nth: number): string {
  const request = ulid(seed.now + nth);
  db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  ).run(request, seed.version, seed.adopterA, seed.now);
  const receipt = ulid(seed.now + nth);
  db.prepare(
    "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
  ).run(receipt, request, seed.version, seed.adopterA, seed.now);
  return receipt;
}

function restOverMigrated(db: Db, adopterAgentId: string): { fx: P4Fixture; key: string } {
  const fx = p4Fixture({ db, rateLimit: { capacity: 10_000, refillPerSec: 10_000 } });
  return { fx, key: mintApiKey(db, adopterAgentId, NOW).api_key };
}

// ===========================================================================
// [12.1] THE COLLISION, AND THE END OF IT.
//
//   One receipt, two events, both keyed through the shipped surfaces of the
//   base build: the first with an ordinary string, the second with the LITERAL
//   DIGEST OF THAT STRING. `0011`'s rule hashed the first and carried the
//   second, made them equal, and the rebuild died on
//   `UNIQUE(adoption_receipt_id, idempotency_key)` with `user_version` stuck at
//   10 forever. Under one unconditional rule the two are two digests of two
//   different strings, which is what two different strings always are.
// ===========================================================================

test("[12.1] a key and the literal digest of that key, on one receipt, upgrade to two rows that are still two", () => {
  const db = databaseAtVersion(9);
  const seed = seedGraph(db);
  const K = "collision-pair-key";
  const LITERAL = correlationDigest(K); // `sha256:a8ac…` — a STRING an adopter sent

  // The rows as `6303814` wrote them: that build passed `input.idempotencyKey`
  // straight into the column, so a raw string here is the row its REST surface
  // produced and not an imitation of one. Both calls were answered 200.
  insertReceiptEvent(db, seed.receipt, "attempted", 1, seed.now, K);
  insertReceiptEvent(db, seed.receipt, "failed", 2, seed.now, LITERAL);
  assert.equal(keys(db).length, 2, "two rows before the upgrade");

  migrate(db);

  assert.equal(userVersion(db), LATEST, "the upgrade COMPLETES — this is the run that could never finish");
  const after = keys(db);
  assert.equal(after.length, 2, "no row is lost: a collision that aborts is a receipt's history refused");
  assert.equal(new Set(after).size, 2, "and the two are still distinguishable");
  assert.deepEqual(
    [...after].sort(),
    [correlationDigest(K), correlationDigest(LITERAL)].sort(),
    "each key is the digest of the string that was stored, with nothing deciding which of them was 'already' one",
  );
  db.close();
});

// ===========================================================================
// [12.2] NO RULE DECIDES BY FORM. Every shape an adopter can send, including
//        the shapes that look like the stored form, ends as the digest of
//        itself. The set of shapes is deliberately adversarial.
// ===========================================================================

const SHAPES: ReadonlyArray<{ why: string; value: string }> = [
  { why: "an ordinary key", value: "legacy retry key with spaces" },
  { why: "the stored form, letter for letter", value: `sha256:${"0".repeat(64)}` },
  { why: "the digest of another key of this table", value: correlationDigest("collision-pair-key") },
  { why: "the stored prefix with upper-case hex", value: `sha256:${"A".repeat(64)}` },
  { why: "the stored prefix one digit short", value: `sha256:${"0".repeat(63)}` },
  { why: "bare hex with no prefix", value: "d".repeat(64) },
  { why: "the registry's own synthesized shape", value: "synth-delivered:01ARZ3NDEKTSV4RRFFQ69G5FAV" },
  { why: "a key on the 128-character bound", value: "z".repeat(128) },
];

test("[12.2] every shape a key can have is hashed, and nothing is carried across on account of looking hashed", () => {
  const db = databaseAtVersion(9);
  const seed = seedGraph(db);
  // Every shape on its own receipt: this probe is about the RULE, and putting
  // them on one receipt would be asking about `UNIQUE` instead.
  const receipts = SHAPES.map((s, i) => {
    const receipt = anotherReceipt(db, seed, i + 1);
    insertReceiptEvent(db, receipt, "delivered", 1, seed.now, s.value);
    return receipt;
  });

  migrate(db);

  for (const [i, shape] of SHAPES.entries()) {
    const got = db
      .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=?")
      .get(receipts[i]) as { k: string };
    assert.equal(got.k, correlationDigest(shape.value), `${shape.why} is the digest of itself, like every other`);
  }
  db.close();
});

test("[12.2b] nothing on the upgrade path tests the form of a stored key", () => {
  // (a) THE MAPPING ITSELF. It is code, so the claim "there is no test of form"
  // is checked on the code and not on a run that happens to agree with it today.
  const source = readFileSync(join(REPO_ROOT, "src/migration-steps.ts"), "utf8");
  const body = source.slice(source.indexOf("function keysOfRepeats"));
  assert.equal(body.includes("EVIDENCE_DIGEST"), false, "the digest pattern is not consulted");
  assert.equal(/sha256/i.test(body), false, "nor is the prefix, under any spelling");
  assert.equal(/\/\^|\.test\(/.test(body), false, "and no regular expression is applied to a stored value");
  assert.equal(source.includes("EVIDENCE_DIGEST"), false, "the file does not import the pattern at all");
  assert.deepEqual(
    Object.keys(MIGRATION_STEPS),
    ["12"],
    "and it is the ONLY step: a second one is a second place a rule could live",
  );

  // (b) EVERY MIGRATION, not the newest one. The set is the shipped directory,
  // so a file added later is in this guard the moment it exists, and comments
  // are stripped first — this round's files DESCRIBE the form at length, and a
  // guard that could not tell a description from a statement would have to be
  // turned off, which is the failure this file is written against.
  //
  // WHAT IT LOOKS AT, stated rather than implied: a LINE of SQL that names the
  // column and applies a pattern operator to something. An expression split
  // across lines would slip past it — this is a guard against a rule written
  // back in, not a proof that SQLite cannot express one, and it is written the
  // narrow way on purpose because the wide way (a whole statement) reads
  // `CREATE TABLE assignment_events` as an offender for a `GLOB` on a different
  // column entirely.
  const offenders: string[] = [];
  for (const file of MIGRATION_FILES) {
    for (const line of readFileSync(join(MIGRATION_DIR, file), "utf8").split("\n")) {
      if (line.trimStart().startsWith("--") || !/idempotency_key/.test(line)) continue;
      if (/\b(LIKE|GLOB|REGEXP|substr)\b/i.test(line)) offenders.push(`${file}: ${line.trim()}`);
    }
  }
  assert.deepEqual(offenders, [], "no migration inspects the shape of a key it is moving");
});

// ===========================================================================
// [12.3] `user_version` = 10 IS REFUSED, WITH ITS REASON, ON A REAL ROUND-10
//        DATABASE — one whose rows were written by the round-10 writer through
//        the shipped surfaces, which is what makes them digests.
// ===========================================================================

test("[12.3] a database left at user_version 10 is refused by name, and nothing in it is touched", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const v = reviewedVersion(fx, "round-ten");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
  const KEY = "a key the round-10 build hashed on the way in";
  const wrote = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: KEY,
  });
  assert.equal(wrote.status, 200, wrote.raw);
  const before = keys(fx.db);
  assert.ok(before.includes(correlationDigest(KEY)), "this IS a round-10 database: its keys are digests already");
  assert.ok(before.every((k) => EVIDENCE_DIGEST.test(k)), "every one of them");

  assert.throws(
    () => migrate(fx.db),
    (e: Error) => {
      const m = String(e.message);
      assert.match(m, /user_version/, "the refusal names the state it refuses");
      assert.match(m, /\b10\b/, "…by its number");
      assert.match(m, /never (released|deployed)|intermediate/i, "…says round 10 was never a release");
      assert.match(m, /\b9\b/, "…and names the supported path");
      return true;
    },
    "an upgrade that would hash a digest a second time is refused, not attempted",
  );
  assert.equal(userVersion(fx.db), 10, "the refusal changes no version");
  assert.deepEqual(keys(fx.db), before, "and no row");
});

test("[12.3b] the refused set is read from the code, and every member of it is refused", () => {
  assert.ok(UNSUPPORTED_UPGRADE_FROM.length > 0, "a set that is empty proves nothing");
  for (const version of UNSUPPORTED_UPGRADE_FROM) {
    const db = databaseAtVersion(version);
    assert.equal(userVersion(db), version);
    assert.throws(() => migrate(db), new RegExp(`\\b${version}\\b`), `user_version ${version} is refused`);
    db.close();
  }
  // …and the versions on either side of it are not: 9 is the supported legacy
  // state and 11 is the state a process left behind when it died between two
  // migrations of one pass, which must still be able to finish.
  for (const version of [9, 11]) {
    const db = databaseAtVersion(version);
    migrate(db);
    assert.equal(userVersion(db), LATEST, `user_version ${version} still upgrades`);
    db.close();
  }
});

// ===========================================================================
// [12.4] THE WHOLE PATH, `6303814` → this build: the base build's own rows, the
//        shipped runner, and then the shipped REST surface answering exactly as
//        it answered before the upgrade.
// ===========================================================================

test("[12.4] a base-build database upgrades and answers the standard scenario the way it always did", () => {
  const db = databaseAtVersion(4);
  assert.equal(userVersion(db), 4, "the base build's schema stops at 0004");
  const seed = seedGraph(db);
  const LEGACY = "legacy retry key with spaces";

  // §5.3's synthesized pair as `6303814` wrote it — the fixed key verbatim —
  // and the adopter's own `attempted` beside it.
  db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json, server_at_ms, idempotency_key)
     VALUES (?,?, 'delivered', 1, '{"synthesized":true}', ?, ?)`,
  ).run(ulid(seed.now), seed.receipt, seed.now, `synth-delivered:${seed.receipt}`);
  insertReceiptEvent(db, seed.receipt, "attempted", 2, seed.now, LEGACY);

  migrate(db);
  assert.equal(userVersion(db), LATEST, "the shipped runner carried 0005..0012 in one pass");

  const synth = db
    .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=? AND event='delivered'")
    .get(seed.receipt) as { k: string };
  assert.equal(
    synth.k,
    correlationDigest(`synth-delivered:${seed.receipt}`),
    "the registry's own synthesized key goes through the rule its adopters' keys go through",
  );

  const { fx, key } = restOverMigrated(db, seed.adopterA);
  const repeat = rest(fx, "POST", `/v1/receipts/${seed.receipt}/events`, key, {
    event: "attempted",
    idempotency_key: LEGACY,
  });
  assert.equal(repeat.status, 200, `a repeat of a key written before the upgrade is a repeat: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "and it is answered as one");
  assert.equal(repeat.body.receipt_event, "attempted", "with the event the original row recorded");
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE idempotency_key=?").get(LEGACY) as { c: number }).c,
    0,
    "and the adopter's string is no longer in the journal",
  );

  const survey = surveyJournalIntake(db);
  assert.deepEqual(survey.unclassified, [], "the migrated schema leaves no column unclassified");
  assert.deepEqual(survey.freeText, [], "and the survey over the migrated database finds no free text");
});

// ===========================================================================
// [12.5] THE FOURTH REBUILD OF THIS TABLE. What `0012` leaves must be, object
//        for object, what `0011` left. The intended difference is NONE: this
//        migration changes VALUES and no part of the shape.
// ===========================================================================

test("[12.5] the definition of `receipt_events` after 0012 is the definition after 0011, object for object", () => {
  const before = databaseAtVersion(11);
  const after = openMigrated();
  assert.equal(userVersion(before), 11);
  assert.equal(userVersion(after), 12);
  assert.deepEqual(
    receiptEventsDefinition(after),
    receiptEventsDefinition(before),
    "a rebuild may lose a constraint, an index, a trigger or a column order silently; this is the assertion that it did not",
  );
  before.close();
  after.close();
});

// ===========================================================================
// [12.6] THE EMPTY KEY, AND A COMMENT THAT TELLS THE TRUTH ABOUT IT.
//
//   `0011` said that a value which is not a non-empty string is carried across
//   and that the destination column's `NOT NULL` then refuses it. That is true
//   of NULL and FALSE OF THE EMPTY STRING: `''` is not NULL, and SQLite admits
//   it. A reviewer put one straight into the database and watched it come
//   through. Writing directly into the file is outside the V-1 threat model
//   [D-21] and so is not a defect of behaviour — but a shipped comment that
//   claims a refusal the code does not perform is a defect on its own [D-16.4],
//   and this is the probe that keeps it honest.
// ===========================================================================

test("[12.6] an empty key survives the migration, and the shipped text says exactly that", () => {
  const db = databaseAtVersion(9);
  const seed = seedGraph(db);
  db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, server_at_ms, idempotency_key)
     VALUES (?,?, 'delivered', 1, ?, '')`,
  ).run(ulid(seed.now), seed.receipt, seed.now);

  migrate(db);

  assert.deepEqual(keys(db), [""], "the empty string comes through unchanged: `NOT NULL` does not refuse it");
  db.close();

  const shipped = [
    readFileSync(join(REPO_ROOT, "src/migration-steps.ts"), "utf8"),
    readFileSync(join(MIGRATION_DIR, MIGRATION_FILES.find((f) => f.startsWith("0012_"))!), "utf8"),
  ];
  for (const text of shipped) {
    assert.match(
      text,
      /empty string is not NULL/,
      "the text names what SQLite actually does with an empty string",
    );
    assert.equal(
      /`NOT NULL` (below )?(then )?refuses it/.test(text),
      false,
      "and no longer claims a refusal that only applies to NULL",
    );
  }
});

// ===========================================================================
// [12.7] A KEY OF THE STORED FORM IS REFUSED ON EVERY SURFACE THAT ACCEPTS ONE.
//
//   The set is not a list kept here. For MCP it is every tool whose declared
//   `inputSchema` carries `idempotency_key`; for REST it is every route of
//   `src/http.ts` that reads the field. A surface added tomorrow is in this
//   sweep the moment it declares the field, which is the medicine [D-12]
//   prescribes for guards that say "every".
//
//   WHAT IS REFUSED, STATED EXACTLY. A key of the stored form may not create a
//   RECORD. It may still repeat one that exists — `[12.8]` — because a repeat
//   writes nothing, and an adopter of the base build whose key happened to have
//   this shape is owed the answer it always got.
// ===========================================================================

const DIGEST_SHAPED = `sha256:${"b".repeat(64)}`;

/** Every MCP tool that declares an `idempotency_key`, from the shipped table. */
function mcpSurfaces(): string[] {
  return MCP_TOOLS.filter((t: any) => t.inputSchema?.properties?.idempotency_key !== undefined)
    .map((t: any) => t.name as string)
    .sort();
}

/**
 * Every REST route that reads `idempotency_key`, from the shipped router.
 *
 * `src/http.ts` states its routes as a method test and a path — a literal or a
 * regular expression — followed by the handler that reads the field. This walks
 * that source and pairs them, so the set is the router's and not a copy of it.
 */
function restSurfaces(): Array<{ method: string; path: string }> {
  const source = readFileSync(join(REPO_ROOT, "src/http.ts"), "utf8");
  const out: Array<{ method: string; path: string }> = [];
  let route: string | null = null;
  let method: string | null = null;
  for (const line of source.split("\n")) {
    const literal = /path === "([^"]+)"/.exec(line);
    if (literal) route = literal[1]!;
    const pattern = /\/\^(\\\/[^ ]*?)\$\/\.exec\(path\)/.exec(line);
    if (pattern) route = pattern[1]!.replace(/\\\//g, "/").replace(/\(\[\^\/\]\+\)/g, "{id}");
    const verb = /method === "([A-Z]+)"/.exec(line);
    if (verb) method = verb[1]!;
    if (line.includes("idemKey(body)") && route && method) out.push({ method, path: route });
  }
  return out;
}

/**
 * Arguments broad enough that every surface's own parsing is satisfied, so what
 * answers is the key and not a missing field. Ids that must be REAL are filled
 * in by the caller; everything else may be nonsense, because the refusal comes
 * before the surface looks anything up.
 */
function fillerFor(receiptId: string, versionId: string, surface = ""): Record<string, unknown> {
  const args: Record<string, unknown> = {
    idempotency_key: DIGEST_SHAPED,
    slug: "filler-slug",
    skill_id: ulid(NOW),
    skill_version_id: versionId,
    archive: "AA==",
    archive_base64: "AA==",
    source: "AA==",
    source_base64: "AA==",
    receipt_id: receiptId,
    adoption_receipt_id: receiptId,
    adoption_request_id: ulid(NOW),
    assignment_id: ulid(NOW),
    agent_id: ulid(NOW),
    kid: "filler-kid",
    event: "attempted",
    score: 5,
    recipient: { kind: "local_agent", ref: ulid(NOW) },
    decision: "approved",
    verdict: "approved",
    reason: "filler",
    public_key: "AA==",
  };
  // `skill.verify` is the one surface whose OWN parsing refuses a COMBINATION —
  // a version id and an archive together are two different calls — so the
  // scaffolding drops the field it does not need. This is an argument, not a
  // member of the set: the set is still read from the code, and a surface that
  // needs scaffolding nobody wrote shows up in `missed` rather than in silence.
  if (surface === "skill.verify") delete args.archive_base64;
  return args;
}

test("[12.7] every MCP tool that accepts an idempotency key refuses one of the stored form", () => {
  const fx = p4Fixture({ rateLimit: { capacity: 10_000, refillPerSec: 10_000 } });
  const v = reviewedVersion(fx, "stored-form-mcp");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
  const surfaces = mcpSurfaces();
  assert.ok(surfaces.length >= 20, `the sweep must cover the shipped set, whatever its size: ${surfaces.length}`);

  const missed: string[] = [];
  for (const name of surfaces) {
    const res = mcp(fx, fx.keys.member!, name, fillerFor(run.receiptId, v.versionId, name));
    if (!res.isError || res.data?.error?.code !== "INVALID_SCHEMA" || !/stored digest form/.test(String(res.data?.error?.message))) {
      missed.push(`${name} → ${JSON.stringify(res.data)}`);
    }
  }
  assert.deepEqual(missed, [], "a surface that accepts the field and not the refusal is a surface the rule does not reach");
});

test("[12.7b] every REST route that accepts an idempotency key refuses one of the stored form", () => {
  const fx = p4Fixture({ rateLimit: { capacity: 10_000, refillPerSec: 10_000 } });
  const v = reviewedVersion(fx, "stored-form-rest");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
  const routes = restSurfaces();
  assert.ok(routes.length >= 20, `the sweep must cover the shipped router, whatever its size: ${routes.length}`);

  const missed: string[] = [];
  for (const route of routes) {
    // Surface 8 reads its receipt BEFORE it reaches the key, so that one route
    // gets the real receipt; every other route refuses the key before it looks
    // anything up, so any well-formed id will do.
    const filler = route.path.startsWith("/v1/receipts/") ? run.receiptId : v.versionId;
    const url = route.path.replace(/\{id\}/g, filler);
    const res = rest(fx, route.method, url, fx.keys.member!, fillerFor(run.receiptId, v.versionId));
    if (res.status !== 400 || !/stored digest form/.test(res.raw)) {
      missed.push(`${route.method} ${route.path} → ${res.status} ${res.raw.slice(0, 160)}`);
    }
  }
  assert.deepEqual(missed, [], "a route that reads the field and not the refusal is a route the rule does not reach");
});

test("[12.7c] the refused form is the stored form, and nothing wider", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "stored-form-bounds");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
  // Neighbours of the form, every one of them still a perfectly good key: the
  // narrowing is exactly `STORED_KEY_FORM` and is not a ban on the word.
  const accepted = [`sha256:${"B".repeat(64)}`, `sha256:${"b".repeat(63)}`, "b".repeat(64), `sha256-${"b".repeat(64)}`];
  for (const key of accepted) {
    assert.equal(STORED_KEY_FORM.test(key), false, `${key} is not of the stored form`);
    const res = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member!, {
      event: "attempted",
      idempotency_key: key,
    });
    assert.notEqual(res.status, 400, `a key beside the form is still a key: ${res.raw}`);
    // one event per receipt state, so each neighbour gets its own chain
    const next = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
    run.receiptId = next.receiptId;
  }
});

// ===========================================================================
// [12.8] THE ONE THING A KEY OF THE STORED FORM MAY STILL DO: repeat a record
//        that already exists. A legacy key of that shape is hashed like every
//        other key — no residue, no row decided by its looks — and the adopter
//        that sent it before the upgrade is answered `200 noop` after it.
// ===========================================================================

test("[12.8] a legacy key of the stored form is hashed like every other, and its repeat is still a repeat", () => {
  const db = databaseAtVersion(9);
  const seed = seedGraph(db);
  const SHAPED = `sha256:${"0".repeat(64)}`; // an adopter's own string, of the stored form
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, SHAPED);
  insertReceiptEvent(db, seed.receipt, "attempted", 2, seed.now, "an ordinary key beside it");

  migrate(db);

  const after = keys(db);
  assert.equal(after.includes(SHAPED), false, "no value is carried across on account of its shape");
  assert.ok(after.includes(correlationDigest(SHAPED)), "it is the digest of itself, like every other key");
  for (const k of after) assert.match(k, EVIDENCE_DIGEST, "and the column holds one kind of value");

  const { fx, key } = restOverMigrated(db, seed.adopterA);
  const repeat = rest(fx, "POST", `/v1/receipts/${seed.receipt}/events`, key, {
    event: "attempted",
    idempotency_key: SHAPED,
  });
  assert.equal(repeat.status, 200, `a key of the stored form may still REPEAT what it wrote: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "answered as the repeat it is");
  assert.equal(nextSeq(db, seed.receipt), 3, "and it writes no row");

  // …and the same key, on a receipt where it would have to CREATE one, is
  // refused. The rule is about new records, and it says so in the same run.
  const fresh = anotherReceipt(db, seed, 1);
  const refused = rest(fx, "POST", `/v1/receipts/${fresh}/events`, key, {
    event: "attempted",
    idempotency_key: SHAPED,
  });
  assert.equal(refused.status, 400, `a new record keyed with the stored form is refused: ${refused.raw}`);
  assert.match(refused.raw, /stored digest form/, "with the reason named");
});
