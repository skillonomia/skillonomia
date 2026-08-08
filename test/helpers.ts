// Shared seed graph for probes: two workspaces, agents, skill, version,
// adoption request + receipt. Mirrors the Appendix G seed.
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

export function seedGraph(): Seed {
  const db = openMigrated();
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

export function insertVersion(
  db: Db,
  skill: string,
  author: string,
  semver: string,
  state: string,
  now: number,
): string {
  const id = ulid(now);
  db.prepare(
    `INSERT INTO skill_versions(id, skill_id, semantic_version, author_agent_id, manifest_json,
       manifest_hash, content_hash, package_blob_ref, signature_jws, state, created_at_ms)
     VALUES (?,?,?,?, '{}', ?, ?, 'blob:none', 'sig', ?, ?)`,
  ).run(id, skill, semver, author, "a".repeat(64), "b".repeat(64), state, now);
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
