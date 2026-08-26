// Shared seed graph for probes: two workspaces, agents, skill, version,
// adoption request + receipt. Mirrors the Appendix G seed.
import { createHash } from "node:crypto";
import type { Db } from "../src/sqlite.ts";
import { openMigrated } from "../src/db.ts";
import { ulid } from "../src/ulid.ts";
import { GATE_NAMES } from "../src/gates.ts";

export interface Seed {
  db: Db;
  wsA: string;
  wsB: string;
  ownerA: string; // human, workspace A
  authorA: string; // agent, workspace A
  adopterA: string; // agent, workspace A
  adopterB: string; // agent, workspace B
  skill: string; // workspace A, owner ownerA
  version: string; // state 'reviewed' by default
  request: string; // adoption_request by adopterA
  receipt: string; // receipt for request
  now: number;
}

export function insertAgent(
  db: Db,
  ws: string,
  name: string,
  type: "human" | "agent" | "service",
  now: number,
): string {
  const id = ulid(now);
  db.prepare(
    "INSERT INTO agents(id, workspace_id, name, type, status, created_at_ms) VALUES (?,?,?,?, 'active', ?)",
  ).run(id, ws, name, type, now);
  return id;
}

/**
 * The seed graph, on a database the caller may supply.
 *
 * The default is what every suite has always got: a freshly migrated in-memory
 * database. The parameter exists for the UPGRADE probe, which has to seed a
 * database left at an OLDER `user_version` and then migrate it — a state no
 * caller of `openMigrated()` can produce, because that function migrates all
 * the way forward by definition. Every statement below names its columns, so it
 * runs against an older schema exactly as it runs against this one.
 */
export function seedGraph(db: Db = openMigrated()): Seed {
  const now = Date.now();
  const wsA = ulid(now);
  const wsB = ulid(now);
  db.prepare("INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)").run(wsA, "ws-a", now);
  db.prepare("INSERT INTO workspaces(id, name, created_at_ms) VALUES (?,?,?)").run(wsB, "ws-b", now);

  const ownerA = insertAgent(db, wsA, "owner-a", "human", now);
  const authorA = insertAgent(db, wsA, "author-a", "agent", now);
  const adopterA = insertAgent(db, wsA, "adopter-a", "agent", now);
  const adopterB = insertAgent(db, wsB, "adopter-b", "agent", now);

  const mem = db.prepare(
    "INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?,?,?)",
  );
  mem.run(ownerA, wsA, "owner", now);
  mem.run(authorA, wsA, "member", now);
  mem.run(adopterA, wsA, "member", now);
  mem.run(adopterB, wsB, "member", now);

  const skill = ulid(now);
  db.prepare(
    "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'workspace', ?)",
  ).run(skill, wsA, "seed-skill", ownerA, now);

  const version = insertVersion(db, skill, authorA, "1.0.0", "reviewed", now);

  const request = ulid(now);
  db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  ).run(request, version, adopterA, now);

  const receipt = ulid(now);
  db.prepare(
    "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
  ).run(receipt, request, version, adopterA, now);

  return { db, wsA, wsB, ownerA, authorA, adopterA, adopterB, skill, version, request, receipt, now };
}

/**
 * A version row in a chosen state, written straight to SQLite so that a test of
 * one rule does not have to drive the whole lifecycle to reach its subject.
 *
 * `revocation_reason` is supplied HERE rather than at every call site, because
 * `migrations/0018` makes it required exactly when `state='revoked'` (§5.1b:
 * the reason is NOT NULL iff the state is `revoked`, both directions) — so a
 * fixture that wrote a revoked row with no reason was writing a row the v1.1
 * data model does not admit, and the trigger is right to refuse it. A caller
 * that cares which reason the row carries passes one; the default exists so
 * that a test about states can go on being about states.
 */
export function insertVersion(
  db: Db,
  skill: string,
  author: string,
  semver: string,
  state: string,
  now: number,
  revocationReason?: string,
): string {
  const id = ulid(now);
  const reason = state === "revoked" ? (revocationReason ?? "fixture revocation") : null;
  db.prepare(
    `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
       manifest_hash, content_hash, package_blob_ref, signature_jws, state, revocation_reason, created_at_ms)
     VALUES (?,?,?,?, '{}', ?, ?, 'blob:none', 'sig', ?, ?, ?)`,
  ).run(id, skill, semver, author, "a".repeat(64), "b".repeat(64), state, reason, now);
  return id;
}

export function insertReceiptEvent(
  db: Db,
  receipt: string,
  event: string,
  seq: number,
  now: number,
  idem?: string,
): void {
  db.prepare(
    `INSERT INTO receipt_events(id, adoption_receipt_id, event, event_seq, server_at_ms, idempotency_key)
     VALUES (?,?,?,?,?,?)`,
  ).run(ulid(now), receipt, event, seq, now, idem ?? `k-${event}-${seq}`);
}

/** Assert fn throws and the message contains needle; returns the message. */
export function expectReject(fn: () => void, needle: string): string {
  try {
    fn();
  } catch (e: any) {
    const msg = String(e.message ?? e);
    if (!msg.includes(needle)) {
      throw new Error(`rejected, but wrong reason: got "${msg}", expected to contain "${needle}"`);
    }
    return msg;
  }
  throw new Error(`expected rejection containing "${needle}", but statement succeeded`);
}

/** Write one lint run (all rows sharing created_at_ms, as the service does). */
export function insertLintRun(
  db: Db,
  versionId: string,
  atMs: number,
  gates: Array<[string, "pass" | "fail" | "warn"]>,
): void {
  const st = db.prepare(
    "INSERT INTO lint_reports(id, skill_version_id, gate, result, details_json, created_at_ms) VALUES (?,?,?,?,NULL,?)",
  );
  for (const [gate, result] of gates) st.run(ulid(atMs), versionId, gate, result, atMs);
}

/**
 * A COMPLETE clean gate run — the §7.1 evidence draft→linted requires. All
 * eight gates must be reported; a partial run is not a run (P3 verdict 2).
 */
export function insertPassingLintRun(db: Db, versionId: string, atMs: number): void {
  insertLintRun(db, versionId, atMs, GATE_NAMES.map((g) => [g, "pass"]));
}

/**
 * An eligible reviewer's `approve` verdict — the evidence linted→reviewed
 * requires (§6 surface 3: "reviewed state requires ≥1 approve"). The reviewer
 * is a fresh same-workspace agent with role `reviewer`, so it is neither the
 * version's author nor the skill's owner. Returns the reviewer's agent id.
 */
export function insertApproveReview(db: Db, seed: Seed, versionId: string, atMs: number): string {
  const reviewer = insertAgent(db, seed.wsA, `reviewer-${ulid(atMs)}`, "agent", atMs);
  db.prepare("INSERT INTO workspace_memberships(agent_id, workspace_id, role, created_at_ms) VALUES (?,?, 'reviewer', ?)").run(
    reviewer,
    seed.wsA,
    atMs,
  );
  db.prepare(
    "INSERT INTO reviews(id, skill_version_id, reviewer_agent_id, verdict, note, created_at_ms) VALUES (?,?,?, 'approve', NULL, ?)",
  ).run(ulid(atMs), versionId, reviewer, atMs);
  return reviewer;
}

/**
 * A FIXTURE WHOSE SHAPE IS A SCANNER'S SHAPE IS ASSEMBLED, NEVER WRITTEN.
 *
 * `test/p7-threats.test.ts` (TM-03) says why: a push-side secret scanner matches
 * the blob, not the intent, and blocks the push on a red-team fixture. GH013
 * refused a whole release candidate over one such literal.
 * `test/p14-r15-probes.test.ts` enforces the rule over every tracked file.
 *
 * Assembly buys that at a price, and this function is the price paid. Where the
 * value was a literal, mangling it changed the file; now a wrong `join` produces
 * a DIFFERENT STRING that can still satisfy the shape the probe asserts, and the
 * probe goes quietly green against material it was never written against.
 * Changing `AKIA` to `AKIB` is still an AWS shape. `join("_")` to `join("")` is
 * still a valid identifier.
 *
 * So the bytes are pinned here, at the assembly, by digest — the one property
 * that no near-miss shares. The digest is safe to write down: it is not the
 * value, it cannot be run backwards, and it carries no scanner's shape.
 *
 * This function does NOT claim the fixture is secret-free or that a scanner
 * will pass it. It claims exactly one thing: these are the bytes the probe
 * downstream was written against.
 */
export function pinnedFixture(value: string, sha256Hex: string, what: string): string {
  const actual = createHash("sha256").update(value, "utf8").digest("hex");
  if (actual !== sha256Hex) {
    throw new Error(
      `${what}: the assembled fixture is not the value this probe was written against — ` +
        `expected sha256 ${sha256Hex}, assembled ${actual} (${value.length} bytes)`,
    );
  }
  return value;
}
