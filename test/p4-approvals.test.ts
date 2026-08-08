// P4 — §7.3 human-approval matrix, negative scope:
// an approval cannot be reused, bypassed, or attached to a different request,
// and a missing approval cannot cause publication. The delivery machine and
// the adoption surfaces are P5; what P4 proves here are the preconditions
// those surfaces will call.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, verifiableVersion, reviewedVersion, adoptedReceipt, goodEvidence, NOW } from "./p4-helpers.ts";
import { isApiError } from "../src/errors.ts";
import { publishVersion } from "../src/countersign.ts";
import {
  APPROVAL_MATRIX,
  approvalConditions,
  requiresHumanApproval,
  adoptionApprovalSatisfied,
  publishApprovalSatisfied,
  isHumanApprover,
  TLOG_APPROVAL,
} from "../src/approvals.ts";
import { makeManifest } from "./p2-helpers.ts";
import { ulid } from "../src/ulid.ts";

/** §7.3 row 1 with the §7.2 cross-field rule satisfied, so it lints clean and
 *  only the approval matrix stands between it and publication. */
function highRiskManifest(): Record<string, unknown> {
  const base = makeManifest({});
  return {
    scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
    safety: { ...base.safety, sandbox_requirement: "required" },
  };
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

/** an adoption request of `versionId` by the given adopter (P5 owns surface 6) */
function request(fx: ReturnType<typeof p4Fixture>, versionId: string, adopter = fx.member.agent_id): string {
  const id = ulid(NOW);
  fx.db
    .prepare(
      "INSERT INTO adoption_requests(id, skill_version_id, adopter_agent_id, state, attempt_count, next_attempt_at_ms, created_at_ms) VALUES (?,?,?, 'pending', 0, 0, ?)",
    )
    .run(id, versionId, adopter, NOW);
  return id;
}

// ------------------------------------------------------------- the human gate

test("the §7.3 human gate: only agents.type='human' with role admin/owner", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "human-gate");
  const req = request(fx, v.versionId);

  for (const [label, actor] of [
    ["a service key holding role admin", fx.service],
    ["a non-human agent holding role admin", fx.botAdmin],
    ["a reviewer", fx.reviewer],
    ["a plain member", fx.member],
    ["the author", fx.author],
  ] as const) {
    rejects(
      () =>
        fx.registry.approve(actor, v.versionId, {
          scope: "adopt_high_risk",
          decision: "approved",
          adoption_request_id: req,
        }),
      "FORBIDDEN",
      /human/,
      );
    assert.equal(label.length > 0, true);
  }
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
    0,
    "no refused attempt left an approvals row behind",
  );
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), false);

  // the human admin can
  const ok = fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req,
  }).response;
  assert.equal(ok.decision, "approved");
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), true);
  fx.db.close();
});

test("the human gate is re-checked when the approval is USED, so a hand-written row is not an authorization", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "forged-approval");
  const req = request(fx, v.versionId);
  // the row a forger writes directly, naming a privileged service identity
  fx.db
    .prepare(
      `INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms)
       VALUES (?,?,?,?, 'adopt_high_risk', 'approved', NULL, ?)`,
    )
    .run(ulid(NOW), v.versionId, req, fx.service.agent_id, NOW);
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), false, "a service identity never satisfies the gate");

  // …and one naming a human of ANOTHER workspace
  const req2 = request(fx, v.versionId);
  fx.db
    .prepare(
      `INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms)
       VALUES (?,?,?,?, 'adopt_high_risk', 'approved', NULL, ?)`,
    )
    .run(ulid(NOW), v.versionId, req2, fx.outsider.agent_id, NOW);
  assert.equal(adoptionApprovalSatisfied(fx.db, req2, fx.seed.wsA), false);

  assert.equal(isHumanApprover(fx.db, fx.admin.agent_id, fx.seed.wsA), true);
  assert.equal(isHumanApprover(fx.db, fx.admin.agent_id, fx.seed.wsB), false, "human admin of ANOTHER workspace");
  assert.equal(isHumanApprover(fx.db, fx.service.agent_id, fx.seed.wsA), false);
  assert.equal(isHumanApprover(fx.db, fx.botAdmin.agent_id, fx.seed.wsA), false);
  assert.equal(isHumanApprover(fx.db, fx.reviewer.agent_id, fx.seed.wsA), false);
  fx.db.close();
});

test("a disabled human admin no longer satisfies the gate", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "disabled-admin");
  const req = request(fx, v.versionId);
  fx.registry.approve(fx.admin, v.versionId, { scope: "adopt_high_risk", decision: "approved", adoption_request_id: req });
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), true);
  fx.db.prepare("UPDATE agents SET status='disabled' WHERE id=?").run(fx.admin.agent_id);
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), false);
  fx.db.close();
});

// ---------------------------------------------------------- per-request binding

test("an adopt_high_risk approval binds ONE request and cannot be moved to another", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "one-request");
  const reqA = request(fx, v.versionId);
  const reqB = request(fx, v.versionId);
  fx.registry.approve(fx.admin, v.versionId, { scope: "adopt_high_risk", decision: "approved", adoption_request_id: reqA });

  assert.equal(adoptionApprovalSatisfied(fx.db, reqA, fx.seed.wsA), true);
  assert.equal(adoptionApprovalSatisfied(fx.db, reqB, fx.seed.wsA), false, "the sibling request is NOT authorized");

  // and it cannot be re-pointed: the D.1 UNIQUE(adoption_request_id, scope)
  // means each request carries at most one decision
  const replay = fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: reqA,
  }).response;
  assert.equal(replay.noop, true, "an identical re-approval converges instead of minting a second authorization");
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c, 1);
  fx.db.close();
});

test("an approval cannot name a request that belongs to a different version", () => {
  const fx = p4Fixture();
  const a = reviewedVersion(fx, "version-a");
  const b = reviewedVersion(fx, "version-b");
  const reqB = request(fx, b.versionId);
  rejects(
    () =>
      fx.registry.approve(fx.admin, a.versionId, {
        scope: "adopt_high_risk",
        decision: "approved",
        adoption_request_id: reqB,
      }),
    "PRECONDITION_FAILED",
    /different skill_version_id/,
  );
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c, 0);
  assert.equal(adoptionApprovalSatisfied(fx.db, reqB, fx.seed.wsA), false);
  fx.db.close();
});

test("a denial is recorded, is not an authorization, and cannot be overwritten by an approval", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "denied");
  const req = request(fx, v.versionId);
  fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "denied",
    adoption_request_id: req,
    note: "not for prod",
  });
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), false);
  rejects(
    () =>
      fx.registry.approve(fx.admin, v.versionId, {
        scope: "adopt_high_risk",
        decision: "approved",
        adoption_request_id: req,
      }),
    "CONFLICT",
  );
  assert.equal(adoptionApprovalSatisfied(fx.db, req, fx.seed.wsA), false, "the denial stands");
  fx.db.close();
});

test("scope shape: adopt_high_risk needs its request, publish must not carry one", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "scope-shape");
  const req = request(fx, v.versionId);
  rejects(() => fx.registry.approve(fx.admin, v.versionId, { scope: "adopt_high_risk", decision: "approved" }), "INVALID_SCHEMA");
  rejects(
    () => fx.registry.approve(fx.admin, v.versionId, { scope: "publish", decision: "approved", adoption_request_id: req }),
    "INVALID_SCHEMA",
  );
  rejects(() => fx.registry.approve(fx.admin, v.versionId, { scope: "adopt", decision: "approved" } as any), "INVALID_SCHEMA");
  rejects(() => fx.registry.approve(fx.admin, v.versionId, { scope: "publish", decision: "yes" } as any), "INVALID_SCHEMA");
  rejects(
    () =>
      fx.registry.approve(fx.admin, v.versionId, {
        scope: "adopt_high_risk",
        decision: "approved",
        adoption_request_id: "01AAAAAAAAAAAAAAAAAAAAAAAA",
      }),
    "NOT_FOUND",
  );
  assert.equal((fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c, 0);
  fx.db.close();
});

test("approvals are transparency-logged", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "approval-tlog");
  fx.registry.approve(fx.admin, v.versionId, { scope: "publish", decision: "approved" });
  const rows = fx.db
    .prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=? AND subject_id=?")
    .get(TLOG_APPROVAL, v.versionId) as any;
  assert.equal(rows.c, 1);
  fx.db.close();
});

test("cross-workspace approval does not exist: NOT_FOUND when invisible", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "cross-ws-approval");
  rejects(() => fx.registry.approve(fx.outsider, v.versionId, { scope: "publish", decision: "approved" }), "NOT_FOUND");
  fx.db.close();
});

// ------------------------------------------------------------ the matrix itself

test("the §7.3 matrix is a data table: every row has a predicate, and low/medium + clean gates is the residual `auto`", () => {
  assert.ok(APPROVAL_MATRIX.length >= 5, "one predicate per §7.3 condition row");
  const auto = makeManifest({});
  assert.equal(auto.scope.risk_level, "low");
  assert.deepEqual(approvalConditions(auto, { adoptedCount: 0 }), [], "TV-01's low-risk package is the `auto` row");
  assert.equal(requiresHumanApproval(auto, { adoptedCount: 0 }), false);

  const high = makeManifest({});
  high.scope.risk_level = "high";
  assert.deepEqual(approvalConditions(high, { adoptedCount: 99 }), ["risk_high"]);

  const iam = makeManifest({});
  iam.runtime.cloud_iam_assumptions = ["arn:aws:iam::role/deployer"];
  assert.deepEqual(approvalConditions(iam, { adoptedCount: 0 }), ["prod_credentials_iam"]);

  const exfil = makeManifest({});
  exfil.safety.url_allowlist = ["https://example.com/ingest"];
  assert.deepEqual(approvalConditions(exfil, { adoptedCount: 0 }), ["network_exfiltration"]);

  // verdict 1, blocking #1: declaring `required_approvals` is NOT a §7.3
  // condition. A low-risk package that declares them is still the `auto` row.
  const declared = makeManifest({});
  declared.scope.required_approvals = ["publish"];
  assert.deepEqual(approvalConditions(declared, { adoptedCount: 0 }), []);
  assert.equal(requiresHumanApproval(declared, { adoptedCount: 0 }), false);
  assert.equal(
    APPROVAL_MATRIX.some((c) => c.id === "author_declared_approvals"),
    false,
    "the §7.3 condition list carries no unlisted row",
  );

  const destructive = makeManifest({});
  destructive.x_ext = { destructive: true };
  assert.deepEqual(approvalConditions(destructive, { adoptedCount: 0 }), ["destructive"]);

  const blast = makeManifest({});
  blast.x_ext = { blast_radius: "large" };
  assert.deepEqual(approvalConditions(blast, { adoptedCount: 2 }), ["low_evidence_large_blast_radius"]);
  assert.deepEqual(approvalConditions(blast, { adoptedCount: 3 }), [], "3 terminal adopted receipts clear the low-evidence row");

  // fail-closed: an unreadable manifest is never `auto`
  assert.equal(requiresHumanApproval(null, { adoptedCount: 99 }), true);
  assert.equal(requiresHumanApproval("not an object" as any, { adoptedCount: 99 }), true);
});

// ----------------------------------------------- publish cannot bypass §7.3

test("§5.1: publication of a version the §7.3 matrix covers is refused without a human approval", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "high-risk-publish", { manifest: highRiskManifest() });
  assert.equal(fx.registry.verifyVersion(fx.owner, v.versionId).response.state, "verified");

  const refused = publishVersion(fx.db, v.versionId, NOW);
  assert.ok(!refused.transition.ok && refused.transition.code === "APPROVAL_REQUIRED");
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "verified");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind='countersign'").get() as any).c,
    0,
    "a refused publication countersigns nothing",
  );

  // a non-human approval does not unlock it
  fx.db
    .prepare(
      `INSERT INTO approvals(id, skill_version_id, adoption_request_id, approver_agent_id, scope, decision, note, created_at_ms)
       VALUES (?,?,NULL,?, 'publish', 'approved', NULL, ?)`,
    )
    .run(ulid(NOW), v.versionId, fx.service.agent_id, NOW);
  assert.ok(!publishVersion(fx.db, v.versionId, NOW).transition.ok);
  assert.equal(publishApprovalSatisfied(fx.db, v.versionId, fx.seed.wsA), false);

  // the human admin's approval does
  fx.registry.approve(fx.admin, v.versionId, { scope: "publish", decision: "approved" });
  assert.equal(publishApprovalSatisfied(fx.db, v.versionId, fx.seed.wsA), true);
  const ok = publishVersion(fx.db, v.versionId, NOW);
  assert.ok(ok.transition.ok && ok.transition.state === "published");
  fx.db.close();
});

// P4 verdict 1, blocking #1 — the exact scenario the reviewer reproduced.
test("§7.3 `auto`: a low-risk, all-gates-pass version publishes with NO human approval, even when it declares required_approvals", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = verifiableVersion(fx, "auto-publishable", {
    manifest: { scope: { ...base.scope, risk_level: "low", required_approvals: ["publish"] } },
  });
  assert.equal(fx.registry.verifyVersion(fx.owner, v.versionId).response.state, "verified");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM approvals").get() as any).c,
    0,
    "no approval exists — and none is due",
  );
  const out = publishVersion(fx.db, v.versionId, NOW);
  assert.ok(out.transition.ok, `the §7.3 auto row must publish: ${JSON.stringify(out.transition)}`);
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "published");
  fx.db.close();
});

test("a publish approval for ANOTHER version does not publish this one", () => {
  const fx = p4Fixture();
  const a = verifiableVersion(fx, "publish-a", { manifest: highRiskManifest() });
  const b = verifiableVersion(fx, "publish-b", { manifest: highRiskManifest() });
  fx.registry.verifyVersion(fx.owner, a.versionId);
  fx.registry.verifyVersion(fx.owner, b.versionId);
  fx.registry.approve(fx.admin, a.versionId, { scope: "publish", decision: "approved" });

  assert.ok(publishVersion(fx.db, a.versionId, NOW).transition.ok);
  const refused = publishVersion(fx.db, b.versionId, NOW);
  assert.ok(!refused.transition.ok && refused.transition.code === "APPROVAL_REQUIRED");
  fx.db.close();
});

test("low evidence + large blast radius blocks publication until the receipts exist", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "blast-radius", { manifest: { x_ext: { blast_radius: "large" } } });
  fx.registry.verifyVersion(fx.owner, v.versionId);
  assert.ok(!publishVersion(fx.db, v.versionId, NOW).transition.ok, "1 adopted receipt is < 3");

  adoptedReceipt(fx, v.versionId, goodEvidence(v.manifest), { adopter: fx.reviewer.agent_id });
  adoptedReceipt(fx, v.versionId, goodEvidence(v.manifest), { adopter: fx.reviewer2.agent_id });
  const ok = publishVersion(fx.db, v.versionId, NOW);
  assert.ok(ok.transition.ok, "3 terminal adopted receipts clear the §7.3 low-evidence row");
  fx.db.close();
});
