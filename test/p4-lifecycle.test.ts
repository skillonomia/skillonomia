// P4 — surfaces 10 (`skill.supersede`) and 11 (`skill.revoke`): atomicity of
// the supersession link, and the immediate effect of revocation on
// `skill.verify` verdicts and on search (§6 surface 11).
// Adopter notification rides the delivery machine and is P5.
import { test } from "node:test";
import assert from "node:assert/strict";
import { p4Fixture, publishedVersion, verifiableVersion, reviewedVersion, createVersion, NOW } from "./p4-helpers.ts";
import { isApiError } from "../src/errors.ts";
import { TLOG_REVOKED, TLOG_SUPERSEDED } from "../src/service.ts";
import { verifyTlog } from "../src/tlog.ts";

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

function row(fx: ReturnType<typeof p4Fixture>, id: string): any {
  return fx.db.prepare("SELECT * FROM skill_versions WHERE id=?").get(id);
}

/** a published predecessor and a verified successor of the same skill */
function pair(fx: ReturnType<typeof p4Fixture>, slug: string) {
  const predecessor = publishedVersion(fx, slug);
  const successor = verifiableVersion(fx, slug, {
    skill_id: predecessor.skillId,
    semver: "2.0.0",
    manifest: { skill_id: predecessor.skillId },
  });
  fx.registry.verifyVersion(fx.owner, successor.versionId);
  return { predecessor, successor };
}

// ------------------------------------------------------ surface 10: supersede

test("supersede moves BOTH versions' lifecycle fields and the tlog entry in one transaction", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "supersede-atomic");
  const out = fx.registry.supersedeVersion(fx.owner, predecessor.versionId, {
    successor_version_id: successor.versionId,
  }).response;

  assert.equal(out.state, "superseded");
  assert.equal(out.superseded_by, successor.versionId);
  const before = row(fx, predecessor.versionId);
  const after = row(fx, successor.versionId);
  assert.equal(before.state, "superseded");
  assert.equal(before.superseded_by_version_id, successor.versionId);
  assert.equal(after.supersedes_version_id, predecessor.versionId, "the successor's side of the link");
  assert.equal(after.state, "verified", "superseding does not change the successor's own state");
  const tl = fx.db
    .prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=? AND subject_id=?")
    .get(TLOG_SUPERSEDED, predecessor.versionId) as any;
  assert.equal(tl.c, 1);
  assert.equal(verifyTlog(fx.db).ok, true, "the hash chain is intact after the append");
  fx.db.close();
});

test("supersede is refused — atomically, changing nothing — for an unusable successor", () => {
  const fx = p4Fixture();
  const { predecessor } = pair(fx, "bad-successor");
  const otherSkill = reviewedVersion(fx, "unrelated-skill");
  const draft = createVersion(fx, "supersede-draft", {
    skill_id: predecessor.skillId,
    semver: "3.0.0",
    manifest: { skill_id: predecessor.skillId },
  });

  rejects(
    () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: otherSkill.versionId }),
    "INVALID_SCHEMA",
    /same skill/,
  );
  rejects(
    () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: draft.versionId }),
    "PRECONDITION_FAILED",
    /`verified` or `published`/,
  );
  rejects(
    () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: predecessor.versionId }),
    "INVALID_SCHEMA",
    /itself/,
  );
  rejects(
    () => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: "01AAAAAAAAAAAAAAAAAAAAAAAA" }),
    "NOT_FOUND",
  );
  rejects(() => fx.registry.supersedeVersion(fx.owner, predecessor.versionId, {}), "INVALID_SCHEMA");

  const p = row(fx, predecessor.versionId);
  assert.equal(p.state, "published");
  assert.equal(p.superseded_by_version_id, null);
  assert.equal(row(fx, draft.versionId).supersedes_version_id, null, "no half-written link survived a refusal");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_SUPERSEDED) as any).c,
    0,
  );
  fx.db.close();
});

test("only a published version can be superseded; a repeat converges (defect #1)", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "supersede-twice");
  // the successor itself is `verified`, not `published`, so it cannot be the
  // TARGET of a supersession (§5.1: published → superseded is the only edge)
  rejects(
    () => fx.registry.supersedeVersion(fx.owner, successor.versionId, { successor_version_id: predecessor.versionId }),
    "PRECONDITION_FAILED",
    /only a released version can name a successor/,
  );

  fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId });
  const again = fx.registry.supersedeVersion(fx.owner, predecessor.versionId, {
    successor_version_id: successor.versionId,
  }).response;
  assert.equal(again.noop, true);
  assert.equal(again.state, "superseded");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_SUPERSEDED) as any).c,
    1,
    "the converging repeat logs nothing new",
  );
  fx.db.close();
});

test("supersede ACL (§6 matrix): author/owner/reviewer/admin yes, plain member and cross-workspace no", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "supersede-acl");
  rejects(
    () => fx.registry.supersedeVersion(fx.member, predecessor.versionId, { successor_version_id: successor.versionId }),
    "FORBIDDEN",
  );
  fx.db.prepare("UPDATE skills SET access_policy='public' WHERE id=?").run(predecessor.skillId);
  rejects(
    () => fx.registry.supersedeVersion(fx.outsider, predecessor.versionId, { successor_version_id: successor.versionId }),
    "FORBIDDEN",
    /cross-workspace/,
  );
  assert.equal(row(fx, predecessor.versionId).state, "published");
  const ok = fx.registry.supersedeVersion(fx.reviewer, predecessor.versionId, {
    successor_version_id: successor.versionId,
  }).response;
  assert.equal(ok.state, "superseded");
  fx.db.close();
});

// --------------------------------------------------------- surface 11: revoke

test("revoke requires a reason, transparency-logs it, and takes effect immediately", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "revoke-me");
  rejects(() => fx.registry.revokeVersion(fx.owner, v.versionId, {}), "INVALID_SCHEMA", /reason/);
  rejects(() => fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "   " }), "INVALID_SCHEMA");
  rejects(() => fx.registry.revokeVersion(fx.owner, v.versionId, { reason: 42 }), "INVALID_SCHEMA");
  assert.equal(row(fx, v.versionId).state, "published", "a refused revoke changes nothing");

  const out = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "credential leak in the fixture" }).response;
  assert.equal(out.state, "revoked");
  assert.equal(row(fx, v.versionId).revocation_reason, "credential leak in the fixture");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=? AND subject_id=?").get(TLOG_REVOKED, v.versionId) as any).c,
    1,
  );
  assert.equal(verifyTlog(fx.db).ok, true);
  fx.db.close();
});

test("revocation immediately changes the `skill.verify` verdict (§6 surface 11)", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "revoke-verify");
  assert.equal(fx.registry.verifyVersion(fx.owner, v.versionId).response.verdict, "valid");

  fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "poisoned upstream" });
  const after = fx.registry.verifyVersion(fx.owner, v.versionId).response;
  assert.equal(after.verdict, "revoked");
  assert.equal(after.revocation_reason, "poisoned upstream");
  assert.equal(after.noop, true, "a revoked version never transitions again");
  fx.db.close();
});

test("revocation immediately changes what search reports", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "revoke-search");
  const before = fx.registry.search(fx.member, { state: "published" }).items.find((i) => i.skill_version_id === v.versionId);
  assert.ok(before, "published before revocation");

  fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "withdrawn by the author" });
  assert.equal(
    fx.registry.search(fx.member, { state: "published" }).items.some((i) => i.skill_version_id === v.versionId),
    false,
    "no longer answers as published",
  );
  const listed = fx.registry.search(fx.member, { state: "revoked" }).items.find((i) => i.skill_version_id === v.versionId);
  assert.ok(listed, "§5.1: listed as revoked");
  assert.equal(listed!.state, "revoked");
  assert.equal(listed!.registry.revocation_reason, "withdrawn by the author");
  fx.db.close();
});

test("supersession also reaches `skill.verify` as valid_superseded", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "supersede-verify");
  fx.registry.supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId });
  const out = fx.registry.verifyVersion(fx.owner, predecessor.versionId).response;
  assert.equal(out.verdict, "valid_superseded");
  assert.equal(out.successor_version_id, successor.versionId);
  fx.db.close();
});

test("revoke ACL (§6 matrix): author/owner/admin yes, reviewer and plain member no", () => {
  const fx = p4Fixture();
  const v = publishedVersion(fx, "revoke-acl");
  rejects(() => fx.registry.revokeVersion(fx.reviewer, v.versionId, { reason: "not my call" }), "FORBIDDEN");
  rejects(() => fx.registry.revokeVersion(fx.member, v.versionId, { reason: "not my call" }), "FORBIDDEN");
  assert.equal(row(fx, v.versionId).state, "published");
  assert.equal(fx.registry.revokeVersion(fx.admin, v.versionId, { reason: "policy" }).response.state, "revoked");
  fx.db.close();
});

test("only a released version can be revoked; a repeat converges without a second tlog row", () => {
  const fx = p4Fixture();
  const reviewed = reviewedVersion(fx, "revoke-reviewed");
  rejects(() => fx.registry.revokeVersion(fx.owner, reviewed.versionId, { reason: "too early" }), "PRECONDITION_FAILED");

  const v = publishedVersion(fx, "revoke-repeat");
  fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "first" });
  const again = fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "first" }).response;
  assert.equal(again.noop, true);
  assert.equal(again.reason, "first", "the recorded reason is the one that took effect");
  // §5.1b rule 2: the reason is IMMUTABLE. v1.0.0 answered a repeat carrying a
  // DIFFERENT reason with a silent convergence — it discarded the request and
  // reported success, so a caller who had corrected the wording was told the
  // correction had landed. It had not, and could not: `migrations/0018` refuses
  // the write. The typed answer is `CONFLICT`, and nothing moves.
  rejects(() => fx.registry.revokeVersion(fx.owner, v.versionId, { reason: "second" }), "CONFLICT", /immutable/);
  assert.equal(row(fx, v.versionId).revocation_reason, "first");
  assert.equal(
    (fx.db.prepare("SELECT COUNT(*) AS c FROM transparency_log WHERE event_kind=?").get(TLOG_REVOKED) as any).c,
    1,
  );
  fx.db.close();
});

test("a revoked version keeps its disposition and may still name its replacement (§5.1b)", () => {
  const fx = p4Fixture();
  const { predecessor, successor } = pair(fx, "revoked-terminal");
  fx.registry.revokeVersion(fx.owner, predecessor.versionId, { reason: "terminal" });
  // Recording a replacement is a COLUMN write, so `revoked` does not have to be
  // left — and is not. v1.0.0 refused this call outright, which left an owner
  // who revoked first unable ever to point adopters at the fixed version.
  const sup = fx.registry
    .supersedeVersion(fx.owner, predecessor.versionId, { successor_version_id: successor.versionId })
    .response;
  assert.equal(sup.state, "revoked", "the disposition is not softened into a replacement notice");
  assert.equal(sup.superseded_by, successor.versionId);
  const after = row(fx, predecessor.versionId);
  assert.equal(after.state, "revoked");
  assert.equal(after.revocation_reason, "terminal");
  assert.equal(after.superseded_by_version_id, successor.versionId);
  // …and `revoked` still leads nowhere as a STATE: verify reports it unchanged.
  assert.equal(fx.registry.verifyVersion(fx.owner, predecessor.versionId).response.state, "revoked");
  assert.equal(NOW > 0, true);
  fx.db.close();
});
