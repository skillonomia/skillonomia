// ROUND 11 — THE UPGRADE PROBE, WRITTEN BEFORE THE MIGRATION.
//
// WHAT THIS ROUND IS ABOUT, WHICH IS NOT A NEW RULE.
//
//   Round 10 replaced `receipt_events.idempotency_key` with a DIGEST of the
//   adopter's key, on both sides of the only comparison that column serves. The
//   rule is right, the code that writes it is right, and every probe of round 10
//   passes — on a database that round 10 created.
//
//   It shipped WITHOUT A MIGRATION. A row an older build wrote still holds the
//   adopter's string word for word, and the retry that repeats it now hashes
//   before it looks, so the repeat finds nothing: an idempotent call that
//   returned `200 noop` before the upgrade returns `412` after it, and the
//   adopter's text is still in the journal the round was about. A reviewer drove
//   exactly that through the shipped REST surface with the key
//   `legacy retry key with spaces`.
//
//   That is not an attack. It is AN UPGRADE OF A SUPPORTED DATABASE — a class
//   this repository had never once exercised in ten rounds. Every suite here
//   builds its database with `openMigrated()`, which migrates all the way
//   forward before the first row exists, so no test in this tree has ever seen a
//   row written by an older build.
//
// SO THE SUBJECT OF THIS FILE IS THE CLASS, AND IT OUTLIVES THIS ROUND.
//
//   The owner's rule, from this round on: EVERY ROUND THAT CHANGES THE SCHEMA OR
//   THE WAY A VALUE IS STORED CARRIES AN UPGRADE PROBE, and its five steps are
//   the five below.
//
//     1. build a database from the migrations that shipped BEFORE the change;
//     2. fill it through the STANDARD surfaces, including the values the new
//        rule is about, in the form the older build wrote them;
//     3. apply the current migrations with the shipped runner;
//     4. drive the standard scenario again and require the SAME answer as
//        before the upgrade — idempotence, pairing, verdicts;
//     5. run the journal survey over the migrated database: nothing
//        unclassified, no free text.
//
//   `[11.8]` is where that generalizes past one column: it walks EVERY journal
//   column the shipped code classifies `digest` and requires every value in a
//   MIGRATED LEGACY DATABASE to be one. The set comes from `JOURNAL_INTAKE`, not
//   from a list here, so the column somebody converts next is in this probe the
//   moment it is classified — which is the same medicine that stopped the tool
//   findings and the document findings from recurring.
//
// THE TRAP THAT IS NOT IN THE OWNER'S LIST, AND WHY IT DECIDES THE DESIGN.
//
//   A database raised on the CURRENT build already holds digests. If the
//   migration hashes what it finds, those become `sha256(sha256(k))`, which is
//   not what the retry computes, and EVERY existing repeat breaks — silently, on
//   every database created since round 10. So the migration must hash only what
//   is NOT ALREADY A DIGEST, and both upgrade paths have to be shown:
//   `[11.1]`/`[11.2]` come from the base build, `[11.3]` from this one.
//
// WHAT THIS FILE DOES NOT CLAIM. A legacy key that IS, letter for letter, a
// string of the form `sha256:<64 lowercase hex>` cannot be told from the digest
// of a key by any inspection of the value, and is left alone. `[11.11]` states
// that residue as a fact of the shipped behaviour rather than leaving a reader
// to discover it: the one adopter that chose such a key loses the replay of that
// one key, and nothing else moves.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { openDb, openMigrated, migrate } from "../src/db.ts";
import { migrationsDir } from "../src/assets.ts";
import type { Db } from "../src/sqlite.ts";
import { JOURNAL_INTAKE, correlationDigest, journalColumnsOf, journalTablesOf, surveyJournalIntake } from "../src/journal.ts";
import { MIGRATION_STEPS } from "../src/migration-steps.ts";
import { EVIDENCE_DIGEST } from "../src/outcome.ts";
import { ulid } from "../src/ulid.ts";
import { seedGraph, insertReceiptEvent } from "./helpers.ts";
import { p4Fixture, reviewedVersion, rest, adoptThroughSurfaces, env, type P4Fixture } from "./p6-helpers.ts";

// ---------------------------------------------------------------------------
// Building a database an OLDER BUILD left behind.
// ---------------------------------------------------------------------------

const MIGRATION_DIR = migrationsDir();
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();
const LATEST = MIGRATION_FILES.length === 0 ? 0 : parseInt(MIGRATION_FILES[MIGRATION_FILES.length - 1]!.slice(0, 4), 10);

/**
 * A database as the build that shipped migration `through` left it.
 *
 * This repeats the loop of `migrate` rather than calling it, because the shipped
 * runner has no "stop here" and MUST NOT GROW ONE: a registry migrates forward
 * to the build it is, and a parameter that let it stop short would be a way to
 * run a new binary against an old schema. `[11.9]` holds the duplicate honest by
 * requiring the two to produce the same schema when this one is not stopped.
 */
function databaseAtVersion(through: number): Db {
  const db = openDb();
  for (const file of MIGRATION_FILES) {
    const n = parseInt(file.slice(0, 4), 10);
    if (n > through) break;
    db.exec("BEGIN");
    // The steps of the migrations up to `through` ran in that build too: a step
    // ships with the numbered file that consumes it, so replaying them is what
    // makes this an older state rather than a broken one.
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

/** Every `idempotency_key` in the journal, in a stable order. */
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
 * trigger. Read from the database rather than from a migration file, because
 * what a rebuild loses it loses in the database and not in the text that was
 * meant to rebuild it.
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
 * A version, a receipt and a `delivered` event, all through the shipped REST
 * surface, on whatever database the fixture was given.
 */
function receiptThroughSurfaces(fx: P4Fixture, slug: string): { receiptId: string; key: string } {
  const v = reviewedVersion(fx, slug);
  const run = adoptThroughSurfaces(fx, v, fx.keys.member!, { terminal: "none" });
  return { receiptId: run.receiptId, key: fx.keys.member! };
}

// ===========================================================================
// [11.0] The round's claim: a migration exists.
// ===========================================================================

test("[11.0] a migration answers for the rows an older build wrote", () => {
  assert.ok(
    MIGRATION_FILES.some((f) => f.startsWith("0011_")),
    "round 11 claims a migration `0011`; the set of migration files does not contain one",
  );
  const db = openMigrated();
  assert.equal(userVersion(db), 11, "a freshly migrated database reports the migration this round adds");
  db.close();
});

// ===========================================================================
// [11.1] UPGRADE PATH A — the base build, `6303814`, whose migrations stop at
//        `0004` and whose writer stored the adopter's key word for word.
//        The whole chain 4 → 11 in one call of the shipped runner.
// ===========================================================================

test("[11.1] a base-build database upgrades, and every key it held becomes the digest of itself", () => {
  const db = databaseAtVersion(4);
  assert.equal(userVersion(db), 4, "the base build's schema stops at 0004");
  const seed = seedGraph(db);

  // The rows as the base build wrote them: `insertEvent` of `6303814` passed
  // `input.idempotencyKey` straight into the column, so a raw string here is
  // the row that build produced, not an imitation of one.
  const raw = ["legacy retry key with spaces", "RETRY/2026-08-12 #7", "kлюч на кириллице"];
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, raw[0]);
  insertReceiptEvent(db, seed.receipt, "attempted", 2, seed.now, raw[1]);
  insertReceiptEvent(db, seed.receipt, "adopted", 3, seed.now, raw[2]);

  migrate(db);

  assert.equal(userVersion(db), 11, "the shipped runner carried 0005..0011 in one pass");
  const after = keys(db);
  assert.equal(after.length, 3, "a rebuild that loses a row is a rebuild that loses a receipt's history");
  assert.deepEqual(
    [...after].sort(),
    raw.map(correlationDigest).sort(),
    "every key an older build stored is the digest of that key after the upgrade",
  );
  for (const k of after) assert.match(k, EVIDENCE_DIGEST, "and no other form survives");
  db.close();
});

// ===========================================================================
// [11.2] UPGRADE PATH A through the SHIPPED SURFACE: the reviewer's scenario.
//        Fill through REST, leave one row as the older writer left it, upgrade,
//        and repeat the call. `200 noop`, not `412`.
// ===========================================================================

test("[11.2] a repeat of a legacy key is idempotent across the upgrade, through the shipped REST surface", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const { receiptId } = receiptThroughSurfaces(fx, "upgrade-legacy");
  const LEGACY = "legacy retry key with spaces";

  // The one row the current build cannot write: an `attempted` event whose key
  // is the adopter's own string, which is the statement `appendReceiptEventInTx`
  // issued before round 10 and the reason this round exists.
  insertReceiptEvent(fx.db, receiptId, "attempted", nextSeq(fx.db, receiptId), Date.now(), LEGACY);
  const before = (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events").get() as { c: number }).c;

  migrate(fx.db);

  const repeat = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: LEGACY,
  });
  assert.equal(repeat.status, 200, `a repeat of a key written before the upgrade is a repeat: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "and it is answered as one");
  assert.equal(repeat.body.receipt_event, "attempted", "with the event the original row recorded");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events").get() as { c: number }).c,
    before,
    "a repeat writes no row",
  );
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE idempotency_key=?").get(LEGACY) as { c: number }).c,
    0,
    "and the adopter's string is no longer in the journal",
  );
});

// ===========================================================================
// [11.3] UPGRADE PATH B — a database raised on THIS build, whose keys are
//        already digests. The migration must leave them ALONE.
// ===========================================================================

test("[11.3] a database whose keys are already digests keeps the same digests, and its repeats still repeat", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const { receiptId } = receiptThroughSurfaces(fx, "upgrade-current");
  const KEY = "a key this build hashed on the way in";

  const first = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: KEY,
  });
  assert.equal(first.status, 200, first.raw);
  const before = keys(fx.db);
  assert.ok(before.every((k) => EVIDENCE_DIGEST.test(k)), "this build writes digests before the migration exists");

  migrate(fx.db);

  assert.deepEqual(keys(fx.db), before, "a value already in the stored form is not stored a second time");
  assert.ok(
    keys(fx.db).includes(correlationDigest(KEY)),
    "and it is still the digest OF THE KEY, not the digest of a digest",
  );
  const repeat = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: KEY,
  });
  assert.equal(repeat.status, 200, `every repeat on every database raised since round 10: ${repeat.raw}`);
  assert.equal(repeat.body.noop, true, "answered as a repeat");
});

/**
 * [11.3] IS THE ONE PROBE HERE THAT PASSES BEFORE THE FIX, and it is in the set
 * on purpose: it does not discriminate against the MISSING migration, it
 * discriminates against the WRONG one. The obvious migration — hash the column
 * — turns every database raised since round 10 into one whose every repeat
 * fails, quietly, with nothing in any log. `[11.3b]` puts that failure on the
 * record instead of describing it, so the shape of the mistake is a run and not
 * a warning in a comment.
 */
test("[11.3b] a key hashed twice is a repeat that never repeats — the failure the migration must not create", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const { receiptId } = receiptThroughSurfaces(fx, "upgrade-double");
  const KEY = "the key an adopter will send again";

  // The row a hash-everything migration would leave behind: the digest OF THE
  // DIGEST, which is a well-formed value of the right shape and the wrong one.
  insertReceiptEvent(
    fx.db,
    receiptId,
    "attempted",
    nextSeq(fx.db, receiptId),
    Date.now(),
    correlationDigest(correlationDigest(KEY)),
  );

  const repeat = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member!, {
    event: "attempted",
    idempotency_key: KEY,
  });
  assert.equal(repeat.status, 412, "the reader hashes once, finds nothing, and refuses the transition it already made");
  assert.notEqual(repeat.body.noop, true, "and the adopter is told its retry is an illegal second attempt");
});

// ===========================================================================
// [11.4] A MIXED database — the realistic one. A deployment that took the
//        round-10 build without a migration wrote digests next to the raw keys
//        it already had, so both are in one table and the rule is per ROW.
// ===========================================================================

test("[11.4] legacy and current keys in one table: both end as digests, and the survey still classifies the schema", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const { receiptId } = receiptThroughSurfaces(fx, "upgrade-mixed");
  const LEGACY = "written before the upgrade";
  const CURRENT = "written after it";

  insertReceiptEvent(fx.db, receiptId, "attempted", nextSeq(fx.db, receiptId), Date.now(), LEGACY);
  const done = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member!, {
    event: "failed",
    failure_report: { category: "gate_failed", summary: "the declared gate did not pass" },
    idempotency_key: CURRENT,
  });
  assert.equal(done.status, 200, done.raw);

  migrate(fx.db);

  const after = keys(fx.db);
  assert.ok(after.includes(correlationDigest(LEGACY)), "the row an older build wrote is hashed");
  assert.ok(after.includes(correlationDigest(CURRENT)), "the row this build wrote is not hashed twice");
  for (const k of after) assert.match(k, EVIDENCE_DIGEST, "and not one value of any other form is left");

  const survey = surveyJournalIntake(fx.db);
  assert.deepEqual(survey.unclassified, [], "the migrated schema leaves no column unclassified");
  assert.deepEqual(survey.freeText, [], "and no journal column of it is free text");
});

// ===========================================================================
// [11.5] The registry's OWN synthesized key — `synth-delivered:<receipt>` —
//        under the same rule, and equal to what this build writes today.
// ===========================================================================

test("[11.5] a synthesized `delivered` written by an older build ends where this build's synthesized key is", () => {
  const legacyFx = p4Fixture({ db: databaseAtVersion(10) });
  const v = reviewedVersion(legacyFx, "upgrade-synth");
  const requested = rest(legacyFx, "POST", "/v1/adoptions/requests", legacyFx.keys.member!, {
    skill_version_id: v.versionId,
  });
  assert.equal(requested.status, 201, requested.raw);
  const receiptId = requested.body.receipt_id as string;

  // §5.3's synthesized pair, as the older build wrote it: the fixed key verbatim.
  legacyFx.db
    .prepare(
      `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, evidence_json, server_at_ms, idempotency_key)
       VALUES (?,?, 'delivered', ?, '{"synthesized":true}', ?, ?)`,
    )
    .run(ulid(Date.now()), receiptId, nextSeq(legacyFx.db, receiptId), Date.now(), `synth-delivered:${receiptId}`);
  insertReceiptEvent(
    legacyFx.db,
    receiptId,
    "attempted",
    nextSeq(legacyFx.db, receiptId),
    Date.now(),
    "an attempt of the older build",
  );

  migrate(legacyFx.db);

  const migrated = legacyFx.db
    .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=? AND event='delivered'")
    .get(receiptId) as { k: string };
  assert.equal(
    migrated.k,
    correlationDigest(`synth-delivered:${receiptId}`),
    "the registry's own key goes through the rule its adopters' keys go through",
  );

  // …and that value is what THIS build writes, read off a live run rather than
  // asserted from the same expression twice.
  const liveFx = p4Fixture();
  const lv = reviewedVersion(liveFx, "upgrade-synth-live");
  const liveReq = rest(liveFx, "POST", "/v1/adoptions/requests", liveFx.keys.member!, { skill_version_id: lv.versionId });
  const liveReceipt = liveReq.body.receipt_id as string;
  const attempted = rest(liveFx, "POST", `/v1/receipts/${liveReceipt}/events`, liveFx.keys.member!, {
    event: "attempted",
  });
  assert.equal(attempted.status, 200, attempted.raw);
  const live = liveFx.db
    .prepare("SELECT idempotency_key AS k FROM receipt_events WHERE adoption_receipt_id=? AND event='delivered'")
    .get(liveReceipt) as { k: string };
  assert.equal(
    live.k,
    correlationDigest(`synth-delivered:${liveReceipt}`),
    "which is the form this build's synthesizer writes",
  );
});

// ===========================================================================
// [11.6] `UNIQUE(adoption_receipt_id, idempotency_key)` survives the third
//        rebuild of this table, and two different legacy keys stay two rows.
// ===========================================================================

test("[11.6] the uniqueness the replay depends on is still enforced after the rebuild", () => {
  const db = databaseAtVersion(10);
  const seed = seedGraph(db);
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, "one legacy key");
  insertReceiptEvent(db, seed.receipt, "attempted", 2, seed.now, "another legacy key");

  migrate(db);

  assert.equal(new Set(keys(db)).size, 2, "two different keys are two different digests and two rows");
  assert.throws(
    () =>
      db
        .prepare(
          `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, server_at_ms, idempotency_key)
           VALUES (?,?, 'failed', 9, ?, ?)`,
        )
        .run(ulid(seed.now), seed.receipt, seed.now, correlationDigest("one legacy key")),
    /UNIQUE|constraint/i,
    "a second row with the same (receipt, key) is refused, which is what a replay is looked up by",
  );
  db.close();
});

// ===========================================================================
// [11.7] THE THIRD REBUILD OF THIS TABLE. What `0011` leaves must be, object
//        for object, what `0009` + `0010` left. The intended difference is NONE:
//        this migration changes VALUES and no part of the shape.
// ===========================================================================

test("[11.7] the definition of `receipt_events` after 0011 is the definition after 0009 and 0010, object for object", () => {
  const before = databaseAtVersion(10);
  const after = openMigrated();
  assert.equal(userVersion(before), 10);
  assert.equal(userVersion(after), 11);
  assert.deepEqual(
    receiptEventsDefinition(after),
    receiptEventsDefinition(before),
    "a rebuild may lose a constraint, an index, a trigger or a column order silently; this is the assertion that it did not",
  );
  before.close();
  after.close();
});

// ===========================================================================
// [11.8] THE SET, NOT THE COLUMN. Every journal column the shipped code
//        classifies `digest` holds only digests in a MIGRATED LEGACY database.
//        The set is read from `JOURNAL_INTAKE`, so the next column somebody
//        converts is in this probe without anybody remembering it.
// ===========================================================================

/** `<table>.<column>` of every journal column the code calls a digest. */
function digestColumns(db: Db): string[] {
  const live = new Set<string>();
  for (const table of journalTablesOf(db)) for (const c of journalColumnsOf(db, table)) live.add(`${table}.${c}`);
  return Object.entries(JOURNAL_INTAKE)
    .filter(([column, spec]) => spec.intake === "digest" && live.has(column))
    .map(([column]) => column)
    .sort();
}

/**
 * A DIGEST AS THIS SCHEMA WRITES ONE. Two forms are in use and both are hashes:
 * `sha256:` and 64 lowercase hex for a correlation key, bare 64 lowercase hex
 * for the hash chain of `transparency_log`. The question the walker asks is not
 * which prefix a column chose — it is whether a value in a column the code calls
 * a digest could be a caller's text, and neither form can be.
 */
const STORED_DIGEST = /^(sha256:)?[0-9a-f]{64}$/;

/** Every value in those columns that is neither NULL nor a digest. */
function nonDigests(db: Db): string[] {
  const bad: string[] = [];
  for (const column of digestColumns(db)) {
    const [table, name] = column.split(".");
    const rows = db.prepare(`SELECT ${name} AS v FROM ${table} WHERE ${name} IS NOT NULL`).all() as Array<{ v: unknown }>;
    for (const r of rows) if (typeof r.v !== "string" || !STORED_DIGEST.test(r.v)) bad.push(`${column}=${String(r.v)}`);
  }
  return bad;
}

test("[11.8] in a migrated legacy database, every column the code calls a digest holds one", () => {
  const fx = p4Fixture({ db: databaseAtVersion(10) });
  const { receiptId } = receiptThroughSurfaces(fx, "upgrade-set");
  insertReceiptEvent(fx.db, receiptId, "attempted", nextSeq(fx.db, receiptId), Date.now(), "a key of an older build");

  const columns = digestColumns(fx.db);
  assert.ok(
    columns.includes("receipt_events.idempotency_key"),
    "the set comes from the code's own classification, and this round's column is in it",
  );
  assert.deepEqual(nonDigests(fx.db), [`receipt_events.idempotency_key=a key of an older build`], "…before the upgrade");

  migrate(fx.db);

  assert.deepEqual(nonDigests(fx.db), [], "…and nothing of any other form is left in any of them after it");
});

test("[11.8b] the walker bites: a value of another form in any such column is reported", () => {
  const db = databaseAtVersion(10);
  const seed = seedGraph(db);
  migrate(db);
  assert.deepEqual(nonDigests(db), [], "a migrated database with no legacy row has nothing to report");
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, "not a digest at all");
  assert.deepEqual(
    nonDigests(db),
    ["receipt_events.idempotency_key=not a digest at all"],
    "a survey that cannot fail is not a survey",
  );
  db.close();
});

// ===========================================================================
// [11.9] The builder of old states is the shipped runner, minus the stop.
// ===========================================================================

test("[11.9] the probe's own migration loop leaves the schema the shipped runner leaves", () => {
  const byProbe = databaseAtVersion(LATEST);
  const byRunner = openMigrated();
  const objects = (db: Db) =>
    db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
  assert.deepEqual(objects(byProbe), objects(byRunner), "or the states this file calls old are states of its own making");
  assert.equal(userVersion(byProbe), userVersion(byRunner));
  byProbe.close();
  byRunner.close();
});

// ===========================================================================
// [11.10] The migration runs once. A second call is a no-op, and the digests
//         are not hashed a second time by the runner either.
// ===========================================================================

test("[11.10] migrating an already-migrated database changes nothing", () => {
  const db = databaseAtVersion(10);
  const seed = seedGraph(db);
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, "a key of an older build");
  migrate(db);
  const once = keys(db);
  migrate(db);
  assert.deepEqual(keys(db), once, "the second pass hashes nothing, because there is no second pass");
  assert.deepEqual(once, [correlationDigest("a key of an older build")]);
  db.close();
});

// ===========================================================================
// [11.12] THE BOUNDARY OF THIS ROUND, RUN RATHER THAN DESCRIBED.
//
//   Round 10 narrowed more than one column. `receipt_events.idempotency_key` is
//   what `0011` repairs; `observed_records.call_id` became a digest in the same
//   round, and `runtime_observations.model` and `.window_detail` were narrowed
//   in it, all three without a migration. The table that holds them was created
//   by `0008`, so a database older than that carries no row of any of them —
//   but a database written BETWEEN `0008` and the round-10 build does, and this
//   round does not repair those rows.
//
//   This probe holds those values and requires them to come through the
//   migration UNCHANGED, which is what the code does. It is not an endorsement:
//   it is the boundary written where a run can see it, so that the round which
//   takes those columns starts from a probe that fails instead of from a
//   sentence somebody has to remember. `[11.8]` is honest for the same reason —
//   it walks the whole classified set over the legacy states THIS FILE BUILDS,
//   and this is the state it does not build.
// ===========================================================================

test("[11.12] the columns round 10 narrowed in `observed_records` and `runtime_observations` are NOT repaired here", () => {
  const db = databaseAtVersion(10);
  const seed = seedGraph(db);
  const RAW_CALL_ID = "call-42 from the runtime's own log";
  const RAW_MODEL = "a model name of the older build, with spaces";
  const RAW_WINDOW = "the reporter's own sentence about its boundary";

  const observation = ulid(seed.now);
  db.prepare(
    `INSERT INTO runtime_observations(id, agent_id, runtime, model, selection_window, window_detail,
        proposal_inventory_complete, records_read, reported_by_agent_id, reported_by_type,
        reported_by_role, server_at_ms, idempotency_key)
     VALUES (?,?, 'claude_code', ?, 'all_time', ?, 1, 1, ?, 'agent', 'member', ?, ?)`,
  ).run(observation, seed.adopterA, RAW_MODEL, RAW_WINDOW, seed.adopterA, seed.now, `observation:${observation}`);
  db.prepare(
    `INSERT INTO observed_records(id, observation_id, agent_id, runtime, role, call_id, at_ms, marker, result, server_at_ms)
     VALUES (?,?,?, 'claude_code', 'call', ?, ?, ?, 'unknown', ?)`,
  ).run(ulid(seed.now), observation, seed.adopterA, RAW_CALL_ID, seed.now, `SKLN1-${"A".repeat(16)}`, seed.now);

  migrate(db);

  assert.equal(
    (db.prepare("SELECT call_id AS v FROM observed_records").get() as { v: string }).v,
    RAW_CALL_ID,
    "0011 answers for one column and says so; this is the one it does not answer for",
  );
  const obs = db.prepare("SELECT model AS m, window_detail AS w FROM runtime_observations").get() as {
    m: string;
    w: string;
  };
  assert.equal(obs.m, RAW_MODEL, "…and the narrowing of `model` reached the intake and no existing row");
  assert.equal(obs.w, RAW_WINDOW, "…nor did the composition of `window_detail`");
  db.close();
});

// ===========================================================================
// [11.11] THE RESIDUE, STATED. A legacy key that is ITSELF of the stored form
//         is indistinguishable from the digest of a key, and is left alone.
//         This is the shipped behaviour; the probe exists so that it is a
//         recorded decision and not a discovery.
// ===========================================================================

test("[11.11] a legacy key already shaped like a digest is left as it stands, and that is the whole of the cost", () => {
  const db = databaseAtVersion(10);
  const seed = seedGraph(db);
  const SHAPED = `sha256:${"0".repeat(64)}`; // an adopter's own string, of the stored form
  const ORDINARY = "an adopter's ordinary key";
  insertReceiptEvent(db, seed.receipt, "delivered", 1, seed.now, SHAPED);
  insertReceiptEvent(db, seed.receipt, "attempted", 2, seed.now, ORDINARY);

  migrate(db);

  const after = keys(db);
  assert.ok(after.includes(SHAPED), "the value is carried across unchanged: no inspection of it can say which it is");
  assert.ok(after.includes(correlationDigest(ORDINARY)), "and the key beside it is hashed as every other key is");
  // The consequence, spelled out: the replay of THAT one key no longer finds its
  // row, because the reader hashes before it looks. No other key moves, nothing
  // is lost from the journal, and no value of another form is introduced.
  assert.notEqual(correlationDigest(SHAPED), SHAPED, "the reader computes a different value for that one key");
  for (const k of after) assert.match(k, EVIDENCE_DIGEST, "the column still holds one kind of value");
  db.close();
});
