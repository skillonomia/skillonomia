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
//   3. NOTHING ANYWHERE LOOKS AT THE FORM OF A KEY, and `[12.7]` walks `src/`
//      to say so. An earlier draft of this round REFUSED an incoming key of the
//      stored form, so that no further row could be ambiguous. The owner
//      withdrew it: the refusal was only ever needed while something DID decide
//      by form, and it made the answer to one input depend on the state of the
//      database — a rule you cannot check by reading a request. A key that IS a
//      digest is now simply hashed like any other string, which gives a
//      different value from the digest of the OTHER key, which is the whole of
//      why the collision is gone.
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
import { EVIDENCE_DIGEST } from "../src/outcome.ts";
import { mintApiKey } from "../src/auth.ts";
import { ulid } from "../src/ulid.ts";
import { seedGraph, insertReceiptEvent } from "./helpers.ts";
import { p4Fixture, reviewedVersion, rest, adoptThroughSurfaces, NOW, type P4Fixture } from "./p6-helpers.ts";

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

/** The pair the reviewer sent: a key, and the literal digest OF that key. */
const K = "collision-pair-key";
const LITERAL = correlationDigest(K); // `sha256:a8ac…d353` — a STRING an adopter sent

test("[12.1] the reviewer's pair, on one receipt of a base-build database, upgrades to two rows that are still two", () => {
  const db = databaseAtVersion(4);
  assert.equal(userVersion(db), 4, "`6303814`'s schema stops at 0004, and this is it");
  const seed = seedGraph(db);

  // The rows as `6303814`'s REST surface wrote them. That build's
  // `appendReceiptEventInTx` passed `input.idempotencyKey` STRAIGHT INTO THE
  // COLUMN — there was no digest on the way in — so a raw string here is the row
  // `POST /v1/receipts/{id}/events` produced on that build and not an imitation
  // of one. Both calls were answered 200 by it, which is what made this an
  // upgrade of a database the repository supports and not an attack.
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

test("[12.1b] the same pair sent to THIS build's REST is accepted, and lands on those same two values", () => {
  // The other half of the refutation, and the half that is driven end to end
  // through the shipped surface rather than planted: nothing refuses a key for
  // looking like a digest, so an adopter may still send `sha256:<64 hex>` — and
  // what it produces is the digest OF THAT STRING, which is not the digest of
  // the other key. Two different strings, two different values, `UNIQUE` intact.
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "collision-live");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });

  const first = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: K,
  });
  assert.equal(first.status, 200, `an ordinary key: ${first.raw}`);
  const second = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member!, {
    event: "failed",
    failure_report: { category: "gate_failed", summary: "the declared gate did not pass" },
    idempotency_key: LITERAL,
  });
  assert.equal(second.status, 200, `a key that IS the digest of the first: ${second.raw}`);

  const live = new Set(
    (
      fx.db
        .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=?")
        .all(run.receiptId) as Array<{ k: string }>
    ).map((r) => r.k),
  );
  assert.ok(live.has(correlationDigest(K)), "the first is the digest of the first key");
  assert.ok(live.has(correlationDigest(LITERAL)), "the second is the digest of the second key");
  assert.notEqual(correlationDigest(K), correlationDigest(LITERAL), "and those are two values, not one");

  // …and they are the SAME two values `[12.1]` reaches by migration, so the
  // upgraded database and the live writer agree about this pair rather than
  // each being right on its own.
  const repeat = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member!, {
    event: "failed",
    failure_report: { category: "gate_failed", summary: "the declared gate did not pass" },
    idempotency_key: LITERAL,
  });
  assert.equal(repeat.status, 200, `and a key of that shape repeats like any other: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "answered as the repeat it is");
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
  // `0012` and not "the latest": this probe is about what THIS migration left,
  // and reading it off `openMigrated()` made the assertion move every time a
  // later migration landed — which is how a probe about one rebuild becomes a
  // probe about the head of the schema.
  const after = databaseAtVersion(12);
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
// [12.7] NOTHING IN `src/` TESTS THE FORM OF AN IDEMPOTENCY KEY.
//
//   The rule that decided by form is gone from the migration, and this is the
//   guard that keeps it from coming back somewhere else. An earlier draft of
//   this round REFUSED an incoming key of the stored form, so that no further
//   row could be ambiguous; the owner withdrew that on the ground that it was
//   only ever needed while something DID look at the form. Unconditional hashing
//   removes the question: `K` becomes the digest of `K`, and a key that IS a
//   digest becomes the digest of THAT STRING, which is a different value. There
//   is nothing left for a form test to decide, so there must be no form test —
//   including one that would refuse a caller's key for its looks.
//
//   THE SET IS THE DIRECTORY. Every `.ts` under `src/`, found by walking it, so
//   a file added tomorrow is inside this guard without anybody remembering it.
//   Comments are stripped first: this round's files DESCRIBE the form at length,
//   and a guard that could not tell a description from a statement would have to
//   be turned off, which is the failure this file is written against.
// ===========================================================================

/** Every `.ts` file under `src/`, by walking the directory. */
function sourceFiles(dir = join(REPO_ROOT, "src")): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...sourceFiles(full));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out.sort();
}

/** The file with every `//` line and every `/* … *\/` block removed. */
function statementsOf(source: string): string[] {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .split("\n")
    .filter((l) => !l.trimStart().startsWith("//"));
}

test("[12.7] no file under src/ tests the FORM of an idempotency key", () => {
  const files = sourceFiles();
  assert.ok(files.length > 30, `the walk must find the shipped tree, whatever its size: ${files.length}`);
  for (const known of ["src/idempotency.ts", "src/receipts.ts", "src/migration-steps.ts", "src/http.ts", "src/mcp.ts"]) {
    assert.ok(
      files.some((f) => f.endsWith(known.slice(3))),
      `${known} is in the walked set`,
    );
  }

  // A form test is a pattern applied to a value. This looks for one on any
  // statement line that also names the key — which is how a rule about the shape
  // of an idempotency key would have to be written.
  const APPLIES_A_PATTERN = /EVIDENCE_DIGEST|STORED_KEY_FORM|\.test\(|\.match\(|\bmatchAll\(|startsWith\(\s*["'`]sha256|\/\^/;
  const offenders: string[] = [];
  for (const file of files) {
    const rel = file.slice(REPO_ROOT.length);
    for (const line of statementsOf(readFileSync(file, "utf8"))) {
      if (!/idempotency/i.test(line)) continue;
      if (APPLIES_A_PATTERN.test(line)) offenders.push(`${rel}: ${line.trim().slice(0, 140)}`);
    }
  }
  assert.deepEqual(offenders, [], "a statement that names an idempotency key and applies a pattern to it");

  // …and the refusal that was withdrawn cannot come back under its own name
  // without this failing, whatever line it is written on.
  const withdrawn: string[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const name of ["STORED_KEY_FORM", "refuseStoredKeyForm"]) {
      if (text.includes(name)) withdrawn.push(`${file.slice(REPO_ROOT.length)}: ${name}`);
    }
  }
  assert.deepEqual(withdrawn, [], "the withdrawn refusal is gone from the shipped tree, name and all");
});

// ===========================================================================
// [12.8] A LEGACY KEY OF THE STORED FORM IS AN ORDINARY KEY. It is hashed like
//        every other — no residue, no row decided by its looks — and the adopter
//        that sent it before the upgrade is answered `200 noop` after it, with
//        nothing refusing it on the way in.
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
  assert.equal(repeat.status, 200, `the repeat of a key written before the upgrade: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "answered as the repeat it is");
  assert.equal(nextSeq(db, seed.receipt), 3, "and it writes no row");

  // …and the same key on a receipt where it would OPEN a chain is accepted like
  // any other string. Nothing refuses a key for its shape.
  const fresh = anotherReceipt(db, seed, 1);
  const opened = rest(fx, "POST", `/v1/receipts/${fresh}/events`, key, {
    event: "attempted",
    idempotency_key: SHAPED,
  });
  assert.equal(opened.status, 200, `a key of that shape opens a record like any other: ${opened.raw}`);
  assert.equal(opened.body.noop, undefined, "and it is a write, not a replay");
  assert.equal(
    (db.prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=? AND event='attempted'").get(fresh) as { k: string }).k,
    correlationDigest(SHAPED),
    "stored as the digest of the string that was sent",
  );
});
