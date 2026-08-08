// P2 service layer: surface 1 skill.create, surface 2 skill.lint,
// surface 4-read stateless verify. Attack and convergence semantics per
// §6 (ACL matrix, error model) and §2 (actor from auth, never payload).
import { test } from "node:test";
import assert from "node:assert/strict";
import { p2Fixture, makeManifest, buildPackage, createInState, ctxFor, NOW } from "./p2-helpers.ts";
import { tv01Package, tvRegistry } from "./vectors-helpers.ts";
import { writeTar } from "../src/archive.ts";
import { Registry } from "../src/service.ts";
import { isApiError } from "../src/errors.ts";
import { ulid } from "../src/ulid.ts";

function codeOf(fn: () => unknown): { code: string; current_state?: string } {
  try {
    fn();
  } catch (e) {
    if (isApiError(e)) return { code: e.code, current_state: e.current_state };
    throw e;
  }
  throw new Error("expected an ApiError");
}

// -------------------------------------------------------- surface 1: create

test("create: new skill + draft version; owner and author come from AuthContext", () => {
  const fx = p2Fixture();
  const manifest = makeManifest({ author_agent: fx.author.agent_id, access_policy: "workspace" });
  const { tar } = buildPackage(manifest);
  const out = fx.registry.createVersion(fx.author, { slug: "test-skill", archive: tar });
  assert.equal(out.replayed, false);
  const res = out.response;
  assert.equal(res.skill_id, manifest.skill_id);
  assert.equal(res.state, "draft");

  const skill = fx.db.prepare("SELECT * FROM skills WHERE id=?").get(res.skill_id) as any;
  assert.equal(skill.slug, "test-skill");
  assert.equal(skill.owner_agent_id, fx.author.agent_id, "owner = actor, not payload");
  assert.equal(skill.workspace_id, fx.author.workspace_id);
  assert.equal(skill.access_policy, "workspace");

  const version = fx.db.prepare("SELECT * FROM skill_versions WHERE id=?").get(res.skill_version_id) as any;
  assert.equal(version.author_agent_id, fx.author.agent_id);
  assert.equal(version.state, "draft");
  assert.equal(version.semantic_version, manifest.semantic_version);
  assert.ok(fx.registry.blobs.get(version.package_blob_ref), "package blob stored under its ref");
  fx.db.close();
});

test("create: manifest author_agent != actor is FORBIDDEN (defect #2 impersonation)", () => {
  const fx = p2Fixture();
  const manifest = makeManifest({ author_agent: fx.owner.agent_id, access_policy: "workspace" });
  const { tar } = buildPackage(manifest);
  const r = codeOf(() => fx.registry.createVersion(fx.author, { slug: "imp-skill", archive: tar }));
  assert.equal(r.code, "FORBIDDEN");
  const count = fx.db.prepare("SELECT COUNT(*) AS c FROM skill_versions").get() as { c: number };
  assert.equal(count.c, 1, "nothing created (only the seed version exists)");
  fx.db.close();
});

test("create: actor without workspace membership is FORBIDDEN", () => {
  const fx = p2Fixture();
  const loner = ctxFor(fx.seed, fx.author.agent_id, fx.author.workspace_id, null);
  const manifest = makeManifest({ author_agent: loner.agent_id });
  const { tar } = buildPackage(manifest);
  assert.equal(codeOf(() => fx.registry.createVersion(loner, { slug: "loner-skill", archive: tar })).code, "FORBIDDEN");
  fx.db.close();
});

test("create: identical re-create converges to noop:true + existing version (defect #1 shape)", () => {
  const fx = p2Fixture();
  const manifest = makeManifest({ author_agent: fx.author.agent_id });
  const { tar } = buildPackage(manifest);
  const first = fx.registry.createVersion(fx.author, { slug: "idem-skill", archive: tar }).response;
  const second = fx.registry.createVersion(fx.author, { slug: "idem-skill", archive: tar }).response;
  assert.equal(second.noop, true);
  assert.equal(second.skill_version_id, first.skill_version_id);
  assert.equal(second.state, "draft");
  const count = fx.db
    .prepare("SELECT COUNT(*) AS c FROM skill_versions WHERE skill_id=?")
    .get(first.skill_id) as { c: number };
  assert.equal(count.c, 1);
  fx.db.close();
});

test("create: same semver, different content is CONFLICT with current_state", () => {
  const fx = p2Fixture();
  const manifest = makeManifest({ author_agent: fx.author.agent_id });
  const { tar } = buildPackage(manifest);
  fx.registry.createVersion(fx.author, { slug: "conf-skill", archive: tar });
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.title = "Changed title";
  delete changed.integrity;
  const { tar: tar2 } = buildPackage(changed);
  const r = codeOf(() => fx.registry.createVersion(fx.author, { slug: "conf-skill", archive: tar2 }));
  assert.equal(r.code, "CONFLICT");
  assert.equal(r.current_state, "draft", "Appendix H: CONFLICT carries current_state");
  fx.db.close();
});

test("create: new version on existing skill — owner yes, other member FORBIDDEN, ws admin yes", () => {
  const fx = p2Fixture();
  const m1 = makeManifest({ author_agent: fx.author.agent_id });
  const { tar } = buildPackage(m1);
  const created = fx.registry.createVersion(fx.author, { slug: "multi-v", archive: tar }).response;

  // skill owner (= author here) adds 1.1.0
  const m2 = makeManifest({
    author_agent: fx.author.agent_id,
    skill_id: created.skill_id,
    semantic_version: "1.1.0",
  });
  const v2 = fx.registry.createVersion(fx.author, { slug: "multi-v", archive: buildPackage(m2).tar }).response;
  assert.equal(v2.skill_id, created.skill_id);
  assert.equal(v2.noop, undefined);

  // a plain member who is not the owner cannot add versions
  const m3 = makeManifest({
    author_agent: fx.member.agent_id,
    skill_id: created.skill_id,
    semantic_version: "1.2.0",
  });
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.member, { slug: "multi-v", archive: buildPackage(m3).tar })).code,
    "FORBIDDEN",
  );

  // a workspace owner/admin can (owner here is role owner and a human)
  const m4 = makeManifest({
    author_agent: fx.owner.agent_id,
    skill_id: created.skill_id,
    semantic_version: "1.3.0",
  });
  const v4 = fx.registry.createVersion(fx.owner, { slug: "multi-v", archive: buildPackage(m4).tar }).response;
  assert.equal(v4.skill_id, created.skill_id);
  fx.db.close();
});

test("create by skill_id path: works for owner; cross-workspace id is NOT_FOUND; id mismatch is INVALID_SCHEMA", () => {
  const fx = p2Fixture();
  const m1 = makeManifest({ author_agent: fx.author.agent_id });
  const created = fx.registry.createVersion(fx.author, { slug: "by-id", archive: buildPackage(m1).tar }).response;

  const m2 = makeManifest({ author_agent: fx.author.agent_id, skill_id: created.skill_id, semantic_version: "2.0.0" });
  const v2 = fx.registry.createVersion(fx.author, { skill_id: created.skill_id, archive: buildPackage(m2).tar }).response;
  assert.equal(v2.skill_id, created.skill_id);

  // cross-workspace actor: the skill id is not acknowledged to exist
  const m3 = makeManifest({ author_agent: fx.outsider.agent_id, skill_id: created.skill_id, semantic_version: "3.0.0" });
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.outsider, { skill_id: created.skill_id, archive: buildPackage(m3).tar })).code,
    "NOT_FOUND",
  );

  // manifest naming a different skill than the path is malformed
  const m4 = makeManifest({ author_agent: fx.author.agent_id, semantic_version: "4.0.0" });
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { skill_id: created.skill_id, archive: buildPackage(m4).tar })).code,
    "INVALID_SCHEMA",
  );
  fx.db.close();
});

test("create: malformed inputs map to the typed §6 codes", () => {
  const fx = p2Fixture();
  // not a tar at all
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { slug: "bad-tar", archive: Buffer.from("not a tar") })).code,
    "MALFORMED_ARCHIVE",
  );
  // schema-invalid manifest
  const bad = makeManifest({ author_agent: fx.author.agent_id, title: "x" }); // minLength 3 violated
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { slug: "bad-manifest", archive: buildPackage(bad).tar })).code,
    "INVALID_SCHEMA",
  );
  // integrity mismatch: flip a hashed file after signing
  const good = makeManifest({ author_agent: fx.author.agent_id });
  const built = buildPackage(good);
  built.files.set("SKILL.md", Buffer.from("tampered\n", "utf8"));
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { slug: "tampered", archive: writeTar(built.files) })).code,
    "TAMPERED_CONTENT",
  );
  // bad slug
  const ok = makeManifest({ author_agent: fx.author.agent_id });
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { slug: "NO", archive: buildPackage(ok).tar })).code,
    "INVALID_SCHEMA",
  );
  fx.db.close();
});

test("create: missing SKILL.md or SIGNATURE.jws is INVALID_SCHEMA (§4.1 layout)", () => {
  const fx = p2Fixture();
  const m = makeManifest({ author_agent: fx.author.agent_id });
  const built = buildPackage(m);
  const noSig = new Map(built.files);
  noSig.delete("SIGNATURE.jws");
  assert.equal(
    codeOf(() => fx.registry.createVersion(fx.author, { slug: "no-sig", archive: writeTar(noSig) })).code,
    "INVALID_SCHEMA",
  );
  // SKILL.md missing: rebuild so integrity stays consistent
  const m2 = makeManifest({ author_agent: fx.author.agent_id });
  const built2 = buildPackage(m2);
  const noMd = new Map(built2.files);
  noMd.delete("SKILL.md");
  const r = codeOf(() => fx.registry.createVersion(fx.author, { slug: "no-md", archive: writeTar(noMd) }));
  // integrity still lists SKILL.md → tampered wins; both are typed rejections
  assert.ok(r.code === "INVALID_SCHEMA" || r.code === "TAMPERED_CONTENT");
  fx.db.close();
});

test("create: skill_id already registered in another workspace is CONFLICT", () => {
  const fx = p2Fixture();
  const m1 = makeManifest({ author_agent: fx.author.agent_id });
  fx.registry.createVersion(fx.author, { slug: "clash", archive: buildPackage(m1).tar });
  const m2 = makeManifest({ author_agent: fx.outsider.agent_id, skill_id: m1.skill_id });
  const r = codeOf(() => fx.registry.createVersion(fx.outsider, { slug: "clash-b", archive: buildPackage(m2).tar }));
  assert.equal(r.code, "CONFLICT");
  assert.equal(r.current_state, "draft");
  fx.db.close();
});

test("create: access_policy drift on a later version is CONFLICT carrying the registered policy", () => {
  const fx = p2Fixture();
  const m1 = makeManifest({ author_agent: fx.author.agent_id, access_policy: "workspace" });
  const created = fx.registry.createVersion(fx.author, { slug: "policy-drift", archive: buildPackage(m1).tar }).response;
  const m2 = makeManifest({
    author_agent: fx.author.agent_id,
    skill_id: created.skill_id,
    semantic_version: "1.1.0",
    access_policy: "public",
  });
  const r = codeOf(() => fx.registry.createVersion(fx.author, { slug: "policy-drift", archive: buildPackage(m2).tar }));
  assert.equal(r.code, "CONFLICT");
  assert.equal(r.current_state, "workspace");
  fx.db.close();
});

test("create: idempotency_key duplicate replays byte-identically and runs no side effect", () => {
  const fx = p2Fixture();
  const m = makeManifest({ author_agent: fx.author.agent_id });
  const { tar } = buildPackage(m);
  const r1 = fx.registry.createVersion(fx.author, { slug: "idem-key", archive: tar }, "create-1");
  // second call: DIFFERENT payload, same key → stored response replayed as-is
  const other = makeManifest({ author_agent: fx.author.agent_id });
  const r2 = fx.registry.createVersion(fx.author, { slug: "idem-key-other", archive: buildPackage(other).tar }, "create-1");
  assert.equal(r2.replayed, true);
  assert.equal(r2.responseJson, r1.responseJson, "byte-identical replay");
  const skills = fx.db.prepare("SELECT COUNT(*) AS c FROM skills WHERE slug LIKE 'idem-key%'").get() as { c: number };
  assert.equal(skills.c, 1, "the second payload was never executed");
  fx.db.close();
});

// ---------------------------------------------------------- surface 2: lint

test("lint: clean draft passes all 8 gates, transitions to linted, writes one report per gate", () => {
  const fx = p2Fixture();
  const { versionId } = createInState(fx, "lint-ok", "draft");
  const out = fx.registry.lintVersion(fx.author, versionId).response;
  assert.equal(out.state, "linted");
  assert.equal(out.noop, undefined);
  const GATES = ["schema", "secrets", "pinning", "urls", "shell", "injection", "staleness", "compat"];
  assert.deepEqual(out.reports.map((r) => r.gate), GATES, "all §7.1 gates ran, in order");
  for (const r of out.reports) assert.equal(r.result, "pass", r.gate);
  const rows = fx.db.prepare("SELECT gate FROM lint_reports WHERE skill_version_id=? ORDER BY id").all(versionId) as any[];
  assert.deepEqual(rows.map((r) => r.gate), GATES);
  fx.db.close();
});

test("lint: zero failure_modes draws WARN but does not block draft→linted", () => {
  const fx = p2Fixture();
  const m = makeManifest({ author_agent: fx.author.agent_id });
  m.procedure.failure_modes = [];
  const res = fx.registry.createVersion(fx.author, { slug: "warn-skill", archive: buildPackage(m).tar }).response;
  const out = fx.registry.lintVersion(fx.author, res.skill_version_id).response;
  assert.equal(out.reports[0].result, "warn");
  assert.equal(out.state, "linted", "warn is not fail — transition proceeds");
  fx.db.close();
});

test("lint: high risk without required sandbox/approvals FAILs and the version stays draft", () => {
  const fx = p2Fixture();
  const m = makeManifest({ author_agent: fx.author.agent_id });
  m.scope.risk_level = "high"; // sandbox_requirement stays 'none', approvals []
  const res = fx.registry.createVersion(fx.author, { slug: "high-risk", archive: buildPackage(m).tar }).response;
  const out = fx.registry.lintVersion(fx.author, res.skill_version_id).response;
  assert.equal(out.reports[0].result, "fail");
  assert.match(out.reports[0].details ?? "", /sandbox_requirement/);
  assert.equal(out.state, "draft");
  const row = fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(res.skill_version_id) as any;
  assert.equal(row.state, "draft");
  fx.db.close();
});

test("lint: re-lint of a linted version converges (noop:true, no error loop — defect #1)", () => {
  const fx = p2Fixture();
  const { versionId } = createInState(fx, "relint", "draft");
  fx.registry.lintVersion(fx.author, versionId);
  const out = fx.registry.lintVersion(fx.author, versionId).response;
  assert.equal(out.noop, true);
  assert.equal(out.state, "linted");
  // reports are INSERT-only history: the re-run appended a second full set
  const rows = fx.db.prepare("SELECT COUNT(*) AS c FROM lint_reports WHERE skill_version_id=?").get(versionId) as any;
  assert.equal(rows.c, 16, "8 gates × 2 runs");
  fx.db.close();
});

test("lint: a version past linted converges on its current state", () => {
  const fx = p2Fixture();
  const { versionId } = createInState(fx, "lint-late", "reviewed");
  const out = fx.registry.lintVersion(fx.author, versionId).response;
  assert.equal(out.noop, true);
  assert.equal(out.state, "reviewed");
  fx.db.close();
});

test("lint ACL: unrelated member FORBIDDEN; cross-workspace NOT_FOUND; ws owner allowed", () => {
  const fx = p2Fixture();
  const { versionId } = createInState(fx, "lint-acl", "draft");
  assert.equal(codeOf(() => fx.registry.lintVersion(fx.member, versionId)).code, "FORBIDDEN");
  assert.equal(codeOf(() => fx.registry.lintVersion(fx.outsider, versionId)).code, "NOT_FOUND");
  const out = fx.registry.lintVersion(fx.owner, versionId).response;
  assert.equal(out.state, "linted");
  fx.db.close();
});

test("lint: unknown version id is NOT_FOUND", () => {
  const fx = p2Fixture();
  assert.equal(codeOf(() => fx.registry.lintVersion(fx.author, ulid(NOW))).code, "NOT_FOUND");
  fx.db.close();
});

// --------------------------------------- surface 4-read: stateless §4.4 verify

test("stateless verify: full TV-01 graph verifies valid; empty registry yields UNKNOWN_KEY", () => {
  const { db } = tvRegistry();
  const registry = new Registry(db, { now: () => NOW });
  const anyone = { agent_id: "x", workspace_id: "y", role: null, tool_profile: null, api_key_id: "k" } as const;
  const out = registry.verifyStateless(anyone, writeTar(tv01Package()));
  assert.equal(out.verdict, "valid");
  db.close();

  const fx = p2Fixture();
  const out2 = fx.registry.verifyStateless(fx.member, writeTar(tv01Package()));
  assert.equal(out2.verdict, "UNKNOWN_KEY", "tv kid is not registered in this instance");
  fx.db.close();
});

test("stateless verify: malformed archive is a typed MALFORMED_ARCHIVE error, not a crash", () => {
  const fx = p2Fixture();
  assert.equal(codeOf(() => fx.registry.verifyStateless(fx.member, Buffer.from("junk"))).code, "MALFORMED_ARCHIVE");
  fx.db.close();
});

test("lint: authenticated author with no workspace membership is FORBIDDEN (verdict 1 major #1)", () => {
  const fx = p2Fixture();
  const { versionId } = createInState(fx, "lint-noroles", "draft");
  const membershipless = ctxFor(fx.seed, fx.author.agent_id, fx.author.workspace_id, null);
  assert.equal(codeOf(() => fx.registry.lintVersion(membershipless, versionId)).code, "FORBIDDEN");
  const row = fx.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(versionId) as any;
  assert.equal(row.state, "draft");
  fx.db.close();
});

test("search: non-string filter params are INVALID_SCHEMA, not a crash (verdict 1 major #2)", () => {
  const fx = p2Fixture();
  for (const params of [{ q: 42 }, { capability: {} }, { state: 7 }, { cursor: [] }, { limit: true }] as const) {
    assert.equal(codeOf(() => fx.registry.search(fx.member, params as any)).code, "INVALID_SCHEMA");
  }
  fx.db.close();
});
