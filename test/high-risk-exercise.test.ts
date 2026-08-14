// THE HIGH-RISK ADOPTION LANE, OVER THE SHIPPED FIXTURE.
//
// `fixtures/high-risk-safe/` is the package the operational exercise
// (`ci/high-risk-exercise.mjs`) runs: `risk_level: high`, and a payload that is
// one `echo`. The two halves are the point — the lane under test is §7.3's, and
// the payload is chosen so that running it settles nothing and costs nothing.
//
// What is asserted here is the pair the lane consists of: the registry REFUSES
// to hand the package over until a human admin/owner has recorded an
// `adopt_high_risk` approval bound to this one request, and hands it over after
// that approval and not before. The runner drives the same pair through HTTP
// against a clean instance; this file drives it through the surfaces, so a
// break is located in the registry rather than in the orchestration.
import { test } from "node:test";
import assert from "node:assert/strict";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { readTar, writeTar } from "../src/archive.ts";
import { isApiError } from "../src/errors.ts";
import { packSkill } from "../tools/pack-skill.ts";
import { TV_KID, TV_SEED_HEX } from "./vectors-helpers.ts";
import { p4Fixture, lint, type P4Fixture } from "./p4-helpers.ts";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FIXTURE_DIR = join(ROOT, "fixtures", "high-risk-safe");

const DESCRIPTOR = {
  runtime: { id: "any", version: "1.0.0" },
  model: { id: "any", version: "1.0.0" },
  tools: [{ id: "shell", version: "1.0.0" }],
  os: "linux",
  shell: "bash",
  // §7.2: a high-risk package is handed only to an adopter that attests this
  sandbox_capable: true,
};

/** The shipped fixture, packed and signed for this fixture's author, at `reviewed`. */
function reviewedFixture(fx: P4Fixture): { versionId: string; manifest: any } {
  const packed = packSkill(FIXTURE_DIR, {
    author: fx.author.agent_id,
    seedHex: TV_SEED_HEX,
    kid: TV_KID,
  });
  const created = fx.registry.createVersion(fx.author, {
    slug: "high-risk-safe",
    archive: writeTar(packed.files),
  }).response;
  assert.equal(lint(fx, created.skill_version_id), "linted", "the shipped fixture must pass all eight §7.1 gates");
  fx.registry.review(fx.author, created.skill_version_id, { action: "request" });
  const reviewed = fx.registry.review(fx.reviewer, created.skill_version_id, {
    action: "verdict",
    verdict: "approve",
  }).response;
  assert.equal(reviewed.state, "reviewed");
  return { versionId: created.skill_version_id, manifest: packed.manifest };
}

test("the shipped high-risk fixture is refused before a human approval and handed over after one", async () => {
  const fx = p4Fixture();
  const { versionId, manifest } = reviewedFixture(fx);

  // 1 — the request is HELD, and says which §7.3 condition holds it
  const req = fx.registry.requestAdoption(fx.member, { skill_version_id: versionId }).response;
  assert.equal(req.state, "approval_pending", "a `risk_level: high` version is not adoptable on request alone");
  assert.deepEqual(req.approval_required, ["risk_high"], JSON.stringify(req.approval_required));

  // 2 — the typed refusal, BEFORE any approval exists
  let refused: unknown;
  try {
    fx.registry.adopt(fx.member, req.adoption_request_id, { environment_descriptor: DESCRIPTOR });
    assert.fail("a high-risk package was handed over with no §7.3 approval on record");
  } catch (e) {
    refused = e;
  }
  assert.ok(isApiError(refused), `the refusal is a typed surface error, not a crash: ${String(refused)}`);
  assert.equal(refused.code, "FORBIDDEN");
  assert.equal(refused.current_state, "approval_pending");
  assert.match(refused.message, /human approval/);
  // …and it hands nothing over on the way out
  const deliveries = fx.db
    .prepare("SELECT COUNT(*) AS c FROM receipt_events WHERE event='delivered'")
    .get() as { c: number };
  assert.equal(deliveries.c, 0, "a refused adoption recorded a delivery");

  // 3 — the approval, through the existing §7.3 contract: a HUMAN admin/owner,
  //     bound to this one adoption request
  const approval = fx.registry.approve(fx.admin, versionId, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: req.adoption_request_id,
  }).response;
  assert.equal(approval.decision, "approved");
  assert.deepEqual(approval.conditions, ["risk_high"]);

  // 4 — and now the same call succeeds, handing over the same bytes the
  //     repository ships
  const adopted = fx.registry.adopt(fx.member, req.adoption_request_id, {
    environment_descriptor: DESCRIPTOR,
  }).response;
  assert.equal(adopted.receipt_event, "delivered");
  const delivered = readTar(Buffer.from(adopted.package!.archive_base64, "base64"));
  assert.equal(
    delivered.get("fixtures/tv-high.sh")!.toString("utf8").trim(),
    "echo skillonomia-high-risk-safe-ok",
    "the adopter is handed the fixture the manifest names",
  );

  // 5 — the chain reaches its terminal state on the declared gate
  fx.registry.validateOutcome(fx.member, req.receipt_id, { event: "attempted" });
  const gates = manifest.procedure.validation_gates as Array<{ gate_id: string }>;
  fx.registry.validateOutcome(fx.member, req.receipt_id, {
    event: "adopted",
    evidence: {
      gate_results: gates.map((g) => ({
        gate_id: g.gate_id,
        pass: true,
        observed: "skillonomia-high-risk-safe-ok",
      })),
    },
  });
  const receipt = fx.registry.readReceipt(fx.member, req.receipt_id);
  assert.equal(receipt.derived_state, "adopted");
  assert.deepEqual(
    receipt.events.map((e) => e.event),
    ["requested", "delivered", "attempted", "adopted"],
  );
});
