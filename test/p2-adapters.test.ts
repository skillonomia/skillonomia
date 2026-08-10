// P2 adapters: Appendix H REST routes + MCP tool dispatch over one service.
// The §6 mandatory negative tests run through BOTH adapters here, on the real
// auth path (minted keys → AuthContext → per-key rate limit).
import { test } from "node:test";
import assert from "node:assert/strict";
import { seedGraph, type Seed } from "./helpers.ts";
import { makeManifest, buildPackage, NOW } from "./p2-helpers.ts";
import { tv01Package } from "./vectors-helpers.ts";
import { writeTar } from "../src/archive.ts";
import { openMigrated } from "../src/db.ts";
import { Registry } from "../src/service.ts";
import { mintApiKey } from "../src/auth.ts";
import { handleRest, type RestResponse } from "../src/http.ts";
import type { RateLimitOptions } from "../src/ratelimit.ts";

interface RestFixture {
  seed: Seed;
  registry: Registry;
  keys: { author: string; owner: string; member: string; outsider: string };
}

function restFixture(rateLimit?: RateLimitOptions): RestFixture {
  const seed = seedGraph();
  const registry = new Registry(seed.db, { now: () => NOW, rateLimit });
  return {
    seed,
    registry,
    keys: {
      author: mintApiKey(seed.db, seed.authorA, NOW).api_key,
      owner: mintApiKey(seed.db, seed.ownerA, NOW).api_key,
      member: mintApiKey(seed.db, seed.adopterA, NOW).api_key,
      outsider: mintApiKey(seed.db, seed.adopterB, NOW).api_key,
    },
  };
}

function call(fx: RestFixture, method: string, url: string, key: string | null, body?: unknown): RestResponse {
  return handleRest(fx.registry, {
    method,
    url,
    headers: key === null ? {} : { authorization: `Bearer ${key}` },
    body: body === undefined ? Buffer.alloc(0) : Buffer.from(JSON.stringify(body), "utf8"),
  });
}

function parsed(res: RestResponse): any {
  return JSON.parse(res.body);
}

function packageFor(agentId: string, overrides: Record<string, unknown> = {}): { b64: string; manifest: any } {
  const manifest = makeManifest({ author_agent: agentId, ...overrides });
  const { tar } = buildPackage(manifest);
  return { b64: tar.toString("base64"), manifest };
}

// -------------------------------------------------------------------- REST

test("REST: missing or invalid Bearer key is 401 UNAUTHORIZED", () => {
  const fx = restFixture();
  assert.equal(call(fx, "GET", "/v1/skills", null).status, 401);
  const res = call(fx, "GET", "/v1/skills", "sk_bogus");
  assert.equal(res.status, 401);
  assert.equal(parsed(res).error.code, "UNAUTHORIZED");
  fx.seed.db.close();
});

test("REST: POST /v1/skills creates and returns 201 {skill_id, skill_version_id, state:'draft'}", () => {
  const fx = restFixture();
  const { b64, manifest } = packageFor(fx.seed.authorA);
  const res = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "rest-skill", archive: b64 });
  assert.equal(res.status, 201);
  const body = parsed(res);
  assert.equal(body.skill_id, manifest.skill_id);
  assert.equal(body.state, "draft");
  assert.ok(body.skill_version_id);
  fx.seed.db.close();
});

test("REST attack: payload author_agent impersonation is 403 FORBIDDEN (defect #2)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.ownerA); // signed as someone else
  const res = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "imp-rest", archive: b64 });
  assert.equal(res.status, 403);
  assert.equal(parsed(res).error.code, "FORBIDDEN");
  fx.seed.db.close();
});

test("REST attack: payload identity fields cannot escalate — actor stays the key's agent (defect #3)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  // junk identity fields ride along in the body; they must change nothing
  const res = call(fx, "POST", "/v1/skills", fx.keys.author, {
    slug: "escalate-rest",
    archive: b64,
    agent_id: fx.seed.ownerA,
    role: "owner",
    owner_agent_id: fx.seed.ownerA,
  });
  assert.equal(res.status, 201);
  const skill = fx.seed.db
    .prepare("SELECT owner_agent_id FROM skills WHERE id=?")
    .get(parsed(res).skill_id) as { owner_agent_id: string };
  assert.equal(skill.owner_agent_id, fx.seed.authorA, "owner = authenticated actor, payload ignored");

  // and on lint: a member cannot act as the author by naming them in the body
  const versionId = parsed(res).skill_version_id;
  const lint = call(fx, "POST", `/v1/versions/${versionId}/lint`, fx.keys.member, { agent_id: fx.seed.authorA });
  assert.equal(lint.status, 403);
  fx.seed.db.close();
});

test("REST: idempotency_key duplicate returns byte-identical body + Idempotency-Replayed header", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const first = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "idem-rest", archive: b64, idempotency_key: "r1" });
  assert.equal(first.status, 201);
  assert.equal(first.headers["Idempotency-Replayed"], undefined);
  const second = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "idem-rest", archive: b64, idempotency_key: "r1" });
  assert.equal(second.body, first.body, "byte-identical replay (Appendix H)");
  assert.equal(second.headers["Idempotency-Replayed"], "true");
  const versions = fx.seed.db.prepare("SELECT COUNT(*) AS c FROM skill_versions").get() as { c: number };
  assert.equal(versions.c, 2, "seed version + exactly one created");
  fx.seed.db.close();
});

test("REST: version conflict is 409 with current_state in the envelope (converging, defect #1)", () => {
  const fx = restFixture();
  const { b64, manifest } = packageFor(fx.seed.authorA);
  call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "conf-rest", archive: b64 });
  const changed = JSON.parse(JSON.stringify(manifest));
  changed.title = "Different content";
  delete changed.integrity;
  const res = call(fx, "POST", "/v1/skills", fx.keys.author, {
    slug: "conf-rest",
    archive: buildPackage(changed).tar.toString("base64"),
  });
  assert.equal(res.status, 409);
  const err = parsed(res).error;
  assert.equal(err.code, "CONFLICT");
  assert.equal(err.current_state, "draft");
  fx.seed.db.close();
});

test("REST: lint transitions then converges; POST /v1/skills/{id}/versions adds a version", () => {
  const fx = restFixture();
  const { b64, manifest } = packageFor(fx.seed.authorA);
  const created = parsed(call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "flow-rest", archive: b64 }));

  const lint1 = call(fx, "POST", `/v1/versions/${created.skill_version_id}/lint`, fx.keys.author, {});
  assert.equal(lint1.status, 200);
  assert.equal(parsed(lint1).state, "linted");
  const lint2 = call(fx, "POST", `/v1/versions/${created.skill_version_id}/lint`, fx.keys.author, {});
  assert.equal(parsed(lint2).noop, true, "re-lint converges, no error loop");

  const v2 = makeManifest({ author_agent: fx.seed.authorA, skill_id: manifest.skill_id, semantic_version: "1.1.0" });
  const res2 = call(fx, "POST", `/v1/skills/${created.skill_id}/versions`, fx.keys.author, {
    archive: buildPackage(v2).tar.toString("base64"),
  });
  assert.equal(res2.status, 201);
  assert.equal(parsed(res2).skill_id, created.skill_id);
  fx.seed.db.close();
});

test("REST: POST /v1/verify returns a §4.4 verdict (200), archive errors are typed 4xx", () => {
  const fx = restFixture();
  const res = call(fx, "POST", "/v1/verify", fx.keys.member, {
    archive: writeTar(tv01Package()).toString("base64"),
  });
  assert.equal(res.status, 200);
  assert.equal(parsed(res).verdict, "UNKNOWN_KEY", "tv kid unregistered in this instance");

  const bad = call(fx, "POST", "/v1/verify", fx.keys.member, { archive: Buffer.from("junk").toString("base64") });
  assert.equal(bad.status, 400);
  assert.equal(parsed(bad).error.code, "MALFORMED_ARCHIVE");
  fx.seed.db.close();
});

test("REST attack: cross-workspace search never shows a non-published version", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA, { access_policy: "public" });
  const created = parsed(call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "leak-rest", archive: b64 }));
  fx.seed.db.prepare("UPDATE skill_versions SET state='reviewed' WHERE id=?").run(created.skill_version_id);

  const out = parsed(call(fx, "GET", "/v1/skills", fx.keys.outsider));
  assert.equal(out.items.length, 0, "reviewed (even public policy) must not cross the workspace boundary");

  fx.seed.db.prepare("UPDATE skill_versions SET state='published' WHERE id=?").run(created.skill_version_id);
  const out2 = parsed(call(fx, "GET", "/v1/skills", fx.keys.outsider));
  assert.deepEqual(out2.items.map((i: any) => i.slug), ["leak-rest"]);
  fx.seed.db.close();
});

test("REST: per-key rate limit yields 429 RATE_LIMITED; another key is unaffected", () => {
  const fx = restFixture({ capacity: 2, refillPerSec: 0 });
  assert.equal(call(fx, "GET", "/v1/skills", fx.keys.member).status, 200);
  assert.equal(call(fx, "GET", "/v1/skills", fx.keys.member).status, 200);
  const limited = call(fx, "GET", "/v1/skills", fx.keys.member);
  assert.equal(limited.status, 429);
  assert.equal(parsed(limited).error.code, "RATE_LIMITED");
  assert.equal(call(fx, "GET", "/v1/skills", fx.keys.outsider).status, 200);
  fx.seed.db.close();
});

test("REST: unknown route is a 404 envelope", () => {
  const fx = restFixture();
  const res = call(fx, "POST", "/v1/nope", fx.keys.member, {});
  assert.equal(res.status, 404);
  assert.equal(parsed(res).error.code, "NOT_FOUND");
  fx.seed.db.close();
});

test("REST bootstrap flow (§9.1): exchange once, use the owner key, replay fails 401", () => {
  const db = openMigrated();
  const registry = new Registry(db, { now: () => NOW });
  const boot = registry.bootstrap()!;
  const fxLike = { registry } as RestFixture;

  const ex = call(fxLike, "POST", "/v1/auth/bootstrap", null, { bootstrap_token: boot.bootstrap_owner_token });
  assert.equal(ex.status, 200);
  const owner = parsed(ex);
  assert.match(owner.api_key, /^sk_own_/);
  assert.equal(owner.role, "owner");

  assert.equal(call(fxLike, "GET", "/v1/skills", owner.api_key).status, 200);
  assert.equal(call(fxLike, "GET", "/v1/skills", boot.demo_adopter_token).status, 200, "demo adopter key works");

  const replay = call(fxLike, "POST", "/v1/auth/bootstrap", null, { bootstrap_token: boot.bootstrap_owner_token });
  assert.equal(replay.status, 401);
  db.close();
});

// --------------------------------------------------------------------- MCP

function mcpCall(fx: RestFixture, key: string, method: string, params?: unknown): any {
  const res = call(fx, "POST", "/mcp", key, { jsonrpc: "2.0", id: 1, method, params });
  assert.equal(res.status, 200);
  return parsed(res);
}

function toolResult(rpc: any): { data: any; isError: boolean; raw: string; meta?: any } {
  const text = rpc.result.content[0].text as string;
  return { data: JSON.parse(text), isError: rpc.result.isError, raw: text, meta: rpc.result._meta };
}

test("MCP: initialize + tools/list expose exactly the implemented surfaces", () => {
  const fx = restFixture();
  const init = mcpCall(fx, fx.keys.member, "initialize", {});
  assert.equal(init.result.serverInfo.name, "skillonomia");
  const tools = mcpCall(fx, fx.keys.member, "tools/list");
  assert.deepEqual(
    tools.result.tools.map((t: any) => t.name),
    [
      // P2: surfaces 1, 2, 4-read, 5
      "skill.create",
      "skill.lint",
      "skill.verify",
      "skill.search",
      // P4: surfaces 3, 10, 11 + the §7.3 approval auxiliary
      "skill.review.request",
      // surface 12: the §5.1 `verified → published` step + §4.3.8 countersign
      "skill.publish",
      "skill.supersede",
      // surface 13: the `published → deprecated` tail of §5.1
      "skill.deprecate",
      "skill.revoke",
      "skill.approve",
      // P5: surfaces 6, 7, 8, 9
      "skill.request_adoption",
      "skill.adopt",
      "skill.validate_outcome",
      "skill.rate",
      // provisioning auxiliaries (Appendix H): principals, their API keys and
      // the signing keys §4.4 step 3 resolves a package's kid against
      "principal.create",
      "principal.list",
      "principal.issue_api_key",
      "principal.revoke_api_key",
      "signing_key.register",
      "signing_key.list",
      "signing_key.revoke",
      // auxiliary (Appendix H): the public transparency-log read
      "tlog.read",
      // auxiliary (Appendix H): the per-skill migration counter — a READ, and
      // separate from every tool that appends a receipt event
      "migration.count",
      // P6 auxiliary: the dashboard views (not one of the 11)
      "dashboard.view",
    ],
    "every Appendix H surface is advertised exactly once",
  );
  fx.seed.db.close();
});

test("MCP requires transport auth exactly like REST", () => {
  const fx = restFixture();
  const res = call(fx, "POST", "/mcp", null, { jsonrpc: "2.0", id: 1, method: "tools/list" });
  assert.equal(res.status, 401);
  fx.seed.db.close();
});

test("MCP attack: author_agent impersonation rejected with the same FORBIDDEN envelope (defect #2)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.ownerA);
  const rpc = mcpCall(fx, fx.keys.author, "tools/call", {
    name: "skill.create",
    arguments: { slug: "imp-mcp", archive_base64: b64 },
  });
  const out = toolResult(rpc);
  assert.equal(out.isError, true);
  assert.equal(out.data.error.code, "FORBIDDEN");
  fx.seed.db.close();
});

test("MCP: create → lint → search round trip on the same service", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA, { access_policy: "workspace" });
  const created = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.create", arguments: { slug: "mcp-skill", archive_base64: b64 } }),
  );
  assert.equal(created.isError, false);
  assert.equal(created.data.state, "draft");

  const linted = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", {
      name: "skill.lint",
      arguments: { skill_version_id: created.data.skill_version_id },
    }),
  );
  assert.equal(linted.data.state, "linted");

  const found = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.search", arguments: { q: "mcp-skill" } }),
  );
  assert.equal(found.data.items.length, 1);
  assert.equal(found.data.items[0].state, "linted");
  fx.seed.db.close();
});

test("MCP: linted version is NOT member-visible (§5.1 draft/linted row)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA, { access_policy: "workspace" });
  const created = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.create", arguments: { slug: "mcp-vis", archive_base64: b64 } }),
  );
  toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.lint", arguments: { skill_version_id: created.data.skill_version_id } }),
  );
  const asMember = toolResult(
    mcpCall(fx, fx.keys.member, "tools/call", { name: "skill.search", arguments: { q: "mcp-vis" } }),
  );
  assert.equal(asMember.data.items.length, 0);
  const asAuthor = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.search", arguments: { q: "mcp-vis" } }),
  );
  assert.equal(asAuthor.data.items.length, 1);
  fx.seed.db.close();
});

test("MCP: idempotent replay returns the identical tool-result bytes", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const args = { name: "skill.create", arguments: { slug: "mcp-idem", archive_base64: b64, idempotency_key: "m1" } };
  const first = toolResult(mcpCall(fx, fx.keys.author, "tools/call", args));
  const second = toolResult(mcpCall(fx, fx.keys.author, "tools/call", args));
  assert.equal(second.raw, first.raw, "byte-identical replay");
  assert.equal(second.meta?.["skillonomia/idempotency-replayed"], true);
  fx.seed.db.close();
});

test("MCP: unknown tool and unknown method are typed failures", () => {
  const fx = restFixture();
  const rpc = mcpCall(fx, fx.keys.member, "tools/call", { name: "skill.nuke", arguments: {} });
  const out = toolResult(rpc);
  assert.equal(out.isError, true);
  assert.equal(out.data.error.code, "NOT_FOUND");
  const bad = mcpCall(fx, fx.keys.member, "no/such/method");
  assert.equal(bad.error.code, -32601);
  fx.seed.db.close();
});

// ------------------------- verdict 1 findings — regression coverage (fix r1)

test("REST: lint without workspace membership is FORBIDDEN even for the author (verdict 1 major #1)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const created = parsed(call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "no-member", archive: b64 }));
  // strip the author's membership AFTER creating; the key still authenticates
  fx.seed.db.prepare("DELETE FROM workspace_memberships WHERE agent_id=?").run(fx.seed.authorA);
  const res = call(fx, "POST", `/v1/versions/${created.skill_version_id}/lint`, fx.keys.author, {});
  assert.equal(res.status, 403);
  assert.equal(parsed(res).error.code, "FORBIDDEN");
  const row = fx.seed.db.prepare("SELECT state FROM skill_versions WHERE id=?").get(created.skill_version_id) as any;
  assert.equal(row.state, "draft", "no transition happened");
  fx.seed.db.close();
});

test("REST: non-string slug and idempotency_key are INVALID_SCHEMA, never coerced (verdict 1 major #2)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const before = (fx.seed.db.prepare("SELECT COUNT(*) AS c FROM skill_versions").get() as any).c;
  // regression-sensitive: String(["arr-slug-ok"]) === "arr-slug-ok" is a VALID
  // slug, so the pre-fix coercion would have created the skill (verdict 2 minor)
  const badSlug = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: ["arr-slug-ok"], archive: b64 });
  assert.equal(badSlug.status, 400);
  assert.equal(parsed(badSlug).error.code, "INVALID_SCHEMA");
  const coerced = fx.seed.db.prepare("SELECT COUNT(*) AS c FROM skills WHERE slug='arr-slug-ok'").get() as any;
  assert.equal(coerced.c, 0, "the coerced-valid slug was never created");
  const badKey = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "ok-slug", archive: b64, idempotency_key: 42 });
  assert.equal(badKey.status, 400);
  assert.equal(parsed(badKey).error.code, "INVALID_SCHEMA");
  const after = (fx.seed.db.prepare("SELECT COUNT(*) AS c FROM skill_versions").get() as any).c;
  assert.equal(after, before, "no mutation side effect from rejected inputs");
  fx.seed.db.close();
});

test("REST: convergent identical create replies 201 like the original (verdict 1 minor)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const first = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "conv-201", archive: b64 });
  assert.equal(first.status, 201);
  const second = call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "conv-201", archive: b64 });
  assert.equal(second.status, 201, "Appendix H fixes 201 for skill.create; convergence does not change it");
  assert.equal(parsed(second).noop, true);
  fx.seed.db.close();
});

test("REST: impersonation on the versions form is FORBIDDEN too (verdict 1 major #3)", () => {
  const fx = restFixture();
  const { b64, manifest } = packageFor(fx.seed.authorA);
  const created = parsed(call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "ver-imp", archive: b64 }));
  // second version signed under the OWNER's identity, posted with the author's key
  const v2 = makeManifest({ author_agent: fx.seed.ownerA, skill_id: manifest.skill_id, semantic_version: "1.1.0" });
  const res = call(fx, "POST", `/v1/skills/${created.skill_id}/versions`, fx.keys.author, {
    archive: buildPackage(v2).tar.toString("base64"),
  });
  assert.equal(res.status, 403);
  assert.equal(parsed(res).error.code, "FORBIDDEN");
  fx.seed.db.close();
});

test("cross-workspace lint is NOT_FOUND through BOTH adapters (verdict 1 major #3)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const created = parsed(call(fx, "POST", "/v1/skills", fx.keys.author, { slug: "xws-lint", archive: b64 }));
  const rest = call(fx, "POST", `/v1/versions/${created.skill_version_id}/lint`, fx.keys.outsider, {});
  assert.equal(rest.status, 404);
  assert.equal(parsed(rest).error.code, "NOT_FOUND");
  const mcp = toolResult(
    mcpCall(fx, fx.keys.outsider, "tools/call", {
      name: "skill.lint",
      arguments: { skill_version_id: created.skill_version_id },
    }),
  );
  assert.equal(mcp.isError, true);
  assert.equal(mcp.data.error.code, "NOT_FOUND");
  fx.seed.db.close();
});

test("MCP attack: payload identity fields cannot escalate — owner stays the actor (verdict 1 major #3)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA);
  const rpc = mcpCall(fx, fx.keys.author, "tools/call", {
    name: "skill.create",
    arguments: {
      slug: "mcp-escalate",
      archive_base64: b64,
      agent_id: fx.seed.ownerA,
      role: "owner",
      owner_agent_id: fx.seed.ownerA,
    },
  });
  const out = toolResult(rpc);
  assert.equal(out.isError, false);
  const skill = fx.seed.db
    .prepare("SELECT owner_agent_id FROM skills WHERE id=?")
    .get(out.data.skill_id) as { owner_agent_id: string };
  assert.equal(skill.owner_agent_id, fx.seed.authorA, "owner = authenticated actor; junk identity args ignored");
  fx.seed.db.close();
});

test("MCP attack: cross-workspace search never shows a non-published version (verdict 1 major #3)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA, { access_policy: "public" });
  const created = toolResult(
    mcpCall(fx, fx.keys.author, "tools/call", { name: "skill.create", arguments: { slug: "mcp-leak", archive_base64: b64 } }),
  );
  fx.seed.db.prepare("UPDATE skill_versions SET state='reviewed' WHERE id=?").run(created.data.skill_version_id);
  const hidden = toolResult(
    mcpCall(fx, fx.keys.outsider, "tools/call", { name: "skill.search", arguments: { q: "mcp-leak" } }),
  );
  assert.equal(hidden.data.items.length, 0, "reviewed (even public policy) must not cross the workspace boundary");
  fx.seed.db.prepare("UPDATE skill_versions SET state='published' WHERE id=?").run(created.data.skill_version_id);
  const visible = toolResult(
    mcpCall(fx, fx.keys.outsider, "tools/call", { name: "skill.search", arguments: { q: "mcp-leak" } }),
  );
  assert.equal(visible.data.items.length, 1);
  fx.seed.db.close();
});

test("MCP: malformed arguments yield INVALID_SCHEMA envelopes, never HTTP 500 (verdict 1 major #2)", () => {
  const fx = restFixture();
  const { b64 } = packageFor(fx.seed.authorA); // valid archive so the type check is what rejects
  // Each case is regression-sensitive: against the pre-fix behaviour it either
  // mutated (coerced-valid slug), returned a DIFFERENT typed code (skill_id 42
  // → NOT_FOUND, lint idempotency_key 42 → NOT_FOUND after coercion to "42"),
  // or escaped the error model entirely (q/cursor 42 → uncaught TypeError).
  const cases: Array<{ name: string; arguments: any }> = [
    { name: "skill.search", arguments: { q: 42 } },
    { name: "skill.create", arguments: { slug: ["arr-slug-mcp"], archive_base64: b64 } },
    { name: "skill.create", arguments: { skill_id: 42, archive_base64: b64 } },
    { name: "skill.lint", arguments: { skill_version_id: "x", idempotency_key: 42 } },
  ];
  for (const params of cases) {
    // author key: the archive's author matches, so the TYPE check is what rejects
    const rpc = mcpCall(fx, fx.keys.author, "tools/call", params);
    const out = toolResult(rpc);
    assert.equal(out.isError, true, JSON.stringify(params));
    assert.equal(out.data.error.code, "INVALID_SCHEMA", JSON.stringify(params));
  }
  const coerced = fx.seed.db.prepare("SELECT COUNT(*) AS c FROM skills WHERE slug='arr-slug-mcp'").get() as any;
  assert.equal(coerced.c, 0, "the coerced-valid slug was never created");
  fx.seed.db.close();
});

test("MCP: a non-object arguments container is INVALID_SCHEMA, not empty filters (verdict 2 major)", () => {
  const fx = restFixture();
  for (const args of [42, "x", [], null]) {
    for (const name of ["skill.search", "skill.create", "skill.lint", "skill.verify"]) {
      const rpc = mcpCall(fx, fx.keys.member, "tools/call", { name, arguments: args });
      const out = toolResult(rpc);
      assert.equal(out.isError, true, `${name} args=${JSON.stringify(args)}`);
      assert.equal(out.data.error.code, "INVALID_SCHEMA", `${name} args=${JSON.stringify(args)}`);
      // regression sensitivity (verdict 3 minor): the CONTAINER check must be
      // what rejected — the per-field messages ("archive_base64 … required",
      // "skill_version_id … required") that a search-only fix would produce
      // share the code but not this message
      assert.match(out.data.error.message, /arguments must be an object/, `${name} args=${JSON.stringify(args)}`);
    }
  }
  // an ABSENT arguments member still means "no arguments" for search
  const rpc = mcpCall(fx, fx.keys.member, "tools/call", { name: "skill.search" });
  const out = toolResult(rpc);
  assert.equal(out.isError, false);
  assert.ok(Array.isArray(out.data.items));
  fx.seed.db.close();
});
