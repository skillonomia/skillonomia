// P5 — surfaces 6–9 through the real API, and the phase's headline acceptance
// item (internal phase plan, P5): the first end-to-end `reviewed → trial
// adoption → evidence receipt → verified` pass, which
// COMPLETES the P4 gate proof. P4 showed the gate cannot be faked; this shows
// it opens for a genuine receipt, produced only through the surfaces.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, reviewedVersion, createVersion, lint, goodEvidence, NOW, type P4Fixture } from "./p4-helpers.ts";
import { handleRest, type RestResponse } from "../src/http.ts";
import { isApiError } from "../src/errors.ts";
import { derivedState } from "../src/receipts.ts";
import { loadRequest } from "../src/delivery.ts";
import { publishVersion } from "../src/countersign.ts";
import { makeManifest } from "./p2-helpers.ts";

const ENV = {
  runtime: { id: "claude-code", version: "2.1.0" },
  model: { id: "any", version: "1.0.0" },
  tools: [{ id: "shell", version: "5.2.0" }],
  os: "linux",
  shell: "bash",
  sandbox_capable: true,
};

function rest(fx: P4Fixture, method: string, url: string, key: string, body?: unknown): { status: number; body: any } {
  const res: RestResponse = handleRest(fx.registry, {
    method,
    url,
    headers: { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
  return { status: res.status, body: JSON.parse(res.body) };
}

function mcp(fx: P4Fixture, key: string, name: string, args: any): { isError: boolean; data: any } {
  const res = rest(fx, "POST", "/mcp", key, { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } });
  return { isError: res.body.result.isError === true, data: JSON.parse(res.body.result.content[0].text) };
}

function rejects(fn: () => unknown, code: string, message?: RegExp): any {
  try {
    fn();
    assert.fail(`expected ${code}`);
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, code, e.message);
    if (message) assert.match(e.message, message);
    return e;
  }
}

// =========================================================== THE POSITIVE E2E

test("E2E (phase plan, P5): reviewed → trial adoption → evidence receipt → verified, through the surfaces only", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "e2e-trial-adoption");
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "reviewed");

  // the gate is shut before any receipt exists — this is P4's proof, restated
  // here as the baseline the rest of the test moves off
  const before = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(before.verdict, "not_verified");
  assert.equal(before.checks.find((c) => c.id === "evidence_receipt")!.satisfied, false);

  // §5.1 trial-adoption lane: a `reviewed` version is adoptable WORKSPACE-
  // INTERNALLY, and its receipts satisfy the verified-gate evidence conjunct.
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  assert.equal(requested.status, 201);
  assert.equal(requested.body.state, "pending", "a low-risk package needs no §7.3 approval");
  const { adoption_request_id: reqId, receipt_id: receiptId } = requested.body;

  const adopted = rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, { environment_descriptor: ENV });
  assert.equal(adopted.status, 200);
  assert.equal(adopted.body.receipt_event, "delivered");
  // seq 2, not 1: the chain's first row is the `requested` event the registry
  // wrote in the transaction that opened it, naming the recipient of this pull.
  assert.equal(adopted.body.event_seq, 2);
  assert.equal(adopted.body.compat.result, "match");
  assert.ok(adopted.body.package.archive_base64.length > 0, "the package is actually handed over");

  const attempted = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member, { event: "attempted" });
  assert.equal(attempted.body.event_seq, 3);

  const evidence = goodEvidence(v.manifest);
  const done = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member, { event: "adopted", evidence });
  assert.equal(done.body.receipt_event, "adopted");
  assert.equal(done.body.event_seq, 4);
  assert.equal(derivedState(fx.db, receiptId), "adopted");

  // …and NOW the §5.1 conjunction is complete, so the same call that refused
  // above transitions the version.
  const after = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(after.verdict, "valid", JSON.stringify(after.checks));
  assert.equal(after.state, "verified");
  assert.ok(after.checks.every((c) => c.satisfied));
  assert.equal((fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(v.versionId) as any).state, "verified");

  // the whole chain is auditable, in event_seq order
  const view = rest(fx, "GET", `/v1/receipts/${receiptId}`, fx.keys.member);
  assert.deepEqual(view.body.events.map((e: any) => e.event), ["requested", "delivered", "attempted", "adopted"]);
  assert.equal(view.body.derived_state, "adopted");
  assert.equal(view.body.stalled, false);

  // surface 9: the rating right the terminal receipt confers
  const rated = rest(fx, "POST", `/v1/versions/${v.versionId}/ratings`, fx.keys.member, {
    score: 5,
    adoption_receipt_id: receiptId,
    note: "worked first time",
  });
  assert.equal(rated.status, 201);
  const registry = fx.registry.registryView(fx.db.prepare("SELECT * FROM skill_versions WHERE id=?").get(v.versionId) as any);
  assert.equal(registry.reputation.adopted_count, 1);
  assert.equal(registry.reputation.avg_rating, 5);
  assert.deepEqual(registry.receipt_ids, [receiptId]);
  fx.db.close();
});

test("the same E2E over MCP reaches the identical state", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "e2e-over-mcp");
  const req = mcp(fx, fx.keys.member, "skill.request_adoption", { skill_version_id: v.versionId });
  assert.equal(req.isError, false);
  const adopt = mcp(fx, fx.keys.member, "skill.adopt", {
    adoption_request_id: req.data.adoption_request_id,
    environment_descriptor: ENV,
  });
  assert.equal(adopt.data.receipt_event, "delivered");
  mcp(fx, fx.keys.member, "skill.validate_outcome", { receipt_id: req.data.receipt_id, event: "attempted" });
  const done = mcp(fx, fx.keys.member, "skill.validate_outcome", {
    receipt_id: req.data.receipt_id,
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(done.data.receipt_event, "adopted");
  assert.equal(mcp(fx, fx.keys.owner, "skill.verify", { skill_version_id: v.versionId }).data.state, "verified");
  fx.db.close();
});

// ================================================== surface 6: the ACL + holds

test("§5.1 probe T-9: cross-workspace adoption accepts ONLY published versions", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "t9-probe");
  fx.db.prepare("UPDATE skills SET access_policy='public' WHERE id=?").run(v.skillId);

  // a `reviewed` version is invisible outside its workspace: not acknowledged
  rejects(() => fx.registry.requestAdoption(fx.outsider, { skill_version_id: v.versionId }), "NOT_FOUND");

  // even once VERIFIED — `verified` is an internal-only state (BLOCKER-9)
  fx.db.prepare("UPDATE skill_versions SET state='verified' WHERE id=?").run(v.versionId);
  rejects(() => fx.registry.requestAdoption(fx.outsider, { skill_version_id: v.versionId }), "NOT_FOUND");

  // published: the outsider may adopt
  fx.db.prepare("UPDATE skill_versions SET state='published' WHERE id=?").run(v.versionId);
  const ok = fx.registry.requestAdoption(fx.outsider, { skill_version_id: v.versionId }).response;
  assert.equal(ok.state, "pending");
  fx.db.close();
});

test("draft/linted are not adoptable, and a revoked version is blocked", () => {
  const fx = p4Fixture();
  const draft = createVersion(fx, "not-adoptable");
  rejects(() => fx.registry.requestAdoption(fx.member, { skill_version_id: draft.versionId }), "NOT_FOUND");
  lint(fx, draft.versionId);
  // linted is "owner + admins only; no adoption" — visible to the owner, but
  // still not adoptable
  rejects(() => fx.registry.requestAdoption(fx.owner, { skill_version_id: draft.versionId }), "PRECONDITION_FAILED");

  const pub = reviewedVersion(fx, "revoked-adoption");
  fx.db.prepare("UPDATE skill_versions SET state='published' WHERE id=?").run(pub.versionId);
  fx.registry.revokeVersion(fx.owner, pub.versionId, { reason: "withdrawn" });
  rejects(() => fx.registry.requestAdoption(fx.member, { skill_version_id: pub.versionId }), "PRECONDITION_FAILED", /revoked/);
  fx.db.close();
});

test("§5.2 hold: a §7.3 condition holds the request, and only a bound human approval releases it", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = reviewedVersion(fx, "held-adoption", {
    manifest: {
      scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  });

  const requested = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  assert.equal(requested.state, "approval_pending", "the request exists, but held");
  assert.ok(requested.approval_required!.includes("risk_high"));

  // a missing approval cannot cause adoption
  rejects(
    () => fx.registry.adopt(fx.member, requested.adoption_request_id, { environment_descriptor: ENV }),
    "FORBIDDEN",
    /human approval/,
  );
  assert.equal(derivedState(fx.db, requested.receipt_id), "requested", "nothing was delivered: the chain is still at the event that opened it");

  // an approval bound to a DIFFERENT request does not release this one
  const other = fx.registry.requestAdoption(fx.reviewer, { skill_version_id: v.versionId }).response;
  fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: other.adoption_request_id,
  });
  rejects(() => fx.registry.adopt(fx.member, requested.adoption_request_id, { environment_descriptor: ENV }), "FORBIDDEN");

  // the matching one does — once the service releases the hold
  fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: requested.adoption_request_id,
  });
  assert.equal(loadRequest(fx.db, requested.adoption_request_id)!.state, "pending");
  const out = fx.registry.adopt(fx.member, requested.adoption_request_id, { environment_descriptor: ENV }).response;
  assert.equal(out.receipt_event, "delivered");
  fx.db.close();
});

test("§5.2: a denial terminals the request as dead_letter(approval_denied)", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = reviewedVersion(fx, "denied-adoption", {
    manifest: {
      scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  });
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "denied",
    adoption_request_id: req.adoption_request_id,
    note: "not for this fleet",
  });
  const row = loadRequest(fx.db, req.adoption_request_id)!;
  assert.equal(row.state, "dead_letter");
  assert.equal(row.dead_letter_reason, "approval_denied");
  rejects(() => fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV }), "PRECONDITION_FAILED");
  fx.db.close();
});

// ==================================================== surface 7: adopt rules

test("only the request's own adopter may adopt", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "adopt-acl");
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  for (const intruder of [fx.author, fx.owner, fx.admin, fx.outsider]) {
    rejects(() => fx.registry.adopt(intruder, req.adoption_request_id, { environment_descriptor: ENV }), "NOT_FOUND");
  }
  assert.equal(derivedState(fx.db, req.receipt_id), "requested");
  fx.db.close();
});

test("§7.2: a high-risk package is not handed to an adopter that cannot attest a sandbox", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = reviewedVersion(fx, "sandbox-required", {
    manifest: {
      scope: { ...base.scope, risk_level: "high", required_approvals: ["publish", "adopt_high_risk"] },
      safety: { ...base.safety, sandbox_requirement: "required" },
    },
  });
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.approve(fx.admin, v.versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req.adoption_request_id,
  });
  rejects(
    () => fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: { ...ENV, sandbox_capable: false } }),
    "FORBIDDEN",
    /sandbox/,
  );
  assert.equal(fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV }).response.receipt_event, "delivered");
  fx.db.close();
});

test("§4.2: a mismatch blocks at medium/high risk and warns at low — two outcomes only", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const wrongEnv = { ...ENV, os: "windows" };

  const low = reviewedVersion(fx, "compat-low");
  const lowReq = fx.registry.requestAdoption(fx.member, { skill_version_id: low.versionId }).response;
  const warned = fx.registry.adopt(fx.member, lowReq.adoption_request_id, { environment_descriptor: wrongEnv }).response;
  assert.equal(warned.compat.result, "mismatch");
  assert.deepEqual(warned.compat.unmet, ["os"]);
  assert.match(warned.warning!, /mismatch/);
  assert.equal(warned.receipt_event, "delivered", "low risk: handed over with a warning");

  const med = reviewedVersion(fx, "compat-medium", {
    manifest: { scope: { ...base.scope, risk_level: "medium" } },
  });
  const medReq = fx.registry.requestAdoption(fx.member, { skill_version_id: med.versionId }).response;
  const err = rejects(
    () => fx.registry.adopt(fx.member, medReq.adoption_request_id, { environment_descriptor: wrongEnv }),
    "PRECONDITION_FAILED",
    /does not match/,
  );
  assert.ok(err.message.includes("os"), "the block names the unmet clause");
  assert.equal(derivedState(fx.db, medReq.receipt_id), "requested", "a blocked adoption delivers nothing");
  // the same version with a matching environment goes through
  assert.equal(
    fx.registry.adopt(fx.member, medReq.adoption_request_id, { environment_descriptor: ENV }).response.compat.result,
    "match",
  );
  fx.db.close();
});

test("a malformed environment descriptor is INVALID_SCHEMA (Appendix E.2)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "bad-descriptor");
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  for (const bad of [undefined, {}, { ...ENV, os: "plan9" }, { ...ENV, sandbox_capable: "yes" }, { ...ENV, extra: 1 }]) {
    rejects(() => fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: bad }), "INVALID_SCHEMA");
  }
  fx.db.close();
});

// ==================================================== surface 9: rating rules

test("a rating requires the rater's OWN receipt with a terminal `adopted`", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rating-rules");
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV });

  // open chain: no rating right yet
  rejects(
    () => fx.registry.rate(fx.member, v.versionId, { score: 5, adoption_receipt_id: req.receipt_id }),
    "PRECONDITION_FAILED",
    /terminal event is `adopted`/,
  );
  // somebody else's receipt is not acknowledged
  rejects(() => fx.registry.rate(fx.reviewer, v.versionId, { score: 5, adoption_receipt_id: req.receipt_id }), "NOT_FOUND");

  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "attempted" });
  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "adopted", evidence: goodEvidence(v.manifest) });

  rejects(() => fx.registry.rate(fx.member, v.versionId, { score: 6, adoption_receipt_id: req.receipt_id }), "INVALID_SCHEMA");
  rejects(() => fx.registry.rate(fx.member, v.versionId, { score: 5 }), "INVALID_SCHEMA");
  const rated = fx.registry.rate(fx.member, v.versionId, { score: 4, adoption_receipt_id: req.receipt_id }).response;
  assert.equal(rated.score, 4);
  // one rating per (version, rater): a repeat converges
  const again = fx.registry.rate(fx.member, v.versionId, { score: 1, adoption_receipt_id: req.receipt_id }).response;
  assert.equal(again.noop, true);
  assert.equal(again.score, 4);
  fx.db.close();
});

test("a `failed` receipt confers no rating right", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "failed-no-rating");
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV });
  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "attempted" });
  fx.registry.validateOutcome(fx.member, req.receipt_id, {
    event: "failed",
    failure_report: { category: "gate_failed", summary: "the declared gate did not pass here" },
  });
  rejects(() => fx.registry.rate(fx.member, v.versionId, { score: 5, adoption_receipt_id: req.receipt_id }), "PRECONDITION_FAILED");
  // …and a failed receipt is not evidence for the verified gate either
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  fx.db.close();
});

test("GET /v1/receipts/{id}: adopter, skill owner and ws admin may read; nobody else", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "receipt-read-acl");
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV });

  assert.equal(rest(fx, "GET", `/v1/receipts/${req.receipt_id}`, fx.keys.member).status, 200, "the adopter");
  assert.equal(rest(fx, "GET", `/v1/receipts/${req.receipt_id}`, fx.keys.admin).status, 200, "a ws admin");
  assert.equal(rest(fx, "GET", `/v1/receipts/${req.receipt_id}`, fx.keys.author).status, 200, "the skill owner");
  assert.equal(rest(fx, "GET", `/v1/receipts/${req.receipt_id}`, fx.keys.outsider).status, 404, "a cross-workspace actor");
  assert.equal(rest(fx, "GET", `/v1/receipts/${req.receipt_id}`, fx.keys.reviewer).status, 404, "an unrelated member");
  fx.db.close();
});

test("publication still needs `verified` first: the E2E is the only route there", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "publish-after-e2e");
  assert.ok(!publishVersion(fx.db, v.versionId, NOW).transition.ok, "reviewed cannot publish");

  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: v.versionId }).response;
  fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: ENV });
  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "attempted" });
  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "adopted", evidence: goodEvidence(v.manifest) });
  assert.equal(fx.registry.verifyVersion(fx.owner, v.versionId).response.state, "verified");
  assert.ok(publishVersion(fx.db, v.versionId, NOW).transition.ok, "and now it can");
  fx.db.close();
});
