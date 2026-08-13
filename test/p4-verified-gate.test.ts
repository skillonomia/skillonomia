// P4 — §5.1 `verified` gate: negative proof (internal phase plan, P4 row).
// The receipt engine is P5, so what this phase must show is that the gate
// cannot be FAKED or BYPASSED: every conjunct refuses on its own, the decision
// comes from the CURRENT eight-gate run (§5.1 conjunct 4), and no exported
// path reaches `verified` around the check.
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  p4Fixture,
  reviewedVersion,
  verifiableVersion,
  adoptedReceipt,
  goodEvidence,
  createVersion,
  lint,
  NOW,
  type P4Fixture,
} from "./p4-helpers.ts";
import { pinnedFixture, insertLintRun } from "./helpers.ts";
import { makeManifest, buildPackage } from "./p2-helpers.ts";
import { GATE_NAMES } from "../src/gates.ts";
import { transitionVersion } from "../src/transitions.ts";
import {
  evaluateVerifiedGate,
  safetyGatesConjunct,
  validateEvidenceForVersion,
  TLOG_VERIFIED,
} from "../src/verified-gate.ts";
import { isApiError } from "../src/errors.ts";

/**
 * The gate-2 leak fixture, assembled from its three segments at run time rather
 * than written as a literal — the convention `test/p7-threats.test.ts` TM-03
 * states for the same reason: a push-side scanner reads the FILE, and a
 * red-team fixture of a credential's shape can refuse the publication of the
 * whole repository. The VALUE is unchanged, byte for byte; the case that uses
 * it asserts the shape first, because its own assertion is about the gate run
 * being re-evaluated and would hold for any string gate 2 dislikes.
 */
const RAW_JWT = pinnedFixture(
  [
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9",
    "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
    "SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJVadQssw5c",
  ].join("."),
  "11b708d7f6c755ec2f4c7d406306bf540557e6ab3ce5672c127e5bd32aeb859e",
  "the raw JWT the verified gate must refuse",
);

function stateOf(fx: P4Fixture, versionId: string): string {
  return (fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as any).state;
}

function tlogCount(fx: P4Fixture, kind: string, subject: string): number {
  return (
    fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=? AND subject_id=?").get(kind, subject) as any
  ).c;
}

function failedCheck(out: any, id: string): any {
  return out.checks.find((c: any) => c.id === id);
}

// --------------------------------------------------------------- the happy path

test("the full conjunction verifies, transitions once, and transparency-logs it", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "verifiable-skill");
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;

  assert.equal(out.verdict, "valid");
  assert.equal(out.state, "verified");
  assert.equal(out.checks.length, 4, "all four §5.1 conjuncts are reported");
  assert.ok(out.checks.every((c) => c.satisfied));
  assert.equal(out.reports.length, GATE_NAMES.length, "conjunct 4: a complete eight-gate run decided it");
  assert.equal(stateOf(fx, v.versionId), "verified");
  assert.equal(tlogCount(fx, TLOG_VERIFIED, v.versionId), 1);

  // converging repeat (defect #1): no second transition, no second tlog row
  const again = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(again.verdict, "valid");
  assert.equal(again.noop, true);
  assert.equal(tlogCount(fx, TLOG_VERIFIED, v.versionId), 1);
  fx.db.close();
});

// ------------------------------------------- conjunct 1: the evidence receipt

test("conjunct 1 — no receipt at all: `verified` is refused and nothing moves", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "no-receipt");
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "evidence_receipt").satisfied, false);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  assert.equal(tlogCount(fx, TLOG_VERIFIED, v.versionId), 0);
  fx.db.close();
});

test("conjunct 1 — a receipt whose terminal event is `failed` is not evidence", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "failed-receipt");
  adoptedReceipt(fx, v.versionId, undefined, { terminal: "failed" });
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.match(failedCheck(out, "evidence_receipt").detail, /terminal `adopted`/);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("conjunct 1 — a receipt still open at `attempted` is not evidence (§5.1: a non-terminal trial receipt does NOT count)", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "open-receipt");
  adoptedReceipt(fx, v.versionId, undefined, { terminal: "none" });
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "evidence_receipt").satisfied, false);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("conjunct 1 — `adopted` without evidence, with foreign gate ids, or with a failing gate is refused", () => {
  for (const [label, evidence] of [
    ["no evidence_json at all", undefined],
    ["evidence naming a gate the version does not declare", { gate_results: [{ gate_id: "not-declared", pass: true, observed: "x" }] }],
    ["a declared gate reported as pass:false", { gate_results: [{ gate_id: "g1", pass: false, observed: "mismatch" }] }],
    ["evidence of the wrong shape entirely", { gate_results: [] }],
    ["the §5.3 synthesized marker instead of gate results", { synthesized: true }],
  ] as Array<[string, any]>) {
    const fx = p4Fixture();
    const v = reviewedVersion(fx, "bad-evidence");
    adoptedReceipt(fx, v.versionId, evidence);
    const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
    assert.equal(out.verdict, "not_verified", label);
    assert.equal(failedCheck(out, "evidence_receipt").satisfied, false, label);
    assert.equal(stateOf(fx, v.versionId), "reviewed", label);
    fx.db.close();
  }
});

test("conjunct 1 — a receipt of a DIFFERENT version does not carry over", () => {
  const fx = p4Fixture();
  const a = reviewedVersion(fx, "donor-skill");
  const b = reviewedVersion(fx, "borrower-skill");
  adoptedReceipt(fx, a.versionId, goodEvidence(a.manifest));
  const out = fx.registry.verifyVersion(fx.owner, b.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "evidence_receipt").satisfied, false);
  fx.db.close();
});

test("evidence validation is Appendix E.2 verbatim: ⊆ declared gates AND every declared gate pass:true", () => {
  const manifest = makeManifest({});
  manifest.procedure.validation_gates = [
    { gate_id: "g1", check: "a", pass_criteria: "a" },
    { gate_id: "g2", check: "b", pass_criteria: "b" },
  ];
  assert.equal(validateEvidenceForVersion(manifest, { gate_results: [{ gate_id: "g1", pass: true, observed: "ok" }] }).valid, false, "g2 missing");
  assert.equal(
    validateEvidenceForVersion(manifest, {
      gate_results: [
        { gate_id: "g1", pass: true, observed: "ok" },
        { gate_id: "g2", pass: true, observed: "ok" },
      ],
    }).valid,
    true,
  );
  assert.equal(
    validateEvidenceForVersion(manifest, {
      gate_results: [
        { gate_id: "g1", pass: true, observed: "ok" },
        { gate_id: "g2", pass: true, observed: "ok" },
        { gate_id: "g3", pass: true, observed: "ok" },
      ],
    }).valid,
    false,
    "a gate the version never declared must not be admitted",
  );
});

// ------------------------------------- conjunct 2: the reviewer attestation

test("conjunct 2 — a version in `reviewed` whose attestation was removed is refused", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "attestation-removed");
  fx.db.prepare("DELETE FROM attestations WHERE skill_version_id=?").run(v.versionId);
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "reviewer_attestation").satisfied, false);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("conjunct 2 — a forged attestation without its approve review does not satisfy the gate", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "forged-attestation");
  // the shape a forger writes: an attestations row alone (§6 surface 3 writes
  // the review and the attestation together or neither)
  fx.db.prepare("DELETE FROM reviews WHERE skill_version_id=?").run(v.versionId);
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.match(failedCheck(out, "reviewer_attestation").detail, /does not exist|eligible approvers: \[none\]/);
  fx.db.close();
});

test("conjunct 2 — an attestation by the author, the skill owner, an outsider or a plain member is not a reviewer attestation", () => {
  const fx = p4Fixture();
  // The skill-owner case needs a skill owner who is NOT the version author and
  // whose ROLE would otherwise make them eligible — otherwise the role rule,
  // not the self-review rule, would be what refuses. reviewer2 owns that skill
  // (role reviewer) while the admin authors the version.
  const ownedSkill = createVersion(fx, "owner-attests", { author: fx.reviewer2 }).skillId;
  const cases: Array<[string, string, boolean]> = [
    ["the version author (self-review)", fx.author.agent_id, false],
    ["the skill owner (self-review)", fx.reviewer2.agent_id, true],
    ["a cross-workspace agent (§5.1: does not exist in v1)", fx.outsider.agent_id, false],
    ["a plain member without reviewer role", fx.member.agent_id, false],
  ];
  cases.forEach(([label, attester, onOwnedSkill], i) => {
    const v = onOwnedSkill
      ? verifiableVersion(fx, "owner-attests", {
          skill_id: ownedSkill,
          semver: `7.0.${i}`,
          manifest: { skill_id: ownedSkill },
          author: fx.admin,
        })
      : verifiableVersion(fx, `attester-case-${i}`);
    // replace the genuine pair with one written by the ineligible attester —
    // reviews row included, so only the eligibility rule can refuse it
    fx.db.prepare("DELETE FROM attestations WHERE skill_version_id=?").run(v.versionId);
    fx.db.prepare("DELETE FROM reviews WHERE skill_version_id=?").run(v.versionId);
    fx.db
      .prepare("INSERT INTO reviews(id, skill_version_id, reviewer_agent_id, verdict, note, created_at_ms) VALUES (?,?,?,?,?,?)")
      .run(`01FORGEDREVIEW${i}`.padEnd(26, "0"), v.versionId, attester, "approve", null, NOW);
    fx.db
      .prepare(
        "INSERT INTO attestations(id, skill_version_id, attester_agent_id, kind, payload_json, signature_jws, created_at_ms) VALUES (?,?,?,?,?,?,?)",
      )
      .run(`01FORGEDATTEST${i}`.padEnd(26, "0"), v.versionId, attester, "reviewer", null, null, NOW);
    const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
    assert.equal(out.verdict, "not_verified", label);
    assert.equal(failedCheck(out, "reviewer_attestation").satisfied, false, label);
    assert.equal(stateOf(fx, v.versionId), "reviewed", label);
  });
  fx.db.close();
});

// P4 verdict 2, blocking F1 — the exact attack the reviewer reproduced, plus
// the neighbouring shapes of the same forgery.
test("conjunct 2 — a forged attestation is refused even when the named reviewer really did approve", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "forged-alongside-genuine");
  const genuine = fx.db.prepare("SELECT * FROM attestations WHERE skill_version_id=?").get(v.versionId) as any;
  const review = fx.db.prepare("SELECT * FROM reviews WHERE skill_version_id=?").get(v.versionId) as any;
  const other = reviewedVersion(fx, "other-version-review");
  const otherReview = fx.db.prepare("SELECT * FROM reviews WHERE skill_version_id=?").get(other.versionId) as any;

  const forge = (id: string, attester: string, payload: string | null): void => {
    fx.db
      .prepare(
        "INSERT INTO attestations(id, skill_version_id, attester_agent_id, kind, payload_json, signature_jws, created_at_ms) VALUES (?,?,?, 'reviewer', ?, NULL, ?)",
      )
      .run(id.padEnd(26, "0"), v.versionId, attester, payload, NOW);
  };

  for (const [label, id, attester, payload] of [
    // the reviewer's reproduction: the genuine attestation is deleted and a
    // bare row naming the same legitimate reviewer is inserted
    ["no payload at all", "01FORGEA", fx.reviewer.agent_id, null],
    ["a payload without a review_id", "01FORGEB", fx.reviewer.agent_id, JSON.stringify({ verdict: "approve" })],
    ["a review_id that does not exist", "01FORGEC", fx.reviewer.agent_id, JSON.stringify({ review_id: "01NOSUCHREVIEW0000000000AA" })],
    ["a review of ANOTHER version", "01FORGED", fx.reviewer.agent_id, JSON.stringify({ review_id: otherReview.id })],
    ["a review submitted by somebody else", "01FORGEE", fx.reviewer2.agent_id, JSON.stringify({ review_id: review.id })],
  ] as Array<[string, string, string, string | null]>) {
    fx.db.prepare("DELETE FROM attestations WHERE skill_version_id=? AND id<>?").run(v.versionId, "none");
    forge(id, attester, payload);
    const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
    assert.equal(out.verdict, "not_verified", label);
    assert.equal(failedCheck(out, "reviewer_attestation").satisfied, false, label);
    assert.equal(stateOf(fx, v.versionId), "reviewed", label);
  }

  // the genuine pair, restored, still verifies — the rule refuses forgeries,
  // not legitimate attestations
  fx.db.prepare("DELETE FROM attestations WHERE skill_version_id=?").run(v.versionId);
  fx.db
    .prepare(
      "INSERT INTO attestations(id, skill_version_id, attester_agent_id, kind, payload_json, signature_jws, created_at_ms) VALUES (?,?,?,?,?,?,?)",
    )
    .run(genuine.id, v.versionId, genuine.attester_agent_id, genuine.kind, genuine.payload_json, genuine.signature_jws, genuine.created_at_ms);
  assert.equal(fx.registry.verifyVersion(fx.owner, v.versionId).response.verdict, "valid");
  fx.db.close();
});

test("conjunct 2 — an attestation naming a reject/conditional review is not an approve attestation", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "attested-reject");
  fx.db.prepare("DELETE FROM attestations WHERE skill_version_id=?").run(v.versionId);
  const rejected = fx.registry.review(fx.reviewer2, v.versionId, { action: "verdict", verdict: "reject" }).response;
  fx.db
    .prepare(
      "INSERT INTO attestations(id, skill_version_id, attester_agent_id, kind, payload_json, signature_jws, created_at_ms) VALUES (?,?,?, 'reviewer', ?, NULL, ?)",
    )
    .run("01ATTESTREJECT0000000000AA", v.versionId, fx.reviewer2.agent_id, JSON.stringify({ review_id: rejected.review_id }), NOW);
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.match(failedCheck(out, "reviewer_attestation").detail, /not an approve/);
  fx.db.close();
});

test("conjunct 2 — an attestation of another KIND is not a reviewer attestation", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "wrong-kind");
  fx.db.prepare("UPDATE attestations SET kind='third_party' WHERE skill_version_id=?").run(v.versionId);
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "reviewer_attestation").satisfied, false);
  fx.db.close();
});

// ------------------------------- conjunct 3: complete compatibility metadata

test("conjunct 3 — empty compatibility matcher lists pass E.1 but fail the §5.1 gate", () => {
  const fx = p4Fixture();
  // E.1's matcherList carries no minItems, so this package is schema-valid and
  // lints clean; only the verified gate's "complete compatibility metadata"
  // conjunct catches it.
  const manifest = makeManifest({ author_agent: fx.author.agent_id, access_policy: "workspace" });
  manifest.runtime.tool_compat = [];
  const { tar } = buildPackage(manifest);
  const created = fx.registry.createVersion(fx.author, { slug: "no-compat", archive: tar }).response;
  assert.equal(fx.registry.lintVersion(fx.author, created.skill_version_id).response.state, "linted");
  fx.registry.review(fx.author, created.skill_version_id, { action: "request" });
  fx.registry.review(fx.reviewer, created.skill_version_id, { action: "verdict", verdict: "approve" });
  adoptedReceipt(fx, created.skill_version_id, goodEvidence(manifest));

  const out = fx.registry.verifyVersion(fx.owner, created.skill_version_id).response;
  assert.equal(out.verdict, "not_verified");
  assert.match(failedCheck(out, "compatibility_metadata").detail, /tool_compat is empty/);
  assert.equal(stateOf(fx, created.skill_version_id), "reviewed");
  fx.db.close();
});

// ------------------------------------------ conjunct 4: the CURRENT gate run

test("conjunct 4 (§5.1) — the CURRENT run decides: a FAIL now blocks even though an older run was clean", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "regressed-package");
  // the clean lint run that reached `linted` is on record …
  const clean = fx.db
    .prepare("SELECT COUNT(*) AS c FROM lint_reports WHERE skill_version_id=? AND result='pass'")
    .get(v.versionId) as any;
  assert.equal(clean.c, GATE_NAMES.length);

  // … but the bytes the version points at now FAIL a gate, so this invocation
  // must refuse regardless of history
  const ref = (fx.db.prepare("SELECT package_blob_ref FROM skill_versions WHERE id=?").get(v.versionId) as any)
    .package_blob_ref;
  assert.match(RAW_JWT, /^eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}$/, "the assembled fixture is no longer the shape gate 2 names `jwt`");
  const leaky = makeManifest({ author_agent: fx.author.agent_id, access_policy: "workspace" });
  const { tar } = buildPackage(leaky, {
    "SKILL.md": `# s\nToken: ${RAW_JWT}\n`,
  });
  fx.registry.blobs.put(ref, tar);

  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "not_verified");
  assert.equal(failedCheck(out, "safety_gates").satisfied, false);
  assert.match(failedCheck(out, "safety_gates").detail, /current run FAILs/);
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  assert.equal(tlogCount(fx, TLOG_VERIFIED, v.versionId), 0);
  fx.db.close();
});

test("conjunct 4 (§5.1) — a historical FAIL is audit evidence only and never blocks a clean current run", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "old-fail-on-record");
  // a later, FAILING historical run on record — the kind that used to keep a
  // corrected version blocked forever
  insertLintRun(
    fx.db,
    v.versionId,
    NOW + 10_000,
    GATE_NAMES.map((g) => [g, g === "secrets" ? "fail" : "pass"]),
  );
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.verdict, "valid", "the current invocation's own eight results decide");
  assert.equal(stateOf(fx, v.versionId), "verified");
  fx.db.close();
});

test("conjunct 4 — a WARN does not block; an incomplete result set does", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "warned-but-clean", { files: { "scripts/bg.sh": "nohup ./watch >/dev/null 2>&1\n" } });
  const out = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(out.reports.find((r) => r.gate === "shell")?.result, "warn");
  assert.equal(out.verdict, "valid", "WARN is not FAIL (§7.1 aggregate)");

  // a partial result set is not a run
  assert.equal(safetyGatesConjunct([{ gate: "schema", result: "pass", details: null }] as any).satisfied, false);
  assert.equal(safetyGatesConjunct(GATE_NAMES.map((g) => ({ gate: g, result: "pass", details: null })) as any).satisfied, true);
  fx.db.close();
});

test("the gate run is written as audit evidence even when the transition is refused", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "audit-on-refusal");
  const before = (fx.db.prepare("SELECT COUNT(*) AS c FROM lint_reports WHERE skill_version_id=?").get(v.versionId) as any).c;
  fx.registry.verifyVersion(fx.owner, v.versionId);
  const after = (fx.db.prepare("SELECT COUNT(*) AS c FROM lint_reports WHERE skill_version_id=?").get(v.versionId) as any).c;
  assert.equal(after, before + GATE_NAMES.length, "the re-run is recorded as audit evidence");
  assert.equal(stateOf(fx, v.versionId), "reviewed", "and it changed nothing else");
  fx.db.close();
});

// -------------------------------------------------- no path around the gate

test("no exported transition reaches `verified`: transitionVersion routes to the gate", () => {
  const fx = p4Fixture();
  const v = reviewedVersion(fx, "generic-transition");
  const res = transitionVersion(fx.db, v.versionId, "verified");
  assert.ok(!res.ok && res.code === "USE_VERIFY_VERSION");
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("a version whose package blob is unavailable cannot be verified (no empty-set scan)", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "blobless");
  const ref = (fx.db.prepare("SELECT package_blob_ref FROM skill_versions WHERE id=?").get(v.versionId) as any)
    .package_blob_ref;
  // a store that has forgotten this blob
  (fx.registry.blobs as any).blobs.delete(ref);
  try {
    fx.registry.verifyVersion(fx.owner, v.versionId);
    assert.fail("expected a typed rejection");
  } catch (e) {
    if (!isApiError(e)) throw e;
    assert.equal(e.code, "NOT_FOUND");
    assert.match(e.message, /blob unavailable/);
  }
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  fx.db.close();
});

test("only admin/owner may run the `verified` transition (Appendix H surface 4)", () => {
  const fx = p4Fixture();
  const v = verifiableVersion(fx, "acl-verify");
  for (const [label, actor] of [
    ["the author", fx.author],
    ["a plain member", fx.member],
    ["a reviewer", fx.reviewer],
  ] as const) {
    try {
      fx.registry.verifyVersion(actor, v.versionId);
      assert.fail(`${label} must not be able to verify`);
    } catch (e) {
      if (!isApiError(e)) throw e;
      assert.equal(e.code, "FORBIDDEN", label);
    }
  }
  assert.equal(stateOf(fx, v.versionId), "reviewed");
  // admin (human) and owner both may
  assert.equal(fx.registry.verifyVersion(fx.admin, v.versionId).response.verdict, "valid");
  fx.db.close();
});

test("the conjunction is a conjunction: three of four satisfied is still a refusal", () => {
  const fx = p4Fixture();
  const v = createVersion(fx, "three-of-four");
  lint(fx, v.versionId);
  fx.registry.review(fx.author, v.versionId, { action: "request" });
  fx.registry.review(fx.reviewer, v.versionId, { action: "verdict", verdict: "approve" });
  const gate = evaluateVerifiedGate(fx.db, v.versionId, v.manifest, GATE_NAMES.map((g) => ({ gate: g, result: "pass", details: null })) as any);
  assert.equal(gate.ok, false);
  assert.deepEqual(
    gate.checks.map((c) => c.satisfied),
    [false, true, true, true],
    "only the evidence receipt is missing — and that alone refuses",
  );
  fx.db.close();
});
