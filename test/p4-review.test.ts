// P4 — surface 3 `skill.review.request`: who may review, and the atomicity of
// an approve verdict (§6: "reviews and reviewer attestations cannot diverge,
// so the verified-gate conjunction has exactly one source of reviewer truth").
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, createVersion, lint, reviewedVersion, publishedVersion, NOW } from "./p4-helpers.ts";
import { isApiError } from "../src/errors.ts";
import { TLOG_ATTESTATION } from "../src/service.ts";
import { transitionVersion, eligibleApproveReviewers } from "../src/transitions.ts";
import { ulid } from "../src/ulid.ts";

function linted(fx: ReturnType<typeof p4Fixture>, slug: string) {
  const v = createVersion(fx, slug);
  assert.equal(lint(fx, v.versionId), "linted");
  return v;
}

function rejects(fn: () => unknown, code: string, message?: RegExp): void {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
  }
}

// ------------------------------------------------------------- self-review

test("the version author may not review their own version (§6 surface 3: self-review rejected)", () => {
  const fx = p4Fixture();
  const v = linted(fx, "self-review");
  rejects(() => fx.registry.review(fx.author, v.versionId, { action: "verdict", verdict: "approve" }), "FORBIDDEN", /self-review/);
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE skill_version_id=?").get(v.versionId) as any).c,
    0,
    "a refused verdict writes no review row",
  );
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=?").get(v.versionId) as any).c,
    0,
  );
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "linted");
  fx.db.close();
});

test("an author who ALSO holds admin still cannot review their own version", () => {
  const fx = p4Fixture();
  // admin (role admin, human) authors this version
  const v = createVersion(fx, "admin-authored", { author: fx.admin });
  assert.equal(lint(fx, v.versionId, fx.admin), "linted");
  rejects(() => fx.registry.review(fx.admin, v.versionId, { action: "verdict", verdict: "approve" }), "FORBIDDEN", /self-review/);
  fx.db.close();
});

test("the skill owner may not review their own skill", () => {
  const fx = p4Fixture();
  const owned = createVersion(fx, "owner-reviews", { author: fx.reviewer2 });
  const v = createVersion(fx, "owner-reviews", {
    skill_id: owned.skillId,
    semver: "2.0.0",
    manifest: { skill_id: owned.skillId },
    author: fx.admin,
  });
  assert.equal(lint(fx, v.versionId, fx.admin), "linted");
  rejects(() => fx.registry.review(fx.reviewer2, v.versionId, { action: "verdict", verdict: "approve" }), "FORBIDDEN", /skill owner/);
  fx.db.close();
});

// ------------------------------------------------------------------ the ACL

test("a plain member cannot submit a verdict; reviewer/admin/owner can (§5.1)", () => {
  const fx = p4Fixture();
  const v = linted(fx, "member-verdict");
  rejects(
    () => fx.registry.review(fx.member, v.versionId, { action: "verdict", verdict: "approve" }),
    "FORBIDDEN",
    /reviewer\/admin\/owner/,
  );
  const ok = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }).response;
  assert.equal(ok.state, "reviewed");
  fx.db.close();
});

test("cross-workspace review does not exist in v1 (§5.1): FORBIDDEN when visible, NOT_FOUND when not", () => {
  const fx = p4Fixture();
  // invisible to the outsider (workspace-policy, non-published) → not acknowledged
  const hidden = linted(fx, "hidden-from-outside");
  rejects(() => fx.registry.review(fx.outsider, hidden.versionId, { action: "verdict", verdict: "approve" }), "NOT_FOUND");

  // published + public policy → the outsider CAN see it, and gets the §5.1 answer
  const seen = publishedVersion(fx, "visible-outside");
  fx.db.prepare("UPDATE skills SET access_policy='public' WHERE id=?").run(seen.skillId);
  rejects(
    () => fx.registry.review(fx.outsider, seen.versionId, { action: "verdict", verdict: "approve" }),
    "FORBIDDEN",
    /cross-workspace/,
  );
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE skill_version_id=?").get(seen.versionId) as any).c,
    1,
    "only the legitimate in-workspace review exists",
  );
  fx.db.close();
});

test("requesting a review is an author/owner action, and only for a version that passed the gates", () => {
  const fx = p4Fixture();
  const draft = createVersion(fx, "request-on-draft");
  rejects(() => fx.registry.review(fx.author, draft.versionId, { action: "request" }), "PRECONDITION_FAILED", /linted/);

  const v = linted(fx, "request-acl");
  rejects(() => fx.registry.review(fx.member, v.versionId, { action: "request" }), "FORBIDDEN");
  // verdict 1, blocking #2: Appendix H says "request: author/owner". A
  // workspace admin who is neither the version's author nor the skill's owner
  // is not on that list — and neither is a reviewer or a workspace owner who
  // owns nothing here.
  for (const outsiderToTheRow of [fx.admin, fx.reviewer, fx.owner]) {
    rejects(
      () => fx.registry.review(outsiderToTheRow, v.versionId, { action: "request" }),
      "FORBIDDEN",
      /author or the skill owner/,
    );
  }
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM activity_log WHERE subject_id=? AND action='skill.review.request'").get(v.versionId) as any).c,
    0,
    "no refused request was recorded",
  );
  const out = fx.registry.review(fx.author, v.versionId, { action: "request" }).response;
  assert.equal(out.review_id, null, "a request is not a review");
  assert.equal(out.state, "linted");
  // §5.1 eligibility: reviewer/admin/owner, never the author or the skill owner
  assert.ok(out.notified!.includes(fx.reviewer.agent_id));
  assert.ok(out.notified!.includes(fx.admin.agent_id));
  assert.ok(!out.notified!.includes(fx.author.agent_id), "the author is never notified as an eligible reviewer");
  assert.ok(!out.notified!.includes(fx.member.agent_id), "a plain member is not an eligible reviewer");
  assert.ok(!out.notified!.includes(fx.outsider.agent_id), "no cross-workspace reviewer exists in v1");
  const logged = fx.db
    .prepare("SELECT COUNT(*) AS c FROM activity_log WHERE subject_id=? AND action='skill.review.request'")
    .get(v.versionId) as any;
  assert.equal(logged.c, 1);
  fx.db.close();
});

// ------------------------------------------------------------- atomicity

test("an approve verdict writes review + attestation + tlog + the transition in ONE transaction", () => {
  const fx = p4Fixture();
  const v = linted(fx, "atomic-approve");
  const out = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve", note: "looks right" }).response;

  assert.equal(out.state, "reviewed");
  const review = fx.db.prepare("SELECT * FROM reviews WHERE skill_version_id=?").get(v.versionId) as any;
  const attestation = fx.db.prepare("SELECT * FROM attestations WHERE skill_version_id=?").get(v.versionId) as any;
  assert.equal(review.reviewer_agent_id, fx.reviewer.agent_id);
  assert.equal(review.verdict, "approve");
  assert.equal(attestation.attester_agent_id, fx.reviewer.agent_id);
  assert.equal(attestation.kind, "reviewer");
  assert.equal(JSON.parse(attestation.payload_json).review_id, review.id);
  assert.equal(out.review_id, review.id);
  assert.equal(out.attestation_id, attestation.id);
  const tl = fx.db
    .prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=? AND subject_id=?")
    .get(TLOG_ATTESTATION, v.versionId) as any;
  assert.equal(tl.c, 1, "§8 threat 7: attestations are logged");
  fx.db.close();
});

test("reject and conditional record a review, write NO attestation and do not transition", () => {
  const fx = p4Fixture();
  for (const verdict of ["reject", "conditional"] as const) {
    const v = linted(fx, `verdict-${verdict}`);
    const out = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict }).response;
    assert.equal(out.state, "linted");
    assert.equal(out.attestation_id, null);
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=?").get(v.versionId) as any).c,
      0,
      `${verdict} must not produce a reviewer attestation`,
    );
    assert.equal(
      (fx.db.prepare("SELECT COUNT(*) AS c FROM reviews WHERE skill_version_id=?").get(v.versionId) as any).c,
      1,
    );
  }
  fx.db.close();
});

test("a reject cannot be laundered into `reviewed` by repeating it", () => {
  const fx = p4Fixture();
  const v = linted(fx, "repeat-reject");
  for (let i = 0; i < 3; i += 1) {
    fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "reject", note: `no ${i}` });
  }
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "linted");
  fx.db.close();
});

test("a verdict on a draft (ungated) version is refused with its current state", () => {
  const fx = p4Fixture();
  const v = createVersion(fx, "verdict-on-draft");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }), "PRECONDITION_FAILED");
  fx.db.close();
});

test("a second approve on an already-reviewed version records a second attestation without re-transitioning", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "second-approve");
  const out = fx.registry.review(fx.reviewer2, v.versionId, { action: "verdict", verdict: "approve" }).response;
  assert.equal(out.state, "reviewed");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=?").get(v.versionId) as any).c,
    2,
  );
  fx.db.close();
});

test("bad input is INVALID_SCHEMA, never a crash or a silent default", () => {
  const fx = p4Fixture();
  const v = linted(fx, "bad-review-input");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, {} as any), "INVALID_SCHEMA");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, { action: "approve" } as any), "INVALID_SCHEMA");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, { action: "verdict" }), "INVALID_SCHEMA");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "APPROVE" as any }), "INVALID_SCHEMA");
  rejects(() => fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve", note: 42 as any }), "INVALID_SCHEMA");
  rejects(() => fx.registry.review(fx.reviewer, 42 as any, { action: "request" }), "INVALID_SCHEMA");
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "linted");
  fx.db.close();
});

test("the idempotency key replays a verdict instead of writing a second attestation", () => {
  const fx = p4Fixture();
  const v = linted(fx, "idempotent-verdict");
  const first = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }, "k-1");
  const replay = fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" }, "k-1");
  assert.equal(replay.replayed, true);
  assert.equal(replay.responseJson, first.responseJson, "byte-identical replay (Appendix H)");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM attestations WHERE skill_version_id=?").get(v.versionId) as any).c,
    1,
  );
  fx.db.close();
});

// §6 surface 3 "reviewed state requires ≥1 approve", enforced in the exported
// transition function too — otherwise that function is itself the bypass, and
// the whole reviewer conjunct of §5.1 could be reached without a review.
test("the generic transition cannot reach `reviewed` without an eligible approve review", () => {
  const fx = p4Fixture();
  const v = linted(fx, "no-approve-review");
  const refused = transitionVersion(fx.db, v.versionId, "reviewed");
  assert.ok(!refused.ok && refused.code === "REVIEW_NOT_APPROVED", JSON.stringify(refused));
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "linted");

  // a REJECT verdict is not an approve
  fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "reject" });
  assert.ok(!transitionVersion(fx.db, v.versionId, "reviewed").ok);

  // an approve by an INELIGIBLE reviewer is not an approve either
  for (const ineligible of [fx.author.agent_id, fx.member.agent_id, fx.outsider.agent_id]) {
    fx.db
      .prepare("INSERT INTO reviews(id, skill_version_id, reviewer_agent_id, verdict, note, created_at_ms) VALUES (?,?,?, 'approve', NULL, ?)")
      .run(ulid(NOW + ineligible.length), v.versionId, ineligible, NOW);
  }
  assert.deepEqual(eligibleApproveReviewers(fx.db, v.versionId), []);
  assert.ok(!transitionVersion(fx.db, v.versionId, "reviewed").ok);

  // the genuine article does move it
  fx.registry.review(fx.reviewer2, v.versionId, { action: "verdict", verdict: "approve" });
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "reviewed");
  assert.deepEqual(eligibleApproveReviewers(fx.db, v.versionId), [fx.reviewer2.agent_id]);
  fx.db.close();
});

test("an unknown version is NOT_FOUND on every review action", () => {
  const fx = p4Fixture();
  rejects(() => fx.registry.review(fx.reviewer, "01AAAAAAAAAAAAAAAAAAAAAAAA", { action: "request" }), "NOT_FOUND");
  rejects(
    () => fx.registry.review(fx.reviewer, "01AAAAAAAAAAAAAAAAAAAAAAAA", { action: "verdict", verdict: "approve" }),
    "NOT_FOUND",
  );
  fx.db.close();
});

test("a key with no workspace membership cannot touch the review surface", () => {
  const fx = p4Fixture();
  const v = linted(fx, "no-membership");
  const stranger = { ...fx.member, role: null };
  rejects(() => fx.registry.review(stranger, v.versionId, { action: "request" }), "FORBIDDEN", /membership/);
  assert.equal(NOW > 0, true);
  fx.db.close();
});
