// P6 — Reputation. The internal phase plan's P6 review subject, first line:
// "Reputation only from server-validated receipts", which is §8 threat 5's V1
// control
// ("Reputation computed only from server-validated receipts; benchmarks marked
// self-reported unless receipt-backed") and §4.2's Reputation bullet ("authors
// must not sign their own reputation").
//
// The group is the E.2 `version-registry-view` one — six fields, no extension
// point — so this suite proves each one moves ONLY when the receipt machine or
// surface 9 wrote the row it counts, and never for anything the author declared.
import { test } from "node:test";
import assert from "node:assert/strict";
import { createVersion, lint, reviewedVersion, goodEvidence } from "./p4-helpers.ts";
import { p4Fixture, rest, mcp, adoptThroughSurfaces, rateThroughSurface, rejects, env } from "./p6-helpers.ts";
import { validatePayload } from "../src/manifest.ts";

function reputationOf(fx: any, versionId: string): any {
  const row = fx.db
    .prepare(
      `SELECT v.id, v.state, v.superseded_by_version_id, v.revocation_reason, v.deprecation_at_ms
         FROM skill_versions v WHERE v.id=?`,
    )
    .get(versionId);
  return fx.registry.registryView(row).reputation;
}

test("baseline: a reviewed version with no receipts has an all-zero, unrated Reputation", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-baseline");
  assert.deepEqual(reputationOf(fx, v.versionId), {
    adoption_attempts: 0,
    adopted_count: 0,
    failed_count: 0,
    rolled_back_count: 0,
    avg_rating: null,
    failure_modes_observed: [],
  });
  fx.db.close();
});

test("every counter moves ONLY through the receipt machine, and by exactly one", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-counters");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member);
  assert.deepEqual(reputationOf(fx, v.versionId), {
    adoption_attempts: 1,
    adopted_count: 1,
    failed_count: 0,
    rolled_back_count: 0,
    avg_rating: null,
    failure_modes_observed: [],
  });

  // a second adopter FAILS the same version: the failure counter and the
  // observed failure mode come from the server-validated failure report
  adoptThroughSurfaces(fx, v, fx.keys.admin, { terminal: "failed" });
  const after = reputationOf(fx, v.versionId);
  assert.equal(after.adoption_attempts, 2);
  assert.equal(after.adopted_count, 1);
  assert.equal(after.failed_count, 1);
  assert.deepEqual(after.failure_modes_observed, ["gate_failed"]);

  // rolled_back is a post-adoption event of the FIRST receipt (§5.3)
  const rb = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member, {
    event: "rolled_back",
    rollback_report: { reason: "regression", summary: "the adopted procedure regressed in staging" },
  });
  assert.equal(rb.status, 200, rb.raw);
  assert.equal(reputationOf(fx, v.versionId).rolled_back_count, 1);
  fx.db.close();
});

test("§8 threat 5: nothing the AUTHOR declares moves any Reputation field", () => {
  const fx = p4Fixture();
  // a manifest that claims success as loudly as the signed groups allow
  const v = createVersion(fx, "rep-self-claimed", {
    manifest: {
      evidence: {
        redaction_level: "none",
        summary: "Adopted by hundreds of fleets with a perfect record.",
        test_results: "1000/1000 adoptions succeeded",
        benchmark: "fastest skill in the registry",
        third_party_attestation: "audited by the author",
      },
      x_ext: { adopted_count: 999, avg_rating: 5, ratings: 500 },
    },
  });
  assert.equal(lint(fx, v.versionId), "linted");
  assert.deepEqual(reputationOf(fx, v.versionId), {
    adoption_attempts: 0,
    adopted_count: 0,
    failed_count: 0,
    rolled_back_count: 0,
    avg_rating: null,
    failure_modes_observed: [],
    // the author's numbers are visible in the signed manifest and count for
    // nothing: the registry group is computed, never copied
  });
  // and the search trust thresholds refuse it exactly as the zeros say
  const found = rest(fx, "GET", "/v1/skills?min_adopted=1", fx.keys.owner).body.items.map((i: any) => i.slug);
  assert.ok(!found.includes("rep-self-claimed"));
  fx.db.close();
});

test("an `adopted` append whose evidence does not satisfy the declared gates is refused — and counts for nothing", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-bad-evidence");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const { adoption_request_id: reqId, receipt_id: receiptId } = requested.body;
  rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, { environment_descriptor: env() });
  rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member, { event: "attempted" });

  for (const evidence of [
    { gate_results: [{ gate_id: "g1", pass: false, observed: "the gate did not pass" }] },
    { gate_results: [{ gate_id: "not-a-declared-gate", pass: true, observed: "ok" }] },
  ]) {
    const res = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member, { event: "adopted", evidence });
    assert.equal(res.status, 400, JSON.stringify(evidence));
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
  }
  assert.equal(reputationOf(fx, v.versionId).adopted_count, 0, "a refused append is not a receipt");
  assert.equal(reputationOf(fx, v.versionId).adoption_attempts, 1, "the attempt itself did happen");

  // the same receipt still converges on VALID evidence — the rule discriminates
  const ok = rest(fx, "POST", `/v1/receipts/${receiptId}/events`, fx.keys.member, {
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(reputationOf(fx, v.versionId).adopted_count, 1);
  fx.db.close();
});

test("avg_rating is receipt-backed: surface 9 refuses a rater without a terminal `adopted` receipt", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-ratings");

  // an agent with no receipt at all
  const noReceipt = rest(fx, "POST", `/v1/versions/${v.versionId}/ratings`, fx.keys.reviewer, {
    score: 5,
    adoption_receipt_id: "01J0000000000000000000000X",
  });
  assert.ok(noReceipt.status >= 400, "a rating without a receipt is refused");
  assert.equal(reputationOf(fx, v.versionId).avg_rating, null);

  // an agent whose receipt terminated `failed`
  const failed = adoptThroughSurfaces(fx, v, fx.keys.admin, { terminal: "failed" });
  const onFailed = rest(fx, "POST", `/v1/versions/${v.versionId}/ratings`, fx.keys.admin, {
    score: 5,
    adoption_receipt_id: failed.receiptId,
  });
  assert.ok(onFailed.status >= 400, "a failed receipt does not license a rating");
  assert.equal(reputationOf(fx, v.versionId).avg_rating, null);

  // …and the legitimate adopter's rating IS counted
  const adopted = adoptThroughSurfaces(fx, v, fx.keys.member);
  rateThroughSurface(fx, v, fx.keys.member, adopted.receiptId, 4);
  assert.equal(reputationOf(fx, v.versionId).avg_rating, 4);

  // a second eligible adopter averages in
  const second = adoptThroughSurfaces(fx, v, fx.keys.botAdmin);
  rateThroughSurface(fx, v, fx.keys.botAdmin, second.receiptId, 2);
  assert.equal(reputationOf(fx, v.versionId).avg_rating, 3);
  fx.db.close();
});

test("failure_modes_observed reads the validated failure report, not the manifest's declared failure_modes", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-failure-modes");
  // the fixture manifest DECLARES a failure mode ("shell-missing"); declaring
  // one is not observing one, and the registry group starts empty
  assert.deepEqual(
    v.manifest.procedure.failure_modes.map((f: any) => f.mode),
    ["shell-missing"],
  );
  assert.deepEqual(reputationOf(fx, v.versionId).failure_modes_observed, []);

  const run = adoptThroughSurfaces(fx, v, fx.keys.member, { terminal: "none" });
  const res = rest(fx, "POST", `/v1/receipts/${run.receiptId}/events`, fx.keys.member, {
    event: "failed",
    failure_report: { category: "pre_execution", summary: "the environment refused the handover before any step ran" },
  });
  assert.equal(res.status, 200, res.raw);
  assert.deepEqual(reputationOf(fx, v.versionId).failure_modes_observed, ["pre_execution"]);
  assert.equal(reputationOf(fx, v.versionId).adoption_attempts, 0, "a pre_execution failure was never an execution attempt");
  assert.equal(reputationOf(fx, v.versionId).failed_count, 1);
  fx.db.close();
});

test("Reputation is per version: another version's receipts never leak into it", () => {
  const fx = p4Fixture();
  const a = reviewedVersion(fx, "rep-isolation-a");
  const b = reviewedVersion(fx, "rep-isolation-b");
  adoptThroughSurfaces(fx, a, fx.keys.member);
  assert.equal(reputationOf(fx, a.versionId).adopted_count, 1);
  assert.equal(reputationOf(fx, b.versionId).adopted_count, 0);
  fx.db.close();
});

test("the served group is exactly E.2's version-registry-view — six computed fields, no author extension point", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-schema");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member);
  rateThroughSurface(fx, v, fx.keys.member, run.receiptId, 5);
  const item = rest(fx, "GET", "/v1/skills?q=rep-schema", fx.keys.member).body.items[0];
  const val = validatePayload("version_registry_view", item.registry);
  assert.ok(val.valid, val.errors.join("; "));
  assert.deepEqual(Object.keys(item.registry.reputation).sort(), [
    "adopted_count",
    "adoption_attempts",
    "avg_rating",
    "failed_count",
    "failure_modes_observed",
    "rolled_back_count",
  ]);
  assert.deepEqual(item.registry.receipt_ids, [run.receiptId], "receipt_ids is registry-side (§4.2), never signed");

  // identical over MCP — one computation, two adapters (§2)
  const viaMcp = mcp(fx, fx.keys.member, "skill.search", { q: "rep-schema" });
  assert.deepEqual(viaMcp.data.items[0].registry, item.registry);
  fx.db.close();
});

test("receipt_events is INSERT-only: a Reputation counter cannot be edited away (§3)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-insert-only");
  adoptThroughSurfaces(fx, v, fx.keys.member, { terminal: "failed" });
  assert.equal(reputationOf(fx, v.versionId).failed_count, 1);
  assert.throws(() => fx.db.exec("UPDATE receipt_events SET event='adopted' WHERE event='failed'"), /INSERT_ONLY/);
  assert.throws(() => fx.db.exec("DELETE FROM receipt_events WHERE event='failed'"), /INSERT_ONLY/);
  assert.equal(reputationOf(fx, v.versionId).failed_count, 1);
  assert.equal(reputationOf(fx, v.versionId).adopted_count, 0);
  fx.db.close();
});

test("a cross-agent append cannot inflate another adopter's receipt (§8 threat 6, restated for Reputation)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "rep-cross-agent");
  const run = adoptThroughSurfaces(fx, v, fx.keys.member, { terminal: "none" });
  rejects(
    () => fx.registry.validateOutcome(fx.admin, run.receiptId, { event: "adopted", evidence: goodEvidence(v.manifest) }),
    "FORBIDDEN",
  );
  const viaMcp = mcp(fx, fx.keys.admin, "skill.validate_outcome", {
    receipt_id: run.receiptId,
    event: "adopted",
    evidence: goodEvidence(v.manifest),
  });
  assert.equal(viaMcp.isError, true);
  assert.equal(reputationOf(fx, v.versionId).adopted_count, 0);
  fx.db.close();
});
