// P6 — compatibility-check in adopt. The internal phase plan assigns
// "compatibility-check in adopt" to the P6 row and its review subject is
// "compat mismatch warns/blocks per risk". §4.2 fixes the outcome set:
//
//   "Compatibility has two V1 outcomes only. `match` means every declared `os`,
//    `shell`, `runtime`, `model`, and `tools` clause matches the adopter
//    descriptor under §4.2. Any unmet clause is `mismatch`; for low-risk it is
//    returned as a warning, for medium/high it blocks adoption. The prior
//    `partial` label is removed from all P6/API contracts."
//
// The matcher itself was written during P5 (Appendix H's surface-7 response
// shape needs it) and accepted at `61d4543`; this suite is its P6 row: the
// binary outcome, the five clauses, and the risk-dependent warn/block through
// BOTH adapters.
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { createVersion, lint, reviewedVersion, NOW } from "./p4-helpers.ts";
import { validatePayload } from "../src/manifest.ts";
import { makeManifest } from "./p2-helpers.ts";
import { p4Fixture, rest, mcp, env, ENV, type P4Fixture, type BuiltVersion } from "./p6-helpers.ts";
import { checkCompatibility, mismatchBlocks, satisfies } from "../src/compat.ts";
import { derivedState } from "../src/receipts.ts";

/** A reviewed version at the requested risk level (gate 1 binds the high-risk fields). */
function atRisk(fx: P4Fixture, slug: string, risk: "low" | "medium" | "high"): BuiltVersion {
  const base = makeManifest({});
  return reviewedVersion(fx, slug, {
    manifest: {
      scope: {
        ...base.scope,
        risk_level: risk,
        required_approvals: risk === "high" ? ["publish", "adopt_high_risk"] : [],
      },
      safety: { ...base.safety, sandbox_requirement: risk === "high" ? "required" : base.safety.sandbox_requirement },
    },
  });
}

function requestAndAdopt(
  fx: P4Fixture,
  v: BuiltVersion,
  key: string,
  descriptor: any,
): { status: number; body: any; raw: string; receiptId: string; requestId: string } {
  const requested = rest(fx, "POST", "/v1/adoptions/requests", key, { skill_version_id: v.versionId });
  assert.equal(requested.status, 201, requested.raw);
  const { adoption_request_id: requestId, receipt_id: receiptId } = requested.body;
  const res = rest(fx, "POST", `/v1/adoptions/${requestId}/adopt`, key, { environment_descriptor: descriptor });
  return { ...res, receiptId, requestId };
}

// ------------------------------------------------- the algorithm, clause by clause

test("§4.2: each of the five clauses can be the ONE unmet clause, and each is named", () => {
  const manifest = makeManifest({});
  assert.equal(checkCompatibility(manifest, ENV).result, "match", "the control descriptor matches every clause");

  // each entry is a PARTIAL patch over the matching control descriptor, so the
  // case flips exactly one property (the P4 verdict-3 minor, carried forward)
  const cases: Array<[string, any]> = [
    ["os", { os: "windows" }],
    ["shell", { shell: "powershell" }],
    ["runtime", { runtime: { id: "codex", version: "1.0.0" } }],
    ["model", { model: { id: "gpt", version: "1.0.0" } }],
    ["tools", { tools: [] }],
  ];
  for (const [clause, descriptor] of cases) {
    // the fixture declares `any` for runtime/model, so those two need a
    // manifest that actually constrains them
    const m =
      clause === "runtime" || clause === "model"
        ? makeManifest({
            runtime: {
              ...manifest.runtime,
              runtime_compat: [{ id: "claude-code", range: ">=2.0.0" }],
              model_compat: [{ id: "claude-opus", range: ">=1.0.0" }],
            },
          })
        : manifest;
    const base = clause === "runtime" || clause === "model" ? env({ runtime: { id: "claude-code", version: "2.1.0" }, model: { id: "claude-opus", version: "1.2.0" } }) : ENV;
    assert.equal(checkCompatibility(m, base).result, "match", `${clause}: control matches`);
    const out = checkCompatibility(m, { ...base, ...descriptor });
    assert.equal(out.result, "mismatch", `${clause}: the unmet clause produces a mismatch`);
    assert.deepEqual(out.unmet, [clause], `${clause}: exactly this clause is reported unmet`);
  }
});

test("§4.2: the outcome set is exactly {match, mismatch} — `partial` exists nowhere", () => {
  const manifest = makeManifest({});
  const descriptors = [
    ENV,
    env({ os: "windows" }),
    env({ shell: "powershell", os: "macos" }),
    env({ tools: [] }),
    env({ runtime: { id: "nope", version: "0.0.1" } }),
    { not: "a descriptor" },
    null,
  ];
  for (const d of descriptors) {
    const out = checkCompatibility(manifest, d);
    assert.ok(out.result === "match" || out.result === "mismatch", `unexpected outcome ${out.result}`);
    assert.equal(out.clauses.length, 5, "all five §4.2 clauses are always reported");
  }
  assert.equal(mismatchBlocks("low"), false);
  assert.equal(mismatchBlocks("medium"), true);
  assert.equal(mismatchBlocks("high"), true);
});

test("range semantics: an unreadable or unsupported range is UNMET, never a silent match", () => {
  assert.equal(satisfies("2.1.0", ">=2.0.0"), true);
  assert.equal(satisfies("1.9.0", ">=2.0.0"), false);
  assert.equal(satisfies("2.1.0", "^2.0.0"), true);
  assert.equal(satisfies("3.0.0", "^2.0.0"), false);
  assert.equal(satisfies("2.0.9", "~2.0.0"), true);
  assert.equal(satisfies("2.1.0", "~2.0.0"), false);
  assert.equal(satisfies("2.1.0", ">=2.0"), true, "a partial bound is zero-filled: >=2.0.0");
  assert.equal(satisfies("2.1.0", ">=1.0.0 <3.0.0"), false, "a compound range IS an unsupported spelling");
  assert.equal(satisfies("2.1.0", ">=v2.0.0"), false, "and so is a bound this grammar cannot read");
  assert.equal(satisfies("2.1.0", undefined), false);
  assert.equal(satisfies(undefined, "*"), true, "a wildcard needs no version");
});

test("a partial bound in a real manifest no longer turns an ordinary declaration into a block", () => {
  // The defect this covers is not a parse detail: a range outside the profile
  // is UNMET, and an unmet clause BLOCKS at risk_level medium. A package
  // declaring `>=2.0` — the spelling §4.2's own example used — therefore
  // refused every adopter, silently and for no stated reason.
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = reviewedVersion(fx, "compat-partial-bound", {
    manifest: {
      scope: { ...base.scope, risk_level: "medium", required_approvals: [] },
      runtime: {
        ...base.runtime,
        runtime_compat: [{ id: "claude-code", range: ">=2.0" }],
        tool_compat: [{ id: "shell", range: ">=5" }],
      },
      procedure: { ...base.procedure, tools_used: [{ id: "shell", range: ">=5.2" }] },
    },
  });
  const out = requestAndAdopt(fx, v, fx.keys.member, env({ runtime: { id: "claude-code", version: "2.1.0" } }));
  assert.equal(out.status, 200, out.raw);
  assert.equal(out.body.compat.result, "match");
  assert.deepEqual(out.body.compat.unmet, []);

  // and the bound still bounds: an adopter below it is refused, with the block
  // naming the clause
  const older = requestAndAdopt(fx, v, fx.keys.member, env({ runtime: { id: "claude-code", version: "1.9.9" } }));
  assert.equal(older.status, 412, older.raw);
  assert.match(older.body.error.message, /runtime/);
  fx.db.close();
});

// --------------------------------------------------- warn at low, block at medium/high

test("low risk + mismatch: adoption PROCEEDS with a structured warning, and `delivered` is written", () => {
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-low", "low");
  const out = requestAndAdopt(fx, v, fx.keys.member, env({ os: "windows" }));
  assert.equal(out.status, 200, out.raw);
  assert.equal(out.body.compat.result, "mismatch");
  assert.deepEqual(out.body.compat.unmet, ["os"]);
  assert.match(out.body.warning, /compatibility mismatch \(os\)/);
  assert.equal(out.body.receipt_event, "delivered");
  assert.equal(derivedState(fx.db, out.receiptId), "delivered", "the handover really happened");
  fx.db.close();
});

test("medium risk + mismatch: adoption is BLOCKED, and nothing was delivered", () => {
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-medium", "medium");
  const out = requestAndAdopt(fx, v, fx.keys.member, env({ shell: "powershell" }));
  assert.equal(out.status, 412, out.raw);
  assert.equal(out.body.error.code, "PRECONDITION_FAILED");
  assert.match(out.body.error.message, /shell/);
  assert.equal(out.body.error.current_state, "pending", "the converging-conflict rule still applies");
  assert.equal(
    derivedState(fx.db, out.receiptId),
    "requested",
    "no handover event was written: the chain is still at the `requested` row that opened it",
  );

  // the SAME request converges once the environment matches — the block is
  // about the environment, not a dead end
  const ok = rest(fx, "POST", `/v1/adoptions/${out.requestId}/adopt`, fx.keys.member, { environment_descriptor: ENV });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.body.compat.result, "match");
  assert.equal(ok.body.warning, undefined, "a match carries no warning");
  fx.db.close();
});

test("high risk + mismatch: blocked even after the §7.3 approval released the hold", () => {
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-high", "high");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const { adoption_request_id: reqId, receipt_id: receiptId } = requested.body;
  assert.equal(requested.body.state, "approval_pending");

  const approved = rest(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.admin, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: reqId,
  });
  assert.equal(approved.status, 201, approved.raw);

  const blocked = rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, {
    environment_descriptor: env({ os: "windows" }),
  });
  assert.equal(blocked.status, 412, blocked.raw);
  assert.match(blocked.body.error.message, /risk_level high blocks on mismatch/);
  assert.equal(derivedState(fx.db, receiptId), "requested");

  // and a matching environment (still sandbox-capable, §7.2) goes through
  const ok = rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, { environment_descriptor: ENV });
  assert.equal(ok.status, 200, ok.raw);
  assert.equal(ok.body.compat.result, "match");
  fx.db.close();
});

test("a match at every risk level carries no warning and hands the package over", () => {
  const fx = p4Fixture();
  for (const risk of ["low", "medium"] as const) {
    const v = atRisk(fx, `compat-match-${risk}`, risk);
    const out = requestAndAdopt(fx, v, fx.keys.member, ENV);
    assert.equal(out.status, 200, out.raw);
    assert.equal(out.body.compat.result, "match");
    assert.deepEqual(out.body.compat.unmet, []);
    assert.equal(out.body.warning, undefined);
    assert.ok(out.body.package.archive_base64.length > 0);
  }
  fx.db.close();
});

test("both adapters give the identical compat verdict, warning and refusal", () => {
  const fx = p4Fixture();
  const low = atRisk(fx, "compat-parity-low", "low");
  const med = atRisk(fx, "compat-parity-medium", "medium");

  const lowRest = requestAndAdopt(fx, low, fx.keys.member, env({ os: "windows" }));
  const lowReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.admin, { skill_version_id: low.versionId }).body;
  const lowMcp = mcp(fx, fx.keys.admin, "skill.adopt", {
    adoption_request_id: lowReq.adoption_request_id,
    environment_descriptor: env({ os: "windows" }),
  });
  assert.equal(lowMcp.isError, false);
  assert.deepEqual(lowMcp.data.compat, lowRest.body.compat);
  assert.equal(lowMcp.data.warning, lowRest.body.warning);

  const medRest = requestAndAdopt(fx, med, fx.keys.member, env({ os: "windows" }));
  const medReq = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.admin, { skill_version_id: med.versionId }).body;
  const medMcp = mcp(fx, fx.keys.admin, "skill.adopt", {
    adoption_request_id: medReq.adoption_request_id,
    environment_descriptor: env({ os: "windows" }),
  });
  assert.equal(medMcp.isError, true);
  assert.equal(medMcp.data.error.code, medRest.body.error.code);
  assert.equal(medMcp.data.error.message, medRest.body.error.message);
  fx.db.close();
});

test("§7.2 still gates the high-risk handover independently of compatibility", () => {
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-sandbox", "high");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const reqId = requested.body.adoption_request_id;
  rest(fx, "POST", `/v1/versions/${v.versionId}/approvals`, fx.keys.admin, {
    scope: "adopt_high_risk",
    decision: "approved",
    adoption_request_id: reqId,
  });
  const res = rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, {
    environment_descriptor: env({ sandbox_capable: false }),
  });
  assert.equal(res.status, 403, res.raw);
  assert.match(res.body.error.message, /sandbox capability/);
  fx.db.close();
});

test("an environment descriptor that is not E.2-shaped is INVALID_SCHEMA, never a silent mismatch", () => {
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-bad-descriptor", "low");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const reqId = requested.body.adoption_request_id;
  for (const bad of [undefined, {}, { ...ENV, os: "plan9" }, { ...ENV, extra: 1 }]) {
    const res = rest(fx, "POST", `/v1/adoptions/${reqId}/adopt`, fx.keys.member, { environment_descriptor: bad });
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, "INVALID_SCHEMA");
  }
  assert.equal(NOW > 0, true);
  fx.db.close();
});

// ---------------------------------------------------------------------------
// Appendix E.2: a model identity is not a semantic version.
//
// The live release run sent a TRUTHFUL descriptor — `model.version` was the
// model's own identifier, because a model has no version apart from it — and
// was refused with
//   INVALID_SCHEMA: environment_descriptor: /model/version must match pattern
//   "^\d+\.\d+\.\d+(-[0-9A-Za-z.-]+)?$"
// The adopter's only way through was to invent `5.0.0`, so the field that
// exists to record the truth about an environment was systematically collecting
// fiction. `model.version` is now `modelIdentifier`; `runtime.version` and
// `tools[].version` keep `exactVersion`, because those really are ordered
// versions and §4.2 compares against them.
// ---------------------------------------------------------------------------

test("a truthful model identifier is accepted where the invented semver used to be required", () => {
  const truthful = env({ model: { id: "claude-opus-5", version: "claude-opus-5" } });
  const val = validatePayload("environment_descriptor", truthful);
  assert.deepEqual(val.errors, [], "the descriptor of the live run must validate as sent");
  assert.equal(val.valid, true);

  // and it reaches the surface, not only the validator
  const fx = p4Fixture();
  const v = atRisk(fx, "compat-model-identifier", "low");
  const requested = rest(fx, "POST", "/v1/adoptions/requests", fx.keys.member, { skill_version_id: v.versionId });
  const res = rest(fx, "POST", `/v1/adoptions/${requested.body.adoption_request_id}/adopt`, fx.keys.member, {
    environment_descriptor: truthful,
  });
  assert.equal(res.status, 200, res.raw);
  assert.equal(res.body.receipt_event, "delivered");
  fx.db.close();
});

test("the relaxation is the model's alone: runtime and tool versions are still exact semver", () => {
  for (const bad of [
    env({ runtime: { id: "claude-code", version: "claude-code" } }),
    env({ runtime: { id: "claude-code", version: "2.1" } }),
    env({ tools: [{ id: "shell", version: "5.2" }] }),
    env({ model: { id: "m", version: "" } }),
    env({ model: { id: "m", version: "x".repeat(81) } }),
  ]) {
    assert.equal(validatePayload("environment_descriptor", bad).valid, false, JSON.stringify(bad));
  }
});

test("the descriptor schema keeps two named types apart, and neither is named after strictness", () => {
  const schema = JSON.parse(
    readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "schema", "environment-descriptor-v1.schema.json"), "utf8"),
  );
  assert.equal(schema.properties.runtime.properties.version.$ref, "#/$defs/exactVersion");
  assert.equal(schema.properties.tools.items.properties.version.$ref, "#/$defs/exactVersion");
  assert.equal(schema.properties.model.properties.version.$ref, "#/$defs/modelIdentifier");
  // `exactVersion` itself must not have been widened — that is how a relaxation
  // meant for the model would reach the runtime by accident
  assert.equal(schema.$defs.exactVersion.pattern, "^\\d+\\.\\d+\\.\\d+(-[0-9A-Za-z.-]+)?$");
  assert.notEqual(schema.$defs.modelIdentifier, undefined);
  for (const name of Object.keys(schema.$defs)) {
    assert.ok(
      !/loose|strict|lenient|relaxed/i.test(name),
      `\`${name}\` names the strictness of a check rather than its subject (Appendix E.2)`,
    );
  }
});

test("Appendix E.2 states the asymmetry, so the schema cannot be `fixed` back", () => {
  const spec = readFileSync(join(dirname(fileURLToPath(import.meta.url)), "..", "SPEC.md"), "utf8").replace(/\s+/g, " ");
  for (const phrase of [
    "Why `model.version` is not `exactVersion`, and why `runtime.version` still is",
    "A model has no version separate from its identity",
    "An implementation MUST NOT relax `exactVersion` itself",
    "There is no `versionLoose`/`versionStrict` pair here and MUST NOT be one",
  ]) {
    assert.ok(spec.includes(phrase.replace(/\s+/g, " ")), `Appendix E.2 must say: ${phrase}`);
  }
});

test("createVersion + lint keeps a medium-risk fixture linted (the compat suite's fixtures are real packages)", () => {
  const fx = p4Fixture();
  const base = makeManifest({});
  const v = createVersion(fx, "compat-fixture-sanity", {
    manifest: { scope: { ...base.scope, risk_level: "medium", required_approvals: [] } },
  });
  assert.equal(lint(fx, v.versionId), "linted");
  fx.db.close();
});
