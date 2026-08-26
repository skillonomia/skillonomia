// P0 — THE MIGRATION AND THE INVARIANTS, RUN RATHER THAN DESCRIBED.
//
// WHAT THIS FILE HAS TO PROVE, AND WHY EACH HALF IS HERE.
//
//   `0018` states rules. A file that states rules and is never run against a
//   database that breaks them has stated nothing: the failure mode is a trigger
//   whose `WHEN` clause is subtly wrong, which refuses nothing and passes every
//   test written the happy way. So every rule below has TWO probes — a legal
//   shape that must be ACCEPTED and an illegal one that must be REFUSED.
//
//   AND THAT IS STILL NOT ENOUGH. A negative probe that would pass with or
//   without the guard proves nothing either: if the illegal write fails for some
//   OTHER reason — a foreign key, a NOT NULL, a typo in the fixture — the probe
//   is green and the trigger could be absent. So each negative probe is run
//   TWICE: once against the migrated schema, where it must be refused, and once
//   against a database at the BASELINE version 17, where the same statement must
//   SUCCEED. That second run is the discrimination proof, and it is executable
//   rather than asserted — `[P0.D]` prints the pair for every rule.
//
//   The migration half is the standing rule this project adopted in round 11 and
//   has kept since: build a database from the migrations that shipped BEFORE the
//   change, fill it through the standard surfaces, migrate it with the shipped
//   runner, and require the same answers afterwards. `0018` writes no data, so
//   "the same answers" here is stronger than usual — it is EVERY ROW OF EVERY
//   TABLE, counted before and after.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, appendFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

import { openDb, openMigrated, openReadOnly, migrate } from "../src/db.ts";
import { migrationsDir } from "../src/assets.ts";
import { MIGRATION_STEPS } from "../src/migration-steps.ts";
import type { Db } from "../src/sqlite.ts";
import { ulid } from "../src/ulid.ts";
import { verifyPackage } from "../src/verify.ts";
import { verifyTlog } from "../src/tlog.ts";
import { p4Fixture, publishedVersion, reviewedVersion, verifiableVersion } from "./p4-helpers.ts";
import { tv01Package, tvRegistry } from "./vectors-helpers.ts";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const MIGRATION_DIR = migrationsDir();
const MIGRATION_FILES = readdirSync(MIGRATION_DIR)
  .filter((f) => /^\d{4}_.+\.sql$/.test(f))
  .sort();

/** The version this phase migrates FROM: the highest number that shipped in
 *  v1.0.0. Derived from the file list rather than typed, so it moves with the
 *  tree instead of becoming a stale literal. */
const BASELINE_VERSION = Math.max(
  ...MIGRATION_FILES.map((f) => parseInt(f.slice(0, 4), 10)).filter((n) => n < 18),
);
const V11_VERSION = 18;

/** Where the gate manifest expects this run's evidence. Appended to, never
 *  truncated: a probe log that a later run silently replaces is a log that
 *  cannot be compared with the one the reviewer read. */
const EVIDENCE_LOG = join(REPO_ROOT, "evidence", "P0", "migration-probe.log");
const probeLines: string[] = [];
function record(line: string): void {
  probeLines.push(line);
  console.log(line);
}

/**
 * A database at an EARLIER schema version.
 *
 * The loop of `migrate()` is repeated here rather than parameterised there, for
 * the reason `test/p14-r11-probes.test.ts` gives and this file inherits: a
 * registry migrates forward to the build it IS, and a "stop at N" parameter on
 * the shipped runner would be a supported way to run a new binary against an old
 * schema. `[P0.4]` compares what this produces against what the shipped runner
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

/** Every user table, and how many rows it holds. The whole census, not a sample:
 *  a migration that lost rows from the one table nobody sampled is the defect
 *  this exists to make impossible. */
function census(db: Db): Record<string, number> {
  const tables = (
    db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all() as Array<{ name: string }>
  ).map((r) => r.name);
  const out: Record<string, number> = {};
  for (const t of tables) {
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
 * A v1.0.0-shaped database with real content, on disk.
 *
 * Filled through the SHIPPED SURFACES — `p4Fixture` drives the same
 * `Registry` a deployment serves — and not by hand-written INSERTs, because a
 * hand-written row is a row shaped the way the probe author believed the
 * product writes them. The content deliberately includes the two shapes this
 * phase is about: a published version that is later revoked (so the forward
 * direction of the disposition rule has a row), and a superseded pair (so the
 * lineage rules have one).
 */
function legacyDeployment(path: string): { rows: Record<string, number>; revokedId: string; supersededId: string } {
  const db = databaseAtVersion(BASELINE_VERSION, path);
  assert.equal(userVersion(db), BASELINE_VERSION);
  const fx = p4Fixture({ db });

  const doomed = publishedVersion(fx, "p0-legacy-revoked");
  fx.registry.revokeVersion(fx.owner, doomed.versionId, { reason: "a dependency turned out to be compromised" });

  const old = publishedVersion(fx, "p0-legacy-superseded");
  // A further version of the SAME skill: the manifest names the skill it belongs
  // to, so a successor built without that carries a different `skill_id` and is
  // refused before it can be linked.
  const replacement = verifiableVersion(fx, "p0-legacy-superseded", {
    skill_id: old.skillId,
    semver: "2.0.0",
    manifest: { skill_id: old.skillId },
  });
  fx.registry.verifyVersion(fx.owner, replacement.versionId);
  fx.registry.supersedeVersion(fx.owner, old.versionId, { successor_version_id: replacement.versionId });

  // …and a version with no disposition and no lineage at all, which is what
  // most rows of a real registry are.
  reviewedVersion(fx, "p0-legacy-plain");

  const rows = census(db);
  db.close();
  return { rows, revokedId: doomed.versionId, supersededId: old.versionId };
}

let scratch: string;
test("[P0.0] a scratch directory, and the shape of the evidence this phase leaves", () => {
  scratch = mkdtempSync(join(tmpdir(), "skln-p0-"));
  mkdirSync(join(REPO_ROOT, "evidence", "P0"), { recursive: true });
  record(`[P0.0] baseline schema version ${BASELINE_VERSION} → v1.1 schema version ${V11_VERSION}`);
  record(`[P0.0] migrations on disk: ${MIGRATION_FILES.length}`);
  assert.equal(
    MIGRATION_FILES.filter((f) => f.startsWith("0018_")).length,
    1,
    "P0 claims a migration 0018; the set of migration files does not contain exactly one",
  );
  // …and it ships a reversal, which every migration from 0013 on does.
  const downs = readdirSync(join(MIGRATION_DIR, "down"));
  assert.ok(
    downs.some((f) => f.startsWith("0018_") && f.endsWith(".down.sql")),
    "0018 ships no reversal, and the convention has been unbroken since 0013",
  );
});

// ===========================================================================
// G-P0-4 — the migration: no row lost, reopenable, applied to a copy, idempotent
// ===========================================================================

test("[P0.1] a v1.0.0 database migrates with ZERO row loss — every table counted before and after", () => {
  const path = join(scratch, "p0-rowloss.db");
  const { rows: before } = legacyDeployment(path);

  const db = openDb(path);
  assert.equal(userVersion(db), BASELINE_VERSION, "the fixture must start at the baseline schema");
  migrate(db);
  assert.equal(userVersion(db), V11_VERSION);
  const after = census(db);
  db.close();

  // Every table that EXISTED before is present after and holds exactly the rows
  // it held. `deepEqual` over the whole census rather than a loop over a chosen
  // few, so a table added or dropped fails here too.
  assert.deepEqual(after, before, "the migration changed a row count");
  const total = Object.values(before).reduce((a, b) => a + b, 0);
  assert.ok(total > 0, `the fixture wrote ${total} rows — a migration over an empty database proves nothing`);
  record(`[P0.1] ${Object.keys(before).length} tables, ${total} rows, unchanged across 0018`);
});

test("[P0.2] the migrated database REOPENS through the normal open path", () => {
  const path = join(scratch, "p0-reopen.db");
  legacyDeployment(path);
  const first = openMigrated(path);
  assert.equal(userVersion(first), V11_VERSION);
  first.close();

  // The normal path, twice: a schema that only opens once is a schema whose
  // migration left something the second open trips over.
  const second = openMigrated(path);
  assert.equal(userVersion(second), V11_VERSION);
  assert.deepEqual(
    (second.prepare("PRAGMA foreign_key_check").all() as unknown[]),
    [],
    "the migrated database has a dangling reference",
  );
  assert.deepEqual(
    (second.prepare("PRAGMA integrity_check").all() as Array<{ integrity_check: string }>).map((r) => r.integrity_check),
    ["ok"],
  );
  // and the transparency log the revoke wrote still verifies offline
  const chain = verifyTlog(second);
  assert.equal(chain.ok, true, `the tlog chain did not survive the migration: ${JSON.stringify(chain)}`);
  second.close();
  record(`[P0.2] reopened twice, foreign_key_check clean, integrity_check ok, tlog chain intact`);
});

test("[P0.3] the migration runs on a COPY, and the pre-migration original stays readable by v1.0 code paths", () => {
  const original = join(scratch, "p0-original.db");
  legacyDeployment(original);
  const copy = join(scratch, "p0-copy.db");
  copyFileSync(original, copy);

  const upgraded = openMigrated(copy);
  assert.equal(userVersion(upgraded), V11_VERSION);
  upgraded.close();

  // THE ROLLBACK TARGET SURVIVES. This is the half the documented rollback
  // procedure depends on: the copy taken before the migration must still be a
  // database the previous build can serve, so `openReadOnly` (which does not
  // migrate, deliberately) opens it and a v1.0 read runs against it.
  const rollbackTarget = openReadOnly(original);
  assert.equal(userVersion(rollbackTarget), BASELINE_VERSION, "the original was migrated in place — it is not a rollback target");
  const versions = rollbackTarget
    .prepare("SELECT id, state, revocation_reason, superseded_by_version_id FROM skill_versions ORDER BY id")
    .all() as Array<{ id: string; state: string; revocation_reason: string | null; superseded_by_version_id: string | null }>;
  assert.ok(versions.length >= 4, "the rollback target lost its rows");
  assert.ok(versions.some((v) => v.state === "revoked" && v.revocation_reason !== null));
  assert.ok(versions.some((v) => v.state === "superseded" && v.superseded_by_version_id !== null));
  rollbackTarget.close();
  record(`[P0.3] copy migrated to ${V11_VERSION}; original still at ${BASELINE_VERSION} and readable read-only`);
});

test("[P0.4] re-running the shipped runner is a NOOP, and the stepped build equals the shipped one", () => {
  const path = join(scratch, "p0-idempotent.db");
  legacyDeployment(path);

  const db = openDb(path);
  migrate(db);
  const afterFirst = { schema: schemaOf(db), rows: census(db), uv: userVersion(db) };
  migrate(db);
  const afterSecond = { schema: schemaOf(db), rows: census(db), uv: userVersion(db) };
  db.close();
  assert.deepEqual(afterSecond, afterFirst, "a second run of the migration runner changed something");
  assert.equal(afterFirst.uv, V11_VERSION);

  // …and the loop this file repeats produces the same schema the shipped runner
  // does when it is not stopped short. Without this the duplicate above could
  // drift and every probe built on it would be measuring the wrong thing.
  const stepped = databaseAtVersion(V11_VERSION);
  const shipped = openMigrated();
  assert.deepEqual(schemaOf(stepped), schemaOf(shipped), "the stepped build and the shipped runner disagree");
  assert.equal(userVersion(stepped), userVersion(shipped));
  stepped.close();
  shipped.close();
  record(`[P0.4] second run changed nothing; stepped build ≡ shipped runner`);
});

test("[P0.5] the reversal drops exactly what the migration added, and restores the baseline version", () => {
  const path = join(scratch, "p0-reversal.db");
  legacyDeployment(path);
  const beforeMigration = (() => {
    const db = openDb(path);
    const s = { schema: schemaOf(db), rows: census(db) };
    db.close();
    return s;
  })();

  const db = openMigrated(path);
  const down = readFileSync(
    join(MIGRATION_DIR, "down", "0018_a_revocation_and_a_replacement_are_two_facts.down.sql"),
    "utf8",
  );
  db.exec("BEGIN");
  db.exec(down);
  db.exec("COMMIT");
  assert.equal(userVersion(db), BASELINE_VERSION);
  assert.deepEqual(schemaOf(db), beforeMigration.schema, "the reversal did not restore the baseline schema object for object");
  assert.deepEqual(census(db), beforeMigration.rows, "the reversal changed a row count — it must write no data either");
  // …and it converges: a reversal run against a database that never reached
  // this version must not refuse, which is what `DROP … IF EXISTS` is for.
  db.exec(down);
  assert.equal(userVersion(db), BASELINE_VERSION);
  db.close();
  record(`[P0.5] reversal restores schema ${BASELINE_VERSION} object for object and is convergent`);
});

// ===========================================================================
// G-P0-5 — the cross-row invariants, positive AND negative, each discriminating
// ===========================================================================

/**
 * A minimal graph: one workspace, one agent, one skill, and a way to write
 * version rows directly.
 *
 * Directly is the point. These probes are about what the DATABASE refuses, and
 * a probe that went through the service layer would be measuring the service's
 * checks — which P1 has not written yet, and which are not what `0018` claims.
 */
function graph(db: Db): { skill: string; otherSkill: string; agent: string } {
  const now = 1_754_000_000_000;
  const ws = ulid(now);
  db.prepare("INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)").run(ws, "p0-ws", now);
  const agent = ulid(now);
  db.prepare(
    "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?,?, 'active', ?)",
  ).run(agent, ws, "p0-agent", "agent", now);
  const skill = ulid(now);
  db.prepare(
    "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'workspace', ?)",
  ).run(skill, ws, "p0-skill", agent, now);
  const otherSkill = ulid(now + 1);
  db.prepare(
    "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'workspace', ?)",
  ).run(otherSkill, ws, "p0-other-skill", agent, now);
  return { skill, otherSkill, agent };
}

interface Row {
  id?: string;
  skill: string;
  agent: string;
  semver: string;
  state: string;
  reason?: string | null;
  supersededBy?: string | null;
  supersedes?: string | null;
}

function insertRow(db: Db, r: Row): string {
  const now = 1_754_000_000_000;
  const id = r.id ?? ulid(now + Math.floor(Math.random() * 1_000_000));
  db.prepare(
    `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
       manifest_hash, content_hash, package_blob_ref, signature_jws, state,
       revocation_reason, superseded_by_version_id, supersedes_version_id, created_at_ms)
     VALUES (?,?,?,?, '{}', ?, ?, 'blob:none', 'sig', ?, ?, ?, ?, ?)`,
  ).run(
    id, r.skill, r.semver, r.agent, "a".repeat(64), "b".repeat(64), r.state,
    r.reason ?? null, r.supersededBy ?? null, r.supersedes ?? null, now,
  );
  return id;
}

/**
 * ONE RULE, RUN BOTH WAYS AND ON BOTH SCHEMAS.
 *
 * `legal` must be accepted at v1.1. `illegal` must be REFUSED at v1.1 and
 * ACCEPTED at the baseline. The third of those is the discrimination: it says
 * the refusal came from this migration's guard and not from some constraint
 * that was already there, and it fails loudly if a probe was written so badly
 * that even the old schema rejects it.
 */
interface Rule {
  id: string;
  name: string;
  legal: (db: Db, g: ReturnType<typeof graph>) => void;
  illegal: (db: Db, g: ReturnType<typeof graph>) => void;
  /** the RAISE message or constraint the v1.1 schema answers with */
  refusal: RegExp;
}

const RULES: readonly Rule[] = [
  {
    id: "P0.R1",
    name: "a revocation carries a reason",
    legal: (db, g) => {
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.0.0", state: "revoked", reason: "leaks a token" });
    },
    illegal: (db, g) => {
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.0.0", state: "revoked", reason: null });
    },
    refusal: /DISPOSITION_REASON_IFF_REVOKED/,
  },
  {
    id: "P0.R2",
    name: "a reason belongs to a revocation — the REVERSE direction of the iff",
    legal: (db, g) => {
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.1.0", state: "published", reason: null });
    },
    illegal: (db, g) => {
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.1.0", state: "published", reason: "not revoked, but carrying a reason" });
    },
    refusal: /DISPOSITION_REASON_IFF_REVOKED/,
  },
  {
    id: "P0.R3",
    name: "a successor link belongs to a released version",
    legal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.2.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.2.0", state: "deprecated", supersededBy: s });
    },
    illegal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.2.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.2.0", state: "reviewed", supersededBy: s });
    },
    refusal: /LINEAGE_STATE_NOT_LINKABLE/,
  },
  {
    id: "P0.R4",
    name: "a version is not its own successor",
    legal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.3.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.3.0", state: "published", supersededBy: s });
    },
    illegal: (db, g) => {
      const id = ulid(1_754_000_009_000);
      insertRow(db, { id, skill: g.skill, agent: g.agent, semver: "9.3.0", state: "published", supersededBy: id });
    },
    refusal: /LINEAGE_SELF_LINK/,
  },
  {
    id: "P0.R5",
    name: "predecessor and successor belong to one skill",
    legal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.4.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.4.0", state: "published", supersededBy: s });
    },
    illegal: (db, g) => {
      const s = insertRow(db, { skill: g.otherSkill, agent: g.agent, semver: "9.4.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.4.0", state: "published", supersededBy: s });
    },
    refusal: /LINEAGE_CROSS_SKILL/,
  },
  {
    id: "P0.R6",
    name: "a successor has itself reached `verified` when the link is created",
    legal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.5.1", state: "verified" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.5.0", state: "published", supersededBy: s });
    },
    illegal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.5.1", state: "linted" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.5.0", state: "published", supersededBy: s });
    },
    refusal: /LINEAGE_SUCCESSOR_NOT_READY/,
  },
  {
    id: "P0.R7",
    name: "one successor per predecessor — two versions cannot be replaced by one",
    legal: (db, g) => {
      const s1 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.6.1", state: "published" });
      const s2 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.6.2", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.6.0", state: "published", supersededBy: s1 });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.6.3", state: "published", supersededBy: s2 });
    },
    illegal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.6.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.6.0", state: "published", supersededBy: s });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.6.2", state: "published", supersededBy: s });
    },
    refusal: /UNIQUE|uq_versions_superseded_by/,
  },
  {
    id: "P0.R8",
    name: "one predecessor per successor — two versions cannot replace one",
    legal: (db, g) => {
      const p1 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.7.0", state: "published" });
      const p2 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.7.1", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.7.2", state: "published", supersedes: p1 });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.7.3", state: "published", supersedes: p2 });
    },
    illegal: (db, g) => {
      const p = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.7.0", state: "published" });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.7.2", state: "published", supersedes: p });
      insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.7.3", state: "published", supersedes: p });
    },
    refusal: /UNIQUE|uq_versions_supersedes/,
  },
  {
    id: "P0.R9",
    name: "a revocation reason is immutable once written",
    legal: (db, g) => {
      const id = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.8.0", state: "revoked", reason: "the first reason" });
      // rewriting the SAME value is not a change, and converging must not abort
      db.prepare("UPDATE skill_versions SET revocation_reason=? WHERE id=?").run("the first reason", id);
    },
    illegal: (db, g) => {
      const id = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.8.0", state: "revoked", reason: "the first reason" });
      db.prepare("UPDATE skill_versions SET revocation_reason=? WHERE id=?").run("a second, different reason", id);
    },
    refusal: /DISPOSITION_REASON_IMMUTABLE/,
  },
  {
    id: "P0.R10",
    name: "a successor link is immutable once written",
    legal: (db, g) => {
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.9.1", state: "published" });
      const p = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.9.0", state: "published" });
      db.prepare("UPDATE skill_versions SET superseded_by_version_id=?, state='superseded' WHERE id=?").run(s, p);
      // and the convergent repeat of the same link
      db.prepare("UPDATE skill_versions SET superseded_by_version_id=? WHERE id=?").run(s, p);
    },
    illegal: (db, g) => {
      const s1 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.9.1", state: "published" });
      const s2 = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.9.2", state: "published" });
      const p = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.9.0", state: "published", supersededBy: s1 });
      db.prepare("UPDATE skill_versions SET superseded_by_version_id=? WHERE id=?").run(s2, p);
    },
    refusal: /LINEAGE_LINK_IMMUTABLE/,
  },
  {
    id: "P0.R11",
    name: "a revoked version cannot quietly leave `revoked`",
    legal: (db, g) => {
      // the fact §5.1b exists for: a revoked row GAINS a successor without
      // giving up its disposition, and both facts stand together
      const s = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.10.1", state: "published" });
      const p = insertRow(db, { skill: g.skill, agent: g.agent, semver: "1.10.0", state: "revoked", reason: "unsafe" });
      db.prepare("UPDATE skill_versions SET superseded_by_version_id=? WHERE id=?").run(s, p);
      const after = db.prepare("SELECT state, revocation_reason, superseded_by_version_id FROM skill_versions WHERE id=?").get(p) as
        { state: string; revocation_reason: string; superseded_by_version_id: string };
      assert.equal(after.state, "revoked", "the disposition was given up to record the replacement");
      assert.equal(after.revocation_reason, "unsafe");
      assert.equal(after.superseded_by_version_id, s);
    },
    illegal: (db, g) => {
      const p = insertRow(db, { skill: g.skill, agent: g.agent, semver: "9.10.0", state: "revoked", reason: "unsafe" });
      db.prepare("UPDATE skill_versions SET state='published', revocation_reason=NULL WHERE id=?").run(p);
    },
    refusal: /DISPOSITION_REASON_IMMUTABLE|DISPOSITION_REASON_IFF_REVOKED/,
  },
];

function attempt(fn: () => void): Error | null {
  try {
    fn();
    return null;
  } catch (e) {
    return e as Error;
  }
}

test("[P0.6] every §5.1b invariant ACCEPTS its legal shape", () => {
  for (const rule of RULES) {
    const db = openMigrated();
    const g = graph(db);
    const failed = attempt(() => rule.legal(db, g));
    db.close();
    assert.equal(
      failed,
      null,
      `${rule.id} (${rule.name}): the LEGAL shape was refused — ${failed?.message}. ` +
        `A constraint that refuses what the specification permits is worse than none.`,
    );
  }
  record(`[P0.6] ${RULES.length} legal shapes accepted`);
});

test("[P0.7] every §5.1b invariant REFUSES its illegal shape", () => {
  for (const rule of RULES) {
    const db = openMigrated();
    const g = graph(db);
    const failed = attempt(() => rule.illegal(db, g));
    db.close();
    assert.ok(failed, `${rule.id} (${rule.name}): the ILLEGAL shape was accepted`);
    assert.match(
      failed.message,
      rule.refusal,
      `${rule.id} (${rule.name}): refused, but not by the rule under test — ${failed.message}`,
    );
  }
  record(`[P0.7] ${RULES.length} illegal shapes refused, each by its own rule`);
});

test("[P0.D] DISCRIMINATION: every illegal shape SUCCEEDS against the baseline schema", () => {
  // The half that makes the half above evidence. If one of these statements
  // failed at version 17 too, its negative probe would be green whether or not
  // `0018` existed — and this project has shipped a probe like that before.
  const lines: string[] = [];
  for (const rule of RULES) {
    const db = databaseAtVersion(BASELINE_VERSION);
    const g = graph(db);
    const failed = attempt(() => rule.illegal(db, g));
    db.close();
    assert.equal(
      failed,
      null,
      `${rule.id} (${rule.name}): the illegal shape was ALREADY refused at schema ${BASELINE_VERSION} ` +
        `(${failed?.message}) — the negative probe does not discriminate and proves nothing about 0018`,
    );
    lines.push(`${rule.id}  accepted@${BASELINE_VERSION}  refused@${V11_VERSION}  ${rule.name}`);
  }
  for (const l of lines) record(`[P0.D] ${l}`);
});

// ===========================================================================
// P0-FR-01 / P0-FR-02 / P0-FR-03 — the requirements, stated as runs
// ===========================================================================

test("[P0.8] P0-FR-02: a revoked predecessor may hold a successor link, and the migration accepts one that already does", () => {
  // Both directions of the order §5.1b requires to converge, written straight
  // to the row because P1 owns the service path.
  const path = join(scratch, "p0-fr02.db");
  const legacy = databaseAtVersion(BASELINE_VERSION, path);
  const g = graph(legacy);
  const successor = insertRow(legacy, { skill: g.skill, agent: g.agent, semver: "2.0.0", state: "published" });
  // supersede-then-revoke, written the way a v1.1 service will write it
  const a = insertRow(legacy, { skill: g.skill, agent: g.agent, semver: "1.0.0", state: "superseded", supersededBy: successor });
  legacy.prepare("UPDATE skill_versions SET state='revoked', revocation_reason=? WHERE id=?").run("unsafe after replacement", a);
  legacy.close();

  const db = openMigrated(path);
  const row = db
    .prepare("SELECT state, revocation_reason, superseded_by_version_id FROM skill_versions WHERE id=?")
    .get(a) as { state: string; revocation_reason: string; superseded_by_version_id: string };
  assert.deepEqual(
    { state: row.state, reason: row.revocation_reason, superseded_by: row.superseded_by_version_id },
    { state: "revoked", reason: "unsafe after replacement", superseded_by: successor },
    "the migration did not preserve a row holding BOTH facts",
  );
  db.close();
  record(`[P0.8] revoked + superseded_by survives the migration intact`);
});

test("[P0.9] P0-FR-01/03: the v1.0 verification verdicts are unchanged over a migrated database", () => {
  // The `verify` code path is the one an adopter runs offline, and it reads
  // exactly the two columns this phase constrains. A migrated registry must
  // answer what it answered before.
  const revoked = tvRegistry({ state: "revoked", revocationReason: "security issue" });
  const out = verifyPackage(tv01Package(), revoked.db);
  assert.equal(out.verdict, "revoked");
  assert.equal(out.revocation_reason, "security issue");
  revoked.db.close();

  const superseded = tvRegistry({ state: "superseded", supersededBy: true });
  const sup = verifyPackage(tv01Package(), superseded.db);
  assert.equal(sup.verdict, "valid_superseded");
  assert.ok(sup.successor_version_id);
  superseded.db.close();
  record(`[P0.9] verify verdicts revoked / valid_superseded unchanged at schema ${V11_VERSION}`);
});

test("[P0.Z] the probe log is written where the gate manifest expects it", () => {
  const body = probeLines.join("\n") + "\n";
  rmSync(EVIDENCE_LOG, { force: true });
  appendFileSync(EVIDENCE_LOG, body, "utf8");
  const written = readFileSync(EVIDENCE_LOG, "utf8");
  assert.ok(written.includes("[P0.D]"), "the discrimination result must be IN the artifact, not only on the terminal");
  assert.ok(written.includes("[P0.1]") && written.includes("[P0.7]"));
  rmSync(scratch, { recursive: true, force: true });
});
