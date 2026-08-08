// Appendix D.2 — all 16 mandatory SQL probes (T-1…T-16), P0 CI gate.
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedGraph, insertAgent, insertVersion, insertReceiptEvent, expectReject } from "./helpers.ts";
import { ulid } from "../src/ulid.ts";

test("T-1 invalid enum event → CHECK reject", () => {
  const s = seedGraph();
  expectReject(() => insertReceiptEvent(s.db, s.receipt, "exploded", 1, s.now), "CHECK");
});

test("T-2 second terminal event (failed after adopted) → partial-unique reject", () => {
  const s = seedGraph();
  insertReceiptEvent(s.db, s.receipt, "delivered", 1, s.now);
  insertReceiptEvent(s.db, s.receipt, "attempted", 2, s.now);
  insertReceiptEvent(s.db, s.receipt, "adopted", 3, s.now);
  expectReject(() => insertReceiptEvent(s.db, s.receipt, "failed", 4, s.now), "UNIQUE");
});

test("T-3 UPDATE receipt_events → INSERT_ONLY", () => {
  const s = seedGraph();
  insertReceiptEvent(s.db, s.receipt, "delivered", 1, s.now);
  expectReject(() => s.db.exec("UPDATE receipt_events SET event='adopted'"), "INSERT_ONLY");
});

test("T-4 DELETE adoption_receipts → INSERT_ONLY", () => {
  const s = seedGraph();
  expectReject(() => s.db.exec("DELETE FROM adoption_receipts"), "INSERT_ONLY");
});

test("T-5 UPDATE transparency_log → INSERT_ONLY", () => {
  const s = seedGraph();
  s.db.prepare(
    "INSERT INTO transparency_log(seq, event_kind, subject_id, payload_hash, prev_hash, this_hash, server_at_ms) VALUES (1,'publish','x',?,?,?,?)",
  ).run("c".repeat(64), "0".repeat(64), "d".repeat(64), s.now);
  expectReject(() => s.db.exec("UPDATE transparency_log SET event_kind='forged'"), "INSERT_ONLY");
});

test("T-6 duplicate kid → UNIQUE reject", () => {
  const s = seedGraph();
  const ins = s.db.prepare(
    "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms) VALUES (?,?,?,?,?)",
  );
  ins.run(ulid(s.now), s.authorA, "kid-1", "A".repeat(43), s.now);
  expectReject(() => ins.run(ulid(s.now), s.adopterA, "kid-1", "B".repeat(43), s.now), "UNIQUE");
});

test("T-7 second receipt per request → UNIQUE reject", () => {
  const s = seedGraph();
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
      ).run(ulid(s.now), s.request, s.version, s.adopterA, s.now),
    "UNIQUE",
  );
});

test("T-8 orphan receipt_event → FK reject", () => {
  const s = seedGraph();
  expectReject(() => insertReceiptEvent(s.db, ulid(s.now), "delivered", 1, s.now), "FOREIGN KEY");
});

test("T-9 cross-workspace adoption of non-published version → tenancy-trigger reject", () => {
  const s = seedGraph();
  // version is 'reviewed'; adopterB is in workspace B
  const req = ulid(s.now);
  s.db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  ).run(req, s.version, s.adopterB, s.now);
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
      ).run(ulid(s.now), req, s.version, s.adopterB, s.now),
    "TENANCY_CROSS_WS_REQUIRES_PUBLISHED",
  );
});

test("T-9 positive control: cross-workspace receipt on published version accepted", () => {
  const s = seedGraph();
  const pub = insertVersion(s.db, s.skill, s.authorA, "2.0.0", "published", s.now);
  const req = ulid(s.now);
  s.db.prepare(
    "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
  ).run(req, pub, s.adopterB, s.now);
  s.db.prepare(
    "INSERT INTO adoption_receipts(id, adoption_request_id, skill_version_id, adopter_agent_id, created_at_ms) VALUES (?,?,?,?,?)",
  ).run(ulid(s.now), req, pub, s.adopterB, s.now);
});

test("T-10 attempt_count>5 → CHECK reject", () => {
  const s = seedGraph();
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 6, 0, ?)",
      ).run(ulid(s.now), s.version, s.adopterA, s.now),
    "CHECK",
  );
});

test("T-11 duplicate event kind per receipt → UNIQUE reject", () => {
  const s = seedGraph();
  insertReceiptEvent(s.db, s.receipt, "delivered", 1, s.now);
  expectReject(() => insertReceiptEvent(s.db, s.receipt, "delivered", 2, s.now), "UNIQUE");
});

test("T-12 skill owner from another workspace → TENANCY_OWNER_NOT_IN_WS", () => {
  const s = seedGraph();
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO skills(id, workspace_id, slug, owner_agent_id, access_policy, created_at_ms) VALUES (?,?,?,?, 'private', ?)",
      ).run(ulid(s.now), s.wsA, "bad-owner", s.adopterB, s.now),
    "TENANCY_OWNER_NOT_IN_WS",
  );
});

test("T-13 version author from another workspace → TENANCY_AUTHOR_NOT_IN_WS", () => {
  const s = seedGraph();
  expectReject(
    () => insertVersion(s.db, s.skill, s.adopterB, "9.9.9", "draft", s.now),
    "TENANCY_AUTHOR_NOT_IN_WS",
  );
});

test("T-14 adopt_high_risk approval without adoption_request_id → CHECK reject", () => {
  const s = seedGraph();
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, created_at_ms) VALUES (?,?, NULL, ?, 'adopt_high_risk', 'approved', ?)",
      ).run(ulid(s.now), s.version, s.ownerA, s.now),
    "CHECK",
  );
});

test("T-15 kid with forbidden charset → CHECK reject", () => {
  const s = seedGraph();
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO signing_keys(id, agent_id, kid, public_key_ed25519, created_at_ms) VALUES (?,?,?,?,?)",
      ).run(ulid(s.now), s.authorA, "Bad_KID!", "C".repeat(43), s.now),
    "CHECK",
  );
});

test("T-16 adopt_high_risk approval with version mismatching its request → APPROVAL_VERSION_MISMATCH", () => {
  const s = seedGraph();
  const v2 = insertVersion(s.db, s.skill, s.authorA, "2.0.0", "reviewed", s.now);
  // s.request belongs to s.version (V1); approval claims v2
  expectReject(
    () =>
      s.db.prepare(
        "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, created_at_ms) VALUES (?,?,?,?, 'adopt_high_risk', 'approved', ?)",
      ).run(ulid(s.now), v2, s.request, s.ownerA, s.now),
    "APPROVAL_VERSION_MISMATCH",
  );
});

test("T-16 positive control: matching version accepted", () => {
  const s = seedGraph();
  s.db.prepare(
    "INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, created_at_ms) VALUES (?,?,?,?, 'adopt_high_risk', 'approved', ?)",
  ).run(ulid(s.now), s.version, s.request, s.ownerA, s.now);
  const c = s.db.prepare("SELECT count(*) c FROM approvals").get() as { c: number };
  assert.equal(c.c, 1);
});
